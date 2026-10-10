import type * as vscode from 'vscode';
import type {
  CompletionContext,
  LanguageAdapter,
  LiteralInfo,
  SegmentStrategy,
  SymbolInfo,
} from '../types';
import { BUILTIN_FUNCTIONS } from './builtins';
import { looksLikeCpp, scanCFile, type ScannedCFile } from './cScanner';

/**
 * C 适配器（阶段 5 三步齐了：符号扫描 + struct 成员访问 + 内置清单与字面量）。
 *
 * 做：
 *  - 扫当前文件：函数定义/声明、变量定义、struct 定义、`#define` 宏、typedef
 *  - `.h` 归属判断（认领判定，见 `claims`）
 *  - struct 成员访问：`p.` / `p->` 只给该 struct 的字段
 *  - 内置清单：C 标准库常用函数（硬编码 —— 「只扫当前文件」的唯一例外）
 *  - 字面量：`NULL` / `EOF`
 *
 * 注：**归属判断只在 `claims` 里回答一次**。「要不要处理这个文件」由
 * `registry.resolve` 通过 `claims` 决定，所以 `scanSymbols` / `getLiterals`
 * 里不再重复判断。
 */
export class CAdapter implements LanguageAdapter {
  readonly name = 'c';

  /**
   * 同时声明 `c` 与 `cpp`：
   *  - `.c` 的 languageId 是 `c`
   *  - `.h` 的 languageId 视环境而定（可能是 `c`，也可能被 C/C++ 扩展改成 `cpp`），
   *    两种都要能收到，否则纯 C 项目的头文件就没人管了
   *  - 真正的 C++ 文件在 `claims` 里让位（阶段 6 归 CppAdapter）
   */
  readonly languageIds = ['c', 'cpp'];

  /**
   * 认领判定（**文件名优先**）：
   *
   *  1. 文件名以 `.h` 结尾 → 无论 languageId 是 `c` 还是 `cpp`，都看内容：
   *     含 C++ 特征（`class` / `namespace` / `template` / `::`）就让位，
   *     否则按 C 处理（纯 C 的头文件）
   *  2. 其余文件：languageId 为 `c`（`.c`）→ 认领；
   *     其余（`.cpp` / `.hpp` / `.cc`…）→ 让位，交给阶段 6 的 CppAdapter
   *
   * 「文件名优先」是关键：VSCode 内置默认把 `.h` 关联成 `c`，装了 C/C++ 扩展后可能
   * 变成 `cpp`，所以**头文件不能靠 languageId 区分**。早先把「languageId 为 c 就直接按 C
   * 处理」放在第一层时，languageId 为 `c` 的 `.h` 会完全跳过内容判断。
   *
   * 这个判据与将来 CppAdapter 的判据**互斥**（同一个 `.h` 只会被其中一个认领），
   * 所以注册顺序不影响结果。
   */
  claims(document: vscode.TextDocument): boolean {
    if (document.fileName.toLowerCase().endsWith('.h')) {
      return !looksLikeCpp(document.getText());
    }
    return document.languageId === 'c';
  }

  scanSymbols(document: vscode.TextDocument, context: CompletionContext): SymbolInfo[] {
    const scanned = scanCFile(document.getText());

    // 成员访问语境（`p.` / `p->`）：只给该 struct 的字段；推不出来就什么都不给
    if (context.delimiter === '.' || context.delimiter === '->') {
      return structMemberSymbols(scanned, context);
    }

    // 普通语境：文件里的定义 + 内置函数。
    // 文件定义排在前面，同名时合并去重会保留用户自己的定义。
    return [...scanned.symbols, ...BUILTIN_FUNCTIONS];
  }

  getLiterals(_context: CompletionContext): LiteralInfo[] {
    // 归属判断已经由 claims 做过（resolve 保证只有被认领的文件才会走到这里）
    return C_LITERALS;
  }

  getSegmentStrategy(): SegmentStrategy {
    return C_STRATEGY;
  }
}

