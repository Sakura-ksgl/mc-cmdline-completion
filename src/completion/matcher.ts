/**
 * 通用模糊匹配 —— 全局唯一一份，所有语言共用，保证手感一致。
 *
 * 适配器不允许自带匹配逻辑：它们只负责「产出候选」，
 * 匹配与排序一律由补全引擎这一层做。
 */

/** 匹配结果 */
export interface FuzzyMatch {
  /** 得分，越大越靠前 */
  score: number;
  /** 命中的字符下标（相对于目标串） */
  positions: number[];
}

/**
 * 子序列模糊匹配：pattern 的每个字符必须按顺序出现在 target 里（不要求连续）。
 *
 *  - `pl`  命中 `player`、`place`（前缀，得分最高）
 *  - `pyr` 也命中 `player`（子序列，因为中间跳过了字符而得分较低）
 *  - 匹配不上返回 undefined
 *
 * 空 pattern（例如刚敲完 `(`）放行全部候选。
 */
export function fuzzyMatch(pattern: string, target: string): FuzzyMatch | undefined {
  if (pattern.length === 0) {
    return { score: 0, positions: [] };
  }
  if (pattern.length > target.length) {
    return undefined;
  }

  const positions: number[] = [];
  let score = 0;
  /** 下一个字符从目标串的哪个下标开始找 */
  let cursor = 0;
  /** 上一次命中的下标，用来判断是否连续 */
  let previous = -1;

  for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
    const wanted = pattern[patternIndex].toLowerCase();

    let found = -1;
    for (let i = cursor; i < target.length; i++) {
      if (target[i].toLowerCase() === wanted) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      // 某个字符在目标串里找不到：整体不匹配
      return undefined;
    }

    // 跳过的字符越少越好
    score -= found - cursor;
    // 连续命中加分（previous >= 0 才谈得上「连续」）
    if (previous >= 0 && previous === found - 1) {
      score += 15;
    }
    // 命中在词边界（开头、下划线/连字符/点之后、camelCase 转折处）加分
    if (isWordBoundary(target, found)) {
      score += 10;
    }
    // 大小写完全一致，轻微加分
    if (pattern[patternIndex] === target[found]) {
      score += 1;
    }

    positions.push(found);
    previous = found;
    cursor = found + 1;
  }

  // 从目标串开头就开始命中，更好
  if (positions[0] === 0) {
    score += 20;
  }
  // 整串完全命中（长度也一致），最好
  if (positions.length === target.length) {
    score += 40;
  }

  return { score, positions };
}

/** 判断某个下标是否落在「词的边界」上。 */
function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = text[index - 1];
  if (previous === '_' || previous === '-' || previous === '.' || previous === ' ') {
    return true;
  }
  // camelCase 边界：前一个字符是小写字母、当前字符是大写字母
  const previousIsLower = previous === previous.toLowerCase() && previous !== previous.toUpperCase();
  const currentIsUpper = text[index] === text[index].toUpperCase() && text[index] !== text[index].toLowerCase();
  return previousIsLower && currentIsUpper;
}
