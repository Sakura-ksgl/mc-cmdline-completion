import * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapter/registry';
import type { CompletionContext, SymbolCategory, SymbolInfo } from '../adapter/types';
import { fuzzyMatch } from './matcher';
import { buildPool, type PoolCandidate } from './pool';
import { isMemberAccessContext, sliceSegment } from './segment';

/** 符号类别 → 图标。纯展示映射，不含任何语言信息。 */
const CATEGORY_KIND: Record<SymbolCategory, vscode.CompletionItemKind> = {
  function: vscode.CompletionItemKind.Function,
  method: vscode.CompletionItemKind.Method,
  class: vscode.CompletionItemKind.Class,
  variable: vscode.CompletionItemKind.Variable,
  constant: vscode.CompletionItemKind.Constant,
  field: vscode.CompletionItemKind.Field,
  keyword: vscode.CompletionItemKind.Keyword,
  // VSCode 没有「宏」这个 kind，用常量图标最贴切
  macro: vscode.CompletionItemKind.Constant,
  namespace: vscode.CompletionItemKind.Module,
  other: vscode.CompletionItemKind.Text,
};

/** 字面量的图标 */
const LITERAL_KIND = vscode.CompletionItemKind.Value;

/** 带匹配分数的候选 */
interface RankedCandidate {
  candidate: PoolCandidate;
  score: number;
}

/**
 * 通用补全 provider —— 补全引擎层的出口。
 *
 * 链路固定为五步，顺序不要改：
 *   ① 解析调度：按适配器声明的策略切段
 *   ② 组装只读上下文
 *   ③ 合并候选：符号 + 字面量
 *   ④ 模糊过滤 + 排序（通用层唯一一份匹配函数）
 *   ⑤ 输出
 *
 * 这一层不认识任何语言，也没有任何语言分支。
 */
export class CommandLineCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly registry: AdapterRegistry,
    /** 是否处于扩展开发模式（F5 起的 Extension Development Host）。开发模式下诊断日志强制打开。 */
    private readonly isDevelopment: boolean,
  ) {}

  /**
   * 诊断日志开关。满足任一条即打开：
   *  - 处于扩展开发模式（F5）
   *  - 用户把配置 `mcSuggest.debugLog` 设成 true
   *
   * 默认关闭，避免日常使用时把开发者工具 Console 刷屏。
   * 注意：**异常上报不走这个开关**，永远打（见下面 catch 里那两条 console.error）。
   */
  private isDebugLogEnabled(): boolean {
    if (this.isDevelopment) {
      return true;
    }
    return vscode.workspace.getConfiguration('mcSuggest').get<boolean>('debugLog', false);
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.CompletionList | undefined {
    const adapter = this.registry.resolve(document);
    if (!adapter) {
      // 没有任何适配器认得这个语言：不贡献候选，把场面留给其它扩展。
      return undefined;
    }

    // ① 解析调度
    const strategy = adapter.getSegmentStrategy();
    const slice = sliceSegment(document.lineAt(position.line).text, position.character, strategy);

    // ② 只读上下文：适配器只能读、不能改
    const segmentRange = new vscode.Range(position.line, slice.start, position.line, slice.end);
    const completionContext: CompletionContext = {
      document,
      position,
      segmentText: slice.text,
      segmentRange,
      previousSegments: slice.before,
      depth: slice.depth,
      delimiter: slice.delimiter,
      argumentIndex: slice.argumentIndex,
    };

    // ③ 合并候选（scanSymbols 需要 context：成员访问场景要靠它才知道类型）
    //
    // 异常在这里被记录并打印堆栈，然后按「这批符号为空」继续往下走：
    // 分支逻辑不受影响，而且异常路径原本就是 VSCode 静默丢弃结果。
    // 这两条 console.error 不打诊断开关，出了问题必须看得见。
    let symbols: SymbolInfo[] = [];
    try {
      symbols = adapter.scanSymbols(document, completionContext);
    } catch (error) {
      console.error('[mc-cmdline] scanSymbols 抛异常：', error);
      console.error(
        '[mc-cmdline] 异常堆栈：',
        error instanceof Error ? error.stack : '(捕获到的不是 Error 对象)',
      );
    }
    // 成员访问语境下不合并字面量：那个位置允许的是「成员」，不是「值」。
    // 不这么收窄的话，推不出成员时会退化成弹字面量
    // （C 的嵌套 struct 弹 NULL/EOF、Python 的 name. 混进 True/False/None）
    const literals = isMemberAccessContext(slice.delimiter, strategy)
      ? []
      : adapter.getLiterals(completionContext);
    const pool = buildPool(symbols, literals);

    // ④ 模糊过滤 + 排序
    const ranked = rank(pool, slice.text);
    if (token.isCancellationRequested) {
      return undefined;
    }

    // ⑤ 输出
    const debug = this.isDebugLogEnabled();
    const items = ranked.map((entry) => toCompletionItem(entry, segmentRange, debug));

    if (debug) {
      // 这条是关键：VSCode 的 wordPattern 认为光标处的「词」是什么。
      // 如果它把 `name.` 整体当成词，过滤时就会拿 `name.` 去匹配 upper/True，全部失败。
      const wordRange = document.getWordRangeAtPosition(position);
      console.log(
        '[mc-cmdline] 文件 =',
        document.fileName,
        '| 语言 =',
        document.languageId,
        '| 适配器 =',
        adapter.name,
        '| 光标 =',
        `${position.line + 1}:${position.character}`,
        '| 当前段文本 =',
        JSON.stringify(slice.text),
        '| 触发分隔符 =',
        slice.delimiter ?? '(无)',
        '| 段范围 = [',
        `${slice.start},${slice.end})`,
      );
      console.log(
        '[mc-cmdline] 条数：scanSymbols =',
        symbols.length,
        '| getLiterals =',
        literals.length,
        '| 合并后 =',
        pool.length,
        '| 模糊过滤后 =',
        ranked.length,
        '| 最终候选 =',
        items.length,
      );
      console.log(
        '[mc-cmdline] VSCode 认为的当前词 =',
        wordRange === undefined ? '(空)' : JSON.stringify(document.getText(wordRange)),
        '| 词范围 =',
        wordRange?.toString() ?? '(无)',
      );
    }

    return new vscode.CompletionList(items, false);
  }
}

