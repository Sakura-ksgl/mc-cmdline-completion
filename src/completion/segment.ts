import type { SegmentStrategy } from '../adapter/types';

/**
 * 切段结果。
 *
 * 刻意不含任何 vscode 类型：切段是纯字符串 / 偏移量运算，
 * 这样它能脱离扩展宿主单独验证（见 scripts/verify-stage2.mjs）。
 */
export interface SegmentSlice {
  /** 当前段已输入的文本（已去掉首尾空白） */
  text: string;
  /** 当前段起点（行内 0-based offset） */
  start: number;
  /** 当前段终点（行内 0-based offset，等于光标位置） */
  end: number;
  /** 当前段之前的各段，按出现顺序；分隔符自身也各算一段 */
  before: string[];
  /** 光标处的括号深度，0 表示不在任何括号内 */
  depth: number;
  /** 触发当前段的那个分隔符 */
  delimiter?: string;
  /** 第几个参数（1-based） */
  argumentIndex?: number;
}

/**
 * 参数分隔符固定为逗号。
 *
 * 只有策略把 `,` 声明为分隔符时，才算「有参数概念」——
 * 这样它是数据驱动的：适配器不给逗号，就不会有「第几个参数」。
 * 将来若有语言需要别的参数分隔符，再加字段（先问，不自己拍板）。
 */
const ARGUMENT_SEPARATOR = ',';

/**
 * 按适配器声明的策略，把「光标所在行、光标之前的部分」切段。
 *
 * 规则（阶段 2 语法驱动版）：
 *  1. `delimiters` 里的每个字符都是段边界，且**自身算一段**；
 *  2. 被分隔符隔开的非空内容各算一段（首尾空白不计入段内）；
 *  3. 当前段 = 最后一个分隔符之后、光标之前的内容（同样去掉首尾空白）；
 *  4. `pairs` 用于维护括号深度，并据此算出「第几个参数」；
 *  5. `whitespace`（空格式）阶段 2 不读。
 *
 * 纯函数：不读文件、不改任何外部状态。
 */
export function sliceSegment(
  line: string,
  cursorOffset: number,
  strategy: SegmentStrategy,
): SegmentSlice {
  // 只看光标之前的部分
  const head = line.slice(0, cursorOffset);

  // 分隔符可能有多字符项（例如 C 的 `->`）：
  // 按长度降序排列，扫描时在每个位置做「最长匹配优先」。
  const delimiters = [...new Set(strategy.delimiters ?? [])].sort((a, b) => b.length - a.length);
  const openers = new Set<string>();
  const closers = new Set<string>();
  for (const [open, close] of strategy.pairs ?? []) {
    openers.add(open);
    closers.add(close);
  }
  const countArguments = delimiters.includes(ARGUMENT_SEPARATOR);

  /** 已完成的段，按出现顺序 */
  const before: string[] = [];
  /** 未闭合的左括号栈 */
  const brackets: string[] = [];
  /** 与 brackets 同步：每个括号层内已出现过的参数分隔符个数 */
  const argumentCounts: number[] = [];

  /** 当前段的起点 */
  let segmentStart = 0;
  /** 触发当前段的分隔符 */
  let delimiter: string | undefined;

  for (let i = 0; i < head.length; ) {
    // 最长匹配优先：`->` 不会被拆成 `-` 与 `>`
    const matched = delimiters.find((candidate) => head.startsWith(candidate, i));
    if (matched === undefined) {
      i++;
      continue;
    }

    // 这个分隔符之前的内容算一段（全空白不算段）
    pushSegment(before, head.slice(segmentStart, i));

    // 分隔符自身算一段
    before.push(matched);

    // 维护括号深度与各层的参数计数
    if (openers.has(matched)) {
      brackets.push(matched);
      argumentCounts.push(0);
    } else if (closers.has(matched)) {
      brackets.pop();
      argumentCounts.pop();
    } else if (
      countArguments &&
      matched === ARGUMENT_SEPARATOR &&
      argumentCounts.length > 0
    ) {
      argumentCounts[argumentCounts.length - 1]++;
    }

    i += matched.length;
    segmentStart = i;
    delimiter = matched;
  }

  // 当前段 = 最后一个分隔符之后、光标之前的内容；首尾空白都不算段内
  const raw = head.slice(segmentStart);
  const leadingBlank = raw.length - raw.trimStart().length;
  const start = segmentStart + leadingBlank;
  let end = cursorOffset;
  while (end > start && isBlank(head[end - 1])) {
    end--;
  }

  const slice: SegmentSlice = {
    text: head.slice(start, end),
    start,
    end,
    before,
    depth: brackets.length,
  };
  if (delimiter !== undefined) {
    slice.delimiter = delimiter;
  }
  if (brackets.length > 0) {
    slice.argumentIndex = argumentCounts[argumentCounts.length - 1] + 1;
  }
  return slice;
}

/** 一段非空内容才算一段：全空白的内容不入段。 */
function pushSegment(target: string[], raw: string): void {
  const text = raw.trim();
  if (text.length > 0) {
    target.push(text);
  }
}

function isBlank(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r';
}

/**
 * 当前是不是「成员访问语境」。
 *
 * 判断**纯数据驱动**：策略声明了 `memberAccess` 且当前分隔符在其中。
 * 刻意不写成 `delimiter === '.'` —— 那是把语言知识塞进通用层
 * （C 还有 `->`，将来 C++ 还有 `::`）。
 *
 * 通用层用它收窄候选来源：成员访问语境下**不合并字面量**。
 */
export function isMemberAccessContext(
  delimiter: string | undefined,
  strategy: SegmentStrategy,
): boolean {
  if (delimiter === undefined) {
    return false;
  }
  return (strategy.memberAccess ?? []).includes(delimiter);
}
