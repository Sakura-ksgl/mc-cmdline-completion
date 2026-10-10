import type * as vscode from 'vscode';
import type {
  CompletionContext,
  LanguageAdapter,
  LiteralInfo,
  SegmentStrategy,
  SymbolInfo,
} from '../types';
import { BUILTIN_FUNCTIONS, TYPE_METHODS, type PythonType } from './builtins';

/**
 * Python 适配器（阶段 4，范围 B）。
 *
 * 做：
 *  - 扫当前文件：顶层 `def`、`class`、类内方法、顶层赋值
 *  - 顶层赋值的**直接字面量** → 记下变量类型（str / int / float / list / dict）
 *  - 成员访问（`s.` / `"abc".`）时只给该类型的方法
 *  - 内置函数与内置类型方法硬编码（「只扫当前文件」的唯一例外）
 *
 * 不做：
 *  - 不扫工作区、不扫 import 的模块
 *  - 不做完整类型推断：函数参数、函数返回值、变量到变量的传递，一律「推不出来就不补」
 *  - 不做字符串 / 注释识别（属于后续阶段的语法结构识别）
 */
export class PythonAdapter implements LanguageAdapter {
  readonly name = 'python';
  readonly languageIds = ['python'];

  scanSymbols(document: vscode.TextDocument, context: CompletionContext): SymbolInfo[] {
    const scanned = scanFile(document.getText());

    // 成员访问语境：只给该类型的方法；类型推不出来就什么都不给
    if (context.delimiter === '.') {
      const type = inferReceiverType(readReceiver(context), scanned.variableTypes);
      return type === undefined ? [] : TYPE_METHODS[type];
    }

    // 普通语境：文件里的定义 + 内置函数。
    // 文件定义排在前面，同名时合并去重会保留用户自己的定义。
    return [...scanned.symbols, ...BUILTIN_FUNCTIONS];
  }

  getLiterals(_context: CompletionContext): LiteralInfo[] {
    return PYTHON_LITERALS;
  }

  getSegmentStrategy(): SegmentStrategy {
    return PYTHON_STRATEGY;
  }
}

/** Python 的三个关键字面量，注意大小写 */
const PYTHON_LITERALS: LiteralInfo[] = [
  { value: 'True', detail: 'Python 字面量' },
  { value: 'False', detail: 'Python 字面量' },
  { value: 'None', detail: 'Python 字面量' },
];

/**
 * 与占位适配器保持同一套分隔符。
 * 方括号 `[` `]` 暂时不声明（范围 B 没要求），所以 `items[0` 不会被切段。
 */
const PYTHON_STRATEGY: SegmentStrategy = {
  delimiters: ['.', '(', ',', ')'],
  pairs: [['(', ')']],
  // 成员访问语境：声明之后，通用层在 `s.` 位置不会再并进字面量（True / False / None）
  memberAccess: ['.'],
};

/** 扫描结果 */
interface ScannedFile {
  /** 文件里扫到的定义 */
  symbols: SymbolInfo[];
  /** 顶层赋值推断出的变量类型：变量名 → 类型 */
  variableTypes: Map<string, PythonType>;
}

/**
 * 扫描整个文件文本。只读传入的这一份文本，不碰任何其它文件。
 *
 * 覆盖：顶层 `def`、顶层 `class`、类内方法、顶层赋值（并顺带推断字面量类型）。
 */