/** 用通用匹配函数过滤 + 排序：不匹配的候选直接丢掉。 */
function rank(pool: readonly PoolCandidate[], pattern: string): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const candidate of pool) {
    const match = fuzzyMatch(pattern, candidate.label);
    if (!match) {
      continue;
    }
    ranked.push({ candidate, score: match.score });
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.weight - b.candidate.weight ||
      a.candidate.label.localeCompare(b.candidate.label),
  );
  return ranked;
}

function toCompletionItem(
  entry: RankedCandidate,
  range: vscode.Range,
  debug: boolean,
): vscode.CompletionItem {
  const { candidate, score } = entry;
  const kind =
    candidate.source === 'literal' ? LITERAL_KIND : CATEGORY_KIND[candidate.category ?? 'other'];

  const item = new vscode.CompletionItem(candidate.label, kind);
  item.insertText = candidate.insertText;
  item.detail = candidate.detail;

  // 替换范围 = 当前段：落定时整段被替换掉，而不是只替换光标前的一个「词」
  item.range = range;

  // 目前把过滤与命中高亮交给 VSCode 原生（filterText 就用 label）。
  // 我们自己筛出的候选，原生还会再筛一遍 —— 这个风险先留着，实测后再决定处理方式。
  item.filterText = candidate.label;

  // sortText 是字典序升序，所以用 100000 - score 把「分高者靠前」表达出来。
  // 注意：VSCode 会先按它自己的匹配分数排序，sortText 只在「原生认为同分」时生效。
  item.sortText = `${String(100000 - score).padStart(6, '0')}_${candidate.weight}_${candidate.label}`;

  if (debug) {
    // range 断言成 Range 只是为了让 TS 通过，赋进去的就是上面那个 Range。
    const debugRange = item.range as vscode.Range;
    console.log(
      '[mc-cmdline] 候选：label =',
      candidate.label,
      '| range =',
      `${debugRange.start.line}:${debugRange.start.character}~${debugRange.end.line}:${debugRange.end.character}`,
      '| kind =',
      item.kind,
      '| filterText =',
      JSON.stringify(item.filterText),
    );
  }

  return item;
}
