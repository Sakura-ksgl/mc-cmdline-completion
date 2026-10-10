import type * as vscode from 'vscode';
import type {
  CompletionContext,
  LanguageAdapter,
  LiteralInfo,
  SegmentStrategy,
  SymbolInfo,
} from './types';

/**
 * 阶段 1 / 2 的占位适配器。
 *
 * 它不扫描任何语言、不读文件内容，只提供固定候选 ——
 * 用途是让交互链路与切段算法先跑通（这两件事都不涉及具体语言，是刻意的）。
 *
 * 阶段 4/5/6 接入 PythonAdapter / CAdapter / JavaAdapter 之后，
 * 它作为 `languageIds: ['*']` 的兜底适配器继续存在；
 * 也可以直接删掉 —— 删掉后没有适配器匹配的语言就不再贡献候选。
 */
export function createStubAdapter(): LanguageAdapter {
  return {
    name: 'stub',

    // '*' 只表示兜底，不是语言判断。
    languageIds: ['*'],

    scanSymbols(_document: vscode.TextDocument, _context: CompletionContext): SymbolInfo[] {
      // 阶段 2 依然不读文件内容：固定符号表。
      return STUB_SYMBOLS;
    },

    getLiterals(_context: CompletionContext): LiteralInfo[] {
      // 阶段 2 只给三个固定字面量，不做「任意数字都能补」那种事。
      return STUB_LITERALS;
    },

    getSegmentStrategy(): SegmentStrategy {
      // 阶段 2 的简单配置：纯语法驱动。
      // 不启用 whitespace（那是空格式指令用的），也不给 joinWith（阶段 2 不补分隔符）。
      return STUB_STRATEGY;
    },
  };
}

/** 固定符号表：名字刻意做成 `pl*` 一族，方便验证 `pl → player / place` 这个例子。 */
const STUB_SYMBOLS: SymbolInfo[] = [
  { name: 'player', category: 'variable', detail: '阶段 2 占位符号', line: 1 },
  { name: 'place', category: 'function', detail: '阶段 2 占位符号', line: 2 },
  { name: 'print', category: 'function', detail: '阶段 2 占位符号', line: 3 },
  { name: 'println', category: 'function', detail: '阶段 2 占位符号', line: 4 },
  { name: 'printf', category: 'function', detail: '阶段 2 占位符号', line: 5 },
  { name: 'parse', category: 'method', detail: '阶段 2 占位符号', line: 6 },
  { name: 'Parser', category: 'class', detail: '阶段 2 占位符号', line: 7 },
  { name: 'position', category: 'field', detail: '阶段 2 占位符号', line: 8 },
  { name: 'pointer', category: 'variable', detail: '阶段 2 占位符号', line: 9 },
  { name: 'MAX_DISTANCE', category: 'constant', detail: '阶段 2 占位符号', line: 10 },
  { name: 'teleport', category: 'function', detail: '阶段 2 占位符号', line: 11 },
  { name: 'give', category: 'function', detail: '阶段 2 占位符号', line: 12 },
];

/** 固定字面量：阶段 2 只要这三个，边界问题（枚举/宏算谁）不在这里纠结。 */
const STUB_LITERALS: LiteralInfo[] = [
  { value: 'true', detail: '阶段 2 占位字面量' },
  { value: 'false', detail: '阶段 2 占位字面量' },
  { value: 'null', detail: '阶段 2 占位字面量' },
];

/**
 * 占位切段策略：阶段 2 只用 `delimiters` + `pairs`。
 *
 * `whitespace` / `joinWith` 是接口上的预留（空格式指令、落定后补连接符），
 * 阶段 2 既不配也不读。
 */
const STUB_STRATEGY: SegmentStrategy = {
  delimiters: ['.', '(', ',', ')'],
  pairs: [['(', ')']],
};
