import type * as vscode from 'vscode';
import type { LanguageAdapter, SegmentStrategy } from './types';

/**
 * 一个适配器的装配信息。
 *
 * selector 与触发字符**必须成对出现**，不能跨适配器合并：
 * 把所有适配器的 languageId 合成一份 selector、把 delimiters 合成一份触发字符，
 * 会让某个语言的触发字符串到别的语言的文件里。
 */
export interface AdapterRegistration {
  /** 该适配器自己负责的语言选择器 */
  selectors: vscode.DocumentSelector;
  /** 该适配器自己声明的触发字符 */
  triggerCharacters: string[];
}

/**
 * 适配器注册表 —— 通用层唯一接触适配器的地方。
 *
 * 这里只按 languageId 做字符串查表、兜底和装配信息映射，不认识任何具体语言：
 * 不出现 `'python'` / `'c'` / `'java'` 之类的字面量判断，
 * 也不根据 languageId 改变任何行为分支。
 */
export class AdapterRegistry {
  private readonly adapters: LanguageAdapter[] = [];

  register(adapter: LanguageAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * 按 document 解析适配器。
   *
   * 先筛出 `languageIds` 命中的适配器，再用各自的 `claims` 过滤 ——
   * **未实现 `claims` 的视为认领**。
   *
   * 要求各适配器的认领判据**互斥**（同一个文件不会被两个适配器同时认领）：
   * 判据互斥之后，「第一个匹配赢」就只是 `find` 的实现细节，注册顺序不影响结果。
   *
   * 不再有 `'*'` 兜底 —— 硬约束 13 已禁止注册兜底适配器。
   */
  resolve(document: vscode.TextDocument): LanguageAdapter | undefined {
    const candidates = this.adapters.filter((adapter) =>
      adapter.languageIds.includes(document.languageId),
    );
    return candidates.find((adapter) => adapter.claims === undefined || adapter.claims(document));
  }

  /**
   * 装配信息：**按 languageId 分组**，每个 languageId 一条。
   *
   * ⚠️ **一个 languageId 只能注册一次 provider。** VSCode 的 selector 匹配是「凡命中的注册
   * 都调用」，同一个 languageId 被多条注册覆盖时，provider 会被调用多次，而每次
   * `resolve(document)` 都返回**同一个**适配器 → 各自产出一份相同候选 → **候选成倍**。
   * （踩过：CAdapter 声明 `['c','cpp']`、CppAdapter 也声明 `cpp`，`.cpp` 命中两条
   *  → 候选双倍；而 `.c` / `.py` 各只命中一条，所以正常。）
   *
   * 触发字符取该 languageId 下**所有适配器的并集** —— 一个 languageId 可能对应多个适配器
   * （`.h` 归 C 还是 C++ 要看内容），敲哪个分隔符能叫醒 provider 得把它们合起来。
   * 但**绝不外溢到别的语言**：`.py` 不会因为 C 声明了 `>` 而被叫醒。
   */
  registrations(): AdapterRegistration[] {
    /** languageId → 该语言下所有适配器的触发字符 */
    const triggerCharactersByLanguage = new Map<string, Set<string>>();

    for (const adapter of this.adapters) {
      const characters = triggerCharactersOf(adapter.getSegmentStrategy());
      for (const languageId of adapter.languageIds) {
        const collected = triggerCharactersByLanguage.get(languageId) ?? new Set<string>();
        for (const character of characters) {
          collected.add(character);
        }
        triggerCharactersByLanguage.set(languageId, collected);
      }
    }

    return [...triggerCharactersByLanguage].map(([languageId, characters]) => ({
      selectors: [languageId],
      triggerCharacters: [...characters],
    }));
  }

  list(): readonly LanguageAdapter[] {
    return this.adapters;
  }
}

/**
 * 把切段**分隔符**映射成 VSCode 的**触发字符**。
 *
 * 两者不是一回事：
 *  - **分隔符**（`delimiters`）可以是多字符（`->` / `::`），用于**切段**
 *  - **触发字符**（`triggerCharacters`）**只能单字符** —— 官方注释写的是
 *    「when trigger characters are being typed … only from providers that registered
 *    the typed character」，即「用户敲下的那一个字符」；多字符元素永远等不到那一刻，
 *    会被**静默忽略**（曾因此让 C 的 `->` 从阶段 5 起一直不触发，直到 C++ 的 `p->` 才暴露）
 *
 * 所以这里取每个分隔符的**末字符**：
 *  - `'->'` → `'>'`：敲下 `>` 时 `->` 已经形成，切段层会把它算成 `delimiter === '->'`
 *  - `'::'` → `':'`：敲第一个 `:` 白触发一次（无害），敲第二个才形成 `::`
 *  - 单字符分隔符原样保留
 *
 * 只取末字符而不是把 `->` 拆成 `-` 与 `>`：敲 `-` 时没必要叫醒 provider，少一个噪音源。
 *
 * 关键分工：**触发层只负责「叫醒」，「是不是成员访问」由切段层的 `delimiter` 回答** ——
 * 所以适配器不需要再判断一次「是否形成了 `->`」。
 */
function triggerCharactersOf(strategy: SegmentStrategy): string[] {
  const characters = new Set<string>();
  for (const delimiter of strategy.delimiters ?? []) {
    if (delimiter.length > 0) {
      characters.add(delimiter[delimiter.length - 1]);
    }
  }
  return [...characters];
}