/**
 * C 的常用宏常量。
 *
 * 按字面量的既定边界（「这个位置允许的那几个固定值」），只给这两个 ——
 * 不放 `0` / `1`：那是「任意整数」的代表，塞进来只会变成噪音。
 */
const C_LITERALS: LiteralInfo[] = [
  { value: 'NULL', detail: 'C 空指针常量' },
  { value: 'EOF', detail: '文件结束标志（stdio.h）' },
];

/**
 * `->` 是**多字符分隔符**，需要通用层按「最长匹配优先」切段 ——
 * 这是切段那边已经支持的能力（方案 i），不依赖任何语言判断。
 */
const C_STRATEGY: SegmentStrategy = {
  delimiters: ['.', '->', '(', ',', ')'],
  pairs: [['(', ')']],
  // 成员访问语境：值用 `.`、指针用 `->`。
  // 声明之后，通用层在成员访问位置就不会再并进字面量（NULL / EOF）
  memberAccess: ['.', '->'],
};

/**
 * 成员访问（`p.` / `p->`）的候选：**只给该 struct 的字段**。
 *
 * 规则：
 *  - 接收者必须是当前文件里声明过的变量，且它的类型是某个 struct；
 *  - **访问符要和变量形态匹配**：值类型用 `.`、指针用 `->`。
 *    交叉使用（值类型写 `->`、指针写 `.`）在 C 里是错的，一律不弹；
 *  - 其余情况（函数返回值、函数参数、未声明变量、`foo().` 这类）一律不弹。
 *
 * 注意：C 没有内置方法表，成员完全来自当前文件里的 struct 定义。
 */
function structMemberSymbols(scanned: ScannedCFile, context: CompletionContext): SymbolInfo[] {
  const receiver = readReceiver(context);
  if (receiver === undefined) {
    return [];
  }

  const type = scanned.variableTypes.get(receiver);
  if (type?.structName === undefined) {
    return [];
  }

  // 访问符与变量形态必须匹配：指针用 `->`，值用 `.`
  const isArrowAccess = context.delimiter === '->';
  if (type.isPointer !== isArrowAccess) {
    return [];
  }

  const fields = scanned.structFields.get(type.structName) ?? [];
  return fields.map((field) => ({
    name: field,
    category: 'field' as const,
    detail: `${type.structName}.${field}`,
  }));
}

/**
 * 取成员访问的接收者。
 *
 * **不能直接取「倒数第二段」** —— 段的粒度由 `delimiters` 决定，而 C 的 delimiters
 * 不含 `;` 与空格，所以同一行多语句会被并进一段：
 *   `struct Vec { int dx; int dy; } speed; speed.`
 * 倒数第二段是 `"struct Vec { int dx; int dy; } speed; speed"`，查类型表必然落空。
 *
 * 判据是**段里有没有 `;`**（`;` 不是分隔符，所以会留在段里）：
 *  - 有 `;` → 同一行写了多条语句，整段不是接收者，**贴着访问符往前扫一个标识符**
 *    （C 的标识符是 `[A-Za-z_][A-Za-z0-9_]*`）
 *  - 没有 `;` → 整段就是一个接收者候选，原样返回，交给类型表判定
 *
 * 为什么不做成"一律扫标识符"：接收者也可能是**字面量**（`"abc".` 在 Python 那边要走
 * 同一条路），一律扫标识符会把这类接收者扫没。标识符规则属于语言层面，
 * 所以这条规则留在适配器内部（通用层只负责切段，不管接收者识别）。
 */
function readReceiver(context: CompletionContext): string | undefined {
  const segments = context.previousSegments;
  if (segments.length < 2) {
    return undefined;
  }

  const access = segments[segments.length - 1];
  if (access !== '.' && access !== '->') {
    return undefined;
  }

  const beforeAccess = segments[segments.length - 2];
  if (beforeAccess.includes(';')) {
    return /([A-Za-z_]\w*)$/.exec(beforeAccess)?.[1];
  }
  return beforeAccess;
}
