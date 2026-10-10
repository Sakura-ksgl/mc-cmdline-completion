import type { LiteralInfo, SymbolCategory, SymbolInfo } from '../adapter/types';

/** 合并后的统一候选：两类来源在这之后就没有区别了。 */
export interface PoolCandidate {
  /** 列表中展示的文本 */
  label: string;
  /** 落定后插入的文本 */
  insertText: string;
  /** 右侧说明 */
  detail?: string;
  /** 来源：阶段 2 只有符号与字面量两类（命令树候选不参与阶段 2） */
  source: 'symbol' | 'literal';
  /** 仅符号有类别 */
  category?: SymbolCategory;
  /** 同分时的稳定排序权重，越小越靠前 */
  weight: number;
}

/** 符号类别 → 同分时的排序权重 */
const CATEGORY_WEIGHT: Record<SymbolCategory, number> = {
  keyword: 0,
  variable: 1,
  field: 1,
  function: 2,
  method: 2,
  class: 3,
  constant: 3,
  macro: 3,
  namespace: 3,
  other: 9,
};

/** 字面量同分时排在符号之后，避免固定值盖过文件里的真实符号 */
const LITERAL_WEIGHT = 5;

/**
 * 把两类来源合并成一个候选池，并按展示文本去重。
 *
 * 去重规则：先出现的优先，符号在前 —— 因为符号有定义位置、信息更全，
 * 同名时应该保留符号而不是字面量。
 */
export function buildPool(
  symbols: readonly SymbolInfo[],
  literals: readonly LiteralInfo[],
): PoolCandidate[] {
  const pool: PoolCandidate[] = [];
  const seen = new Set<string>();

  for (const symbol of symbols) {
    if (seen.has(symbol.name)) {
      continue;
    }
    seen.add(symbol.name);
    pool.push({
      label: symbol.name,
      insertText: symbol.name,
      detail: symbol.detail,
      source: 'symbol',
      category: symbol.category,
      weight: CATEGORY_WEIGHT[symbol.category],
    });
  }

  for (const literal of literals) {
    const label = literal.label ?? literal.value;
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    pool.push({
      label,
      insertText: literal.value,
      detail: literal.detail,
      source: 'literal',
      weight: LITERAL_WEIGHT,
    });
  }

  return pool;
}
