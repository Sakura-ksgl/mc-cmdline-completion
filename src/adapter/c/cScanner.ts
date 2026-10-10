import type { SymbolInfo } from '../types';

/**
 * C 文件扫描（纯逻辑，不依赖 vscode，可脱离扩展宿主验证）。
 *
 * 用启发式正则 + 花括号配平，**不写完整 C 解析器**。
 * 原则：宁可漏，不要误报 —— 误报会污染候选池，漏报只是少几条候选。
 */

/** 变量类型信息（阶段 5 第二步做成员访问时用） */
export interface CVariableType {
  /** 变量是某个 struct 的实例时，记下 struct 名 */
  structName?: string;
  /** 是否是指针（`struct Point *p;`） */
  isPointer: boolean;
}

/** 扫描结果 */
export interface ScannedCFile {
  /** 本文件扫到的符号：函数 / 变量 / struct 名 / 宏 / typedef */
  symbols: SymbolInfo[];
  /**
   * struct 名 → 字段名列表。
   * 阶段 5 第一步不使用，第二步做成员访问时直接用 ——
   * 扫描时顺手收集，避免第二步再扫一遍文件。
   */
  structFields: Map<string, string[]>;
  /** 变量名 → 类型信息，同上（第一步不使用） */
  variableTypes: Map<string, CVariableType>;
}

/** 存储类 / 限定符：不是类型，不计入「类型 + 名字」的判断 */
const STORAGE_OR_QUALIFIER = new Set([
  'static', 'inline', 'extern', 'const', 'volatile', 'register', 'auto', 'restrict',
]);

/** 控制流关键字：出现在「类型」位置就说明这不是声明 */
const CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'do', 'return',
  'goto', 'sizeof', 'break', 'continue',
]);

/** 内置类型关键字 */
const BUILTIN_TYPES = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
]);

/** C++ 特征：出现任一即认为这个文件（.h）是 C++ 的 */
const CPP_MARKERS: RegExp[] = [/\bclass\b/, /\bnamespace\b/, /\btemplate\b/, /::/];

/** 内容里有没有 C++ 特征（供适配器做 .h 归属判断用） */
export function looksLikeCpp(text: string): boolean {
  return CPP_MARKERS.some((marker) => marker.test(text));
}