function scanFile(text: string): ScannedFile {
  const symbols: SymbolInfo[] = [];
  const variableTypes = new Map<string, PythonType>();
  /** 最近一个顶层 class 的名字；缩进的 def 归属它 */
  let currentClass: string | undefined;

  const lines = text.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    const trimmed = line.trim();

    // 跳过空行与整行注释
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // 顶层 class
    const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(line);
    if (classMatch !== null && indent === 0) {
      const name = classMatch[1];
      symbols.push({ name, category: 'class', detail: `class ${name}`, line: lineNumber });
      currentClass = name;
      continue;
    }

    // def：缩进为 0 → 顶层函数；缩进 > 0 → 类内方法
    const defMatch = /^\s*def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (defMatch !== null) {
      const name = defMatch[1];
      if (indent === 0) {
        symbols.push({ name, category: 'function', detail: `def ${name}()`, line: lineNumber });
        // 顶层函数开始 → 已经离开类作用域
        currentClass = undefined;
      } else {
        symbols.push({
          name,
          category: 'method',
          detail: currentClass === undefined ? `${name}()` : `${currentClass}.${name}()`,
          line: lineNumber,
        });
      }
      continue;
    }

    // 顶层赋值（含带类型注解的 `name: str = "x"`）
    // `(?!=)` 用来排除 `x == 1` 这种比较
    if (indent === 0) {
      const assignMatch = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)\s*(.+)$/.exec(line);
      if (assignMatch !== null) {
        const name = assignMatch[1];
        const value = assignMatch[2].trim();

        symbols.push({
          name,
          category: /^[A-Z][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable',
          detail: '顶层变量',
          line: lineNumber,
        });

        const type = inferLiteralType(value);
        if (type !== undefined && !variableTypes.has(name)) {
          variableTypes.set(name, type);
        }

        // 顶层的非 class 语句开始 → 类作用域结束
        currentClass = undefined;
      }
    }
  }

  return { symbols, variableTypes };
}

/**
 * 取成员访问的接收者。
 *
 * **不能直接取「倒数第二段」** —— 段的粒度由 `delimiters` 决定，Python 的 delimiters
 * 不含 `;` 与空格，所以同一行多语句会被并进一段
 * （`y = 1; x.` 的倒数第二段是 `"y = 1; x"`），查类型表必然落空。
 *
 * 判据是**段里有没有 `;`**（`;` 不是分隔符，会留在段里）：
 *  - 有 `;` → 同一行写了多条语句，整段不是接收者，**贴着点号往前扫一个标识符**
 *  - 没有 `;` → 整段就是一个接收者候选，原样返回
 *    （这样 `"abc".` 这种**字面量接收者**才不会被扫没）
 *
 * 标识符规则属于语言层面，所以它留在适配器内部（通用层只负责切段，不管接收者识别）。
 */
function readReceiver(context: CompletionContext): string | undefined {
  const segments = context.previousSegments;
  if (segments.length < 2) {
    return undefined;
  }

  if (segments[segments.length - 1] !== '.') {
    return undefined;
  }

  const beforeAccess = segments[segments.length - 2];
  if (beforeAccess.includes(';')) {
    return /([A-Za-z_]\w*)$/.exec(beforeAccess)?.[1];
  }
  return beforeAccess;
}

/** 从接收者文本推断类型；推不出来返回 undefined（「推不出来就不补」）。 */
function inferReceiverType(
  receiver: string | undefined,
  variableTypes: Map<string, PythonType>,
): PythonType | undefined {
  if (receiver === undefined) {
    return undefined;
  }

  const text = receiver.trim();
  const literal = inferLiteralType(text);
  if (literal !== undefined) {
    return literal;
  }

  // 纯标识符 → 查顶层赋值推断出来的类型表
  if (/^[A-Za-z_]\w*$/.test(text)) {
    return variableTypes.get(text);
  }

  return undefined;
}

/**
 * 从一段「直接字面量」文本推断类型。
 *
 * 只认直接字面量：字符串 / 整数 / 浮点 / 列表 / 字典。
 * 函数调用、变量、表达式一律返回 undefined —— 不做传递追踪。
 */
function inferLiteralType(text: string): PythonType | undefined {
  if (text.length === 0) {
    return undefined;
  }
  // 字符串字面量（含 r/b/f/u 前缀与三种引号）
  if (/^[rbfuRBFU]{0,2}("""|'''|"|')/.test(text)) {
    return 'str';
  }
  if (text.startsWith('[')) {
    return 'list';
  }
  if (text.startsWith('{')) {
    return 'dict';
  }
  if (/^-?\d+$/.test(text)) {
    return 'int';
  }
  if (/^-?(\d+\.\d*|\.\d+|\d+[eE][-+]?\d+)$/.test(text)) {
    return 'float';
  }
  return undefined;
}