/** 扫描整个文件文本 */
export function scanCFile(text: string): ScannedCFile {
  const symbols: SymbolInfo[] = [];
  const structFields = new Map<string, string[]>();
  const variableTypes = new Map<string, CVariableType>();

  const lines = text.split(/\r?\n/);
  /** 花括号净深度（粗略统计，不区分字符串 / 注释里的括号） */
  let braceDepth = 0;
  /** 当前正在定义的 struct 名 */
  let currentStruct: string | undefined;
  /** 当前 struct 是否已被放弃（体内出现嵌套 / 匿名 struct 时） */
  let currentStructAbandoned = false;
  /** 进入该 struct 之前的花括号深度 */
  let structBaseDepth = 0;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = stripLineComment(lines[lineNumber]);
    const trimmed = line.trim();

    if (trimmed.length > 0) {
      if (currentStruct !== undefined) {
        // 在 struct 体内：这一行只用来收字段，不当顶层符号
        if (line.includes('{')) {
          // 体内出现 `{` → 说明有嵌套 / 匿名 struct，内外层字段分不清。
          // 整个放弃（宁可漏，不要误报）
          structFields.set(currentStruct, []);
          currentStructAbandoned = true;
        } else if (!currentStructAbandoned) {
          structFields.get(currentStruct)?.push(...matchVariableNames(trimmed));
        }
      } else if (/^#\s*define\b/.test(trimmed)) {
        const macro = /^#\s*define\s+([A-Za-z_]\w*)/.exec(trimmed);
        if (macro !== null) {
          symbols.push({
            name: macro[1],
            category: 'macro',
            detail: '#define 宏',
            line: lineNumber,
          });
        }
      } else if (/^typedef\b/.test(trimmed)) {
        const typedefName = matchTypedefName(trimmed);

        // `typedef struct X { ... } Y;` —— 顺手把内联 struct 的字段收进来，
        // 否则 typedef 出来的类型没法做成员访问
        const inlineStruct = /typedef\s+struct\s*([A-Za-z_]\w*)?\s*\{/.exec(trimmed);
        if (inlineStruct !== null) {
          const inlineFields = matchInlineStructFields(trimmed);
          if (inlineFields !== undefined) {
            // 结构体标签；匿名 struct 就用 typedef 出来的名字
            const structName = inlineStruct[1] ?? typedefName;
            if (structName !== undefined) {
              structFields.set(structName, inlineFields);
            }
            // 别名也指向同一份字段，这样 `Y y; y.` 也能用
            if (typedefName !== undefined && typedefName !== structName) {
              structFields.set(typedefName, inlineFields);
            }
          }
        }

        if (typedefName !== undefined) {
          symbols.push({
            name: typedefName,
            category: 'class',
            detail: 'typedef 类型',
            line: lineNumber,
          });
        }
      } else if (/^struct\s+[A-Za-z_]\w*\s*[{;]/.test(trimmed)) {
        const declared = /^struct\s+([A-Za-z_]\w*)\s*([{;])/.exec(trimmed);
        if (declared !== null) {
          const name = declared[1];
          symbols.push({ name, category: 'class', detail: `struct ${name}`, line: lineNumber });
          if (declared[2] === '{') {
            const inlineFields = matchInlineStructFields(trimmed);
            if (inlineFields !== undefined) {
              // 单行写法 `struct Point { int x; int y; };`：字段已经就地抽好
              structFields.set(name, inlineFields);

              // 单行定义可能顺带声明变量：`struct Vec { int dx; int dy; } speed;`
              const trailing = matchTrailingVariables(trimmed);
              for (const variableName of trailing.names) {
                symbols.push({
                  name: variableName,
                  category: 'variable',
                  detail: '变量',
                  line: lineNumber,
                });
                if (!variableTypes.has(variableName)) {
                  variableTypes.set(variableName, {
                    structName: name,
                    isPointer: trailing.isPointer,
                  });
                }
              }
            } else {
              // 多行写法：进入 struct 体，由后续行逐行收集字段
              structFields.set(name, []);
              currentStruct = name;
              currentStructAbandoned = false;
              structBaseDepth = braceDepth;
            }
          }
        }
      } else {
        const functionName = matchFunctionName(trimmed);
        if (functionName !== undefined) {
          symbols.push({
            name: functionName,
            category: 'function',
            detail: `${functionName}()`,
            line: lineNumber,
          });
        } else {
          for (const variable of matchVariableDeclarations(trimmed)) {
            symbols.push({
              name: variable.name,
              category: 'variable',
              detail: '变量',
              line: lineNumber,
            });
            if (!variableTypes.has(variable.name)) {
              variableTypes.set(variable.name, variable.type);
            }
          }
        }
      }
    }

    // 统一更新花括号深度；回到 struct 之前那一层就说明 struct 结束了
    braceDepth += countBraceDelta(line);
    if (currentStruct !== undefined && braceDepth <= structBaseDepth) {
      currentStruct = undefined;
    }
  }

  return { symbols, structFields, variableTypes };
}

/** 一个变量声明的扫描结果 */
interface MatchedVariable {
  name: string;
  type: CVariableType;
}

/** 变量定义：`int x;` / `char *s;` / `struct Point p;` / `int a, b, c;` */
function matchVariableDeclarations(trimmed: string): MatchedVariable[] {
  // 必须以 `;` 结尾；含括号的交给函数那条路
  if (!trimmed.endsWith(';') || trimmed.includes('(')) {
    return [];
  }

  const body = trimmed.slice(0, -1);
  const beforeEqualsAll = body.split('=')[0];

  // 成员访问出现在 `=` 之前 → 更像一句赋值/表达式，不是声明
  if (beforeEqualsAll.includes('->') || beforeEqualsAll.includes('.')) {
    return [];
  }

  // 含下标的行：只有第一个标识符是内置类型才放行。
  // 这样 `char buf[256];` 能收，而 `arr[i] = 5;` 不会被误收。
  if (/[[\]]/.test(beforeEqualsAll)) {
    const first = (beforeEqualsAll.match(/[A-Za-z_]\w*/g) ?? [])[0];
    if (first === undefined || !BUILTIN_TYPES.has(first)) {
      return [];
    }
  }

  const declarators = body.split(',');
  const results: MatchedVariable[] = [];

  for (let index = 0; index < declarators.length; index++) {
    const beforeEquals = declarators[index].split('=')[0];
    const identifiers = beforeEquals.match(/[A-Za-z_]\w*/g) ?? [];
    const meaningful = identifiers.filter((identifier) => !STORAGE_OR_QUALIFIER.has(identifier));

    // 第一个声明符必须是「类型 + 名字」两个标识符；后续声明符只写名字
    const minimum = index === 0 ? 2 : 1;
    if (meaningful.length < minimum) {
      continue;
    }

    const name = meaningful[meaningful.length - 1];
    if (BUILTIN_TYPES.has(name) || CONTROL_KEYWORDS.has(name)) {
      continue;
    }

    results.push({ name, type: describeVariableType(beforeEquals, name) });
  }

  return results;
}

/**
 * 变量名 → struct 类型与是否指针。
 *
 * 两种类型写法都认：
 *  - `struct Point p;` → 直接取 `struct` 后面的标签名
 *  - `VecT v;`（typedef 出来的类型）→ 取类型部分最后一个标识符当**候选**类型名。
 *    它到底是不是 struct，由 `structFields` 表判定：表里没有就不给成员。
 */
function describeVariableType(beforeEquals: string, name: string): CVariableType {
  const nameIndex = beforeEquals.lastIndexOf(name);
  const typePart = nameIndex >= 0 ? beforeEquals.slice(0, nameIndex) : '';
  const isPointer = beforeEquals.includes('*');

  const structMatch = /\bstruct\s+([A-Za-z_]\w*)/.exec(typePart);
  if (structMatch !== null) {
    return { structName: structMatch[1], isPointer };
  }

  const identifiers = (typePart.match(/[A-Za-z_]\w*/g) ?? []).filter(
    (identifier) => !STORAGE_OR_QUALIFIER.has(identifier),
  );
  return { structName: identifiers[identifiers.length - 1], isPointer };
}

/** 函数声明 / 定义：`int add(int a, int b);` / `void bar(void) {` */
function matchFunctionName(trimmed: string): string | undefined {
  const parenIndex = trimmed.indexOf('(');
  if (parenIndex < 0) {
    return undefined;
  }

  const before = trimmed.slice(0, parenIndex).trim();
  // `=` 在括号前 → 初始化或赋值里的调用，不是声明
  if (before.includes('=')) {
    return undefined;
  }

  const tokens = before.split(/\s+/).filter((token) => token.length > 0);
  // 至少要有「类型 + 名字」两个 token；`printf("hi");` 这种调用只有一个 token
  if (tokens.length < 2) {
    return undefined;
  }

  const name = tokens[tokens.length - 1].replace(/^\*+/, '');
  if (!/^[A-Za-z_]\w*$/.test(name) || CONTROL_KEYWORDS.has(name)) {
    return undefined;
  }

  // 「类型」位置上的 token 不能是控制流关键字或存储类说明符
  const typeToken = tokens[tokens.length - 2].replace(/^\*+/, '');
  if (!/^[A-Za-z_]\w*$/.test(typeToken)) {
    return undefined;
  }
  if (CONTROL_KEYWORDS.has(typeToken) || STORAGE_OR_QUALIFIER.has(typeToken)) {
    return undefined;
  }

  return name;
}

/** typedef 定义的名字：只看单行（跨行的匿名 struct typedef 见已知限制） */
function matchTypedefName(trimmed: string): string | undefined {
  if (!trimmed.endsWith(';')) {
    return undefined;
  }

  const identifiers = trimmed.slice(0, -1).match(/[A-Za-z_]\w*/g) ?? [];
  if (identifiers.length < 2) {
    return undefined;
  }

  const name = identifiers[identifiers.length - 1];
  if (CONTROL_KEYWORDS.has(name) || STORAGE_OR_QUALIFIER.has(name)) {
    return undefined;
  }
  return name;
}

/** struct 体里的字段名（复用变量声明规则） */
function matchVariableNames(trimmed: string): string[] {
  return matchVariableDeclarations(trimmed).map((variable) => variable.name);
}

/**
 * 单行 struct 定义的字段：`struct Point { int x; int y; };`
 *
 * 规则：
 *  - 同行里必须有配对的 `{` … `}`（取最后一个 `}`）；
 *  - 花括号内**不含** `{`（有嵌套就整个放弃，宁可漏不要误报）；
 *  - 花括号内按 `;` 切分，每片补回 `;` 后复用变量声明规则抽名字。
 *
 * 返回 `undefined` 表示「这不是单行定义」，调用方按多行形式逐行收集。
 */
function matchInlineStructFields(trimmed: string): string[] | undefined {
  const open = trimmed.indexOf('{');
  if (open < 0) {
    return undefined;
  }

  const close = trimmed.lastIndexOf('}');
  if (close < open) {
    return undefined;
  }

  const body = trimmed.slice(open + 1, close);
  if (body.includes('{')) {
    return undefined;
  }

  return body.split(';').flatMap((part) => matchVariableNames(`${part};`));
}

/** 单行 struct 定义尾部的声明符 */
interface TrailingVariables {
  names: string[];
  /** 尾部声明符里是否带 `*`（指针变量） */
  isPointer: boolean;
}

/**
 * 取单行 struct 定义尾部的变量名：`struct Vec { int dx; int dy; } speed, *ptr;`
 *
 * 类型由调用方（就是那个 struct）提供，这里只取名字。
 */
function matchTrailingVariables(trimmed: string): TrailingVariables {
  const close = trimmed.lastIndexOf('}');
  if (close < 0) {
    return { names: [], isPointer: false };
  }

  const rest = trimmed.slice(close + 1).trim();
  const body = rest.endsWith(';') ? rest.slice(0, -1) : rest;
  if (body.length === 0) {
    return { names: [], isPointer: false };
  }

  const names: string[] = [];
  for (const declarator of body.split(',')) {
    const identifiers = (declarator.split('=')[0].match(/[A-Za-z_]\w*/g) ?? []).filter(
      (identifier) => !BUILTIN_TYPES.has(identifier) && !STORAGE_OR_QUALIFIER.has(identifier),
    );
    if (identifiers.length === 0) {
      continue;
    }
    names.push(identifiers[identifiers.length - 1]);
  }

  return { names, isPointer: body.includes('*') };
}

/** 去掉行注释（简单版：只看 `//`，不识别引号里的 `//`） */
function stripLineComment(line: string): string {
  const index = line.indexOf('//');
  return index >= 0 ? line.slice(0, index) : line;
}

/** 这一行的花括号净变化量 */
function countBraceDelta(line: string): number {
  let delta = 0;
  for (const character of line) {
    if (character === '{') {
      delta++;
    } else if (character === '}') {
      delta--;
    }
  }
  return delta;
}
