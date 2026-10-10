import type { SymbolCategory, SymbolInfo } from '../types';

/**
 * C++ 文件扫描（阶段 6 第 4.1 小步：类定义扫描 + `obj.` / `obj->` 成员访问的基础）。
 *
 * 本步覆盖：
 *  - `class` / `struct` 定义与其成员（字段 + 方法）
 *  - 顶层函数 / 变量 / `#define` 宏
 *  - 变量类型表（`Box b;` / `Box *p;` / `Box& r;`）
 *
 * 本步**不做**（拆到后续小步）：
 *  - 模板剥参数、`::` 访问、访问修饰符标注 —— 4.2
 *  - 继承与递归合并（含防循环）—— 第 5 步
 *  - 内置清单 —— 第 6 步
 *
 * 原则与 C 一致：**宁可漏，不要误报**。
 */

/** 类成员 */
export interface CppMember {
  name: string;
  /** 方法（带括号）还是字段 */
  isMethod: boolean;
  /** 是否 `static` 成员（`::` 访问时在说明里标出来） */
  isStatic: boolean;
  /** 所在访问段（`private:` 等）；类里没写访问标签时为 undefined（不猜默认值） */
  access?: 'public' | 'private' | 'protected';
  /**
   * 类别覆盖。**只有内置清单会设** —— 比如 `std::string` 是类型，不该显示成字段。
   * 文件里扫到的成员不设它，由 `isMethod` 推断。
   */
  category?: SymbolCategory;
  /**
   * 说明覆盖。**只有内置清单会设** —— 直接写全名（`std::string`），
   * 不走「类名::成员名」那套拼装。
   */
  detail?: string;
}

/** 变量的类型信息 */
export interface CppVariableType {
  /** 类名（`Box b;` → `Box`）；推不出来就是 undefined */
  className?: string;
  /** 指针（`Box *p;`）→ 用 `->` 访问 */
  isPointer: boolean;
}

/** 扫描结果 */
export interface ScannedCppFile {
  /** 顶层符号：类名 / 函数 / 变量 / 宏 */
  symbols: SymbolInfo[];
  /** 类名 → 成员列表 */
  classMembers: Map<string, CppMember[]>;
  /** 类名 → 基类名列表（只记**本文件里写出来的**名字，不解析外部类型） */
  classBases: Map<string, string[]>;
  /** 变量名 → 类型信息 */
  variableTypes: Map<string, CppVariableType>;
}

/** 继承列表里可以出现的修饰符：不改变「弹不弹」，解析时直接跳过 */
const INHERITANCE_SPECIFIERS = new Set(['public', 'protected', 'private', 'virtual']);

/** 控制流关键字：出现在「类型」位置就说明这不是声明 */
const CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'do', 'return',
  'goto', 'sizeof', 'new', 'delete', 'throw', 'try', 'catch', 'using',
]);

/** 存储类 / 限定符：不是类型，不计入「类型 + 名字」的判断 */
const STORAGE_OR_QUALIFIER = new Set([
  'static', 'inline', 'const', 'constexpr', 'mutable', 'virtual', 'explicit',
  'extern', 'register', 'volatile', 'friend', 'constexpr', 'override', 'final',
]);

/** 扫描整个文件文本 */
export function scanCppFile(text: string): ScannedCppFile {
  const symbols: SymbolInfo[] = [];
  const classMembers = new Map<string, CppMember[]>();
  const classBases = new Map<string, string[]>();
  const variableTypes = new Map<string, CppVariableType>();

  const lines = text.split(/\r?\n/);
  /** 花括号净深度 */
  let braceDepth = 0;
  /** 当前正在定义的类名 */
  let currentClass: string | undefined;
  /** 进入该类之前的花括号深度 */
  let classBaseDepth = 0;
  /** 当前类是否已被放弃（体内出现嵌套类） */
  let classAbandoned = false;
  /**
   * 当前所在的访问段（`public:` / `private:` / `protected:`）。
   *
   * 只在类里**显式写了**标签时才记录 —— 不去猜 `class` 默认 private、`struct` 默认 public，
   * 免得在"没写标签"的类上标出误导性的级别。成员**不过滤**，级别只进 detail。
   */
  let currentAccess: CppMember['access'];
  /**
   * 当前方法体的深度阈值。
   *
   * **这是与 C 最大的不同**：C 里「struct 体内出现 `{`」就等于嵌套，可以直接放弃；
   * 但 C++ 的**方法体本身带 `{`**，照搬会误杀所有带方法体的类。
   * 所以进入方法体后记下当时的深度，之后比它更深的行一律跳过（那是方法体内部，
   * 里面的局部变量不是类的成员）。
   */
  let methodBodyDepth: number | undefined;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = stripLineComment(lines[lineNumber]);
    const trimmed = line.trim();

    if (trimmed.length > 0) {
      if (currentClass !== undefined) {
        // ── 类体内 ──
        const insideMethodBody = methodBodyDepth !== undefined && braceDepth > methodBodyDepth;

        if (!insideMethodBody) {
          const accessLabel = /^(public|private|protected)\s*:\s*$/.exec(trimmed);
          if (accessLabel !== null) {
            // 访问修饰符标签：不当成员，只记下当前段（成员不过滤，级别进 detail）
            currentAccess = accessLabel[1] as CppMember['access'];
          } else if (/^(class|struct|enum|union)\s+[A-Za-z_]\w*\s*[:{]/.test(trimmed)) {
            // 体内又出现类型定义 → 嵌套，内外层成员分不清，整个放弃
            classMembers.set(currentClass, []);
            classAbandoned = true;
          } else if (!classAbandoned) {
            for (const member of matchClassMembers(trimmed, currentAccess)) {
              classMembers.get(currentClass)?.push(member);
            }
            // 这一行开启了方法体（有 `{` 且没有在同行的 `}` 收掉）→ 记下阈值
            if (trimmed.includes('{') && countBraceDelta(trimmed) > 0) {
              methodBodyDepth = braceDepth;
            }
          }
        }
      } else {
        // ── 类体外 ──
        const namespaceStart = /^namespace\s+([A-Za-z_]\w*)\s*\{/.exec(trimmed);
        const typeDefinition = /^(class|struct)\s+([A-Za-z_]\w*)\s*([;:{])/.exec(trimmed);
        if (namespaceStart !== null) {
          // 命名空间与类共用一套「作用域」机制 —— 这样 `ns::` 能走成员访问分支。
          // （嵌套命名空间的内层不提，见下面的「嵌套放弃」策略。）
          const name = namespaceStart[1];
          symbols.push({
            name,
            category: 'namespace',
            detail: `namespace ${name}`,
            line: lineNumber,
          });
          classMembers.set(name, []);
          currentClass = name;
          classAbandoned = false;
          classBaseDepth = braceDepth;
          methodBodyDepth = undefined;
          currentAccess = undefined;
        } else if (typeDefinition !== null) {
          const keyword = typeDefinition[1];
          const name = typeDefinition[2];
          symbols.push({ name, category: 'class', detail: `${keyword} ${name}`, line: lineNumber });

          if (typeDefinition[3] === ':') {
            // 继承列表：`class Derived : public Base {`（多继承留给 5.2）
            const bases = matchBaseClasses(trimmed);
            if (bases !== undefined) {
              classBases.set(name, bases);
            }
          }

          // 只要这行最终开了花括号就进入类体。
          // ⚠️ 不能只看 `typeDefinition[3]`：继承写法的第 3 组是 `:` 而不是 `{`，
          // 那样会**整个漏掉派生类**（成员一个都收不到）。
          if (trimmed.includes('{')) {
            classMembers.set(name, []);
            currentClass = name;
            classAbandoned = false;
            classBaseDepth = braceDepth;
            methodBodyDepth = undefined;
            currentAccess = undefined; // 新类重置访问段
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
    }

    // 更新花括号深度，并处理类体 / 方法体的退出
    braceDepth += countBraceDelta(line);
    if (methodBodyDepth !== undefined && braceDepth <= methodBodyDepth) {
      methodBodyDepth = undefined; // 退出方法体
    }
    if (currentClass !== undefined && braceDepth <= classBaseDepth) {
      currentClass = undefined; // 退出类体
      methodBodyDepth = undefined;
    }
  }

  return { symbols, classMembers, classBases, variableTypes };
}

/**
 * 解析继承列表：
 *   `class Derived : public Base {`              → `['Base']`
 *   `class Multi : public B1, public B2 {`       → `['B1', 'B2']`
 *
 * - 访问修饰符（`public` / `protected` / `private` / `virtual` 继承）**不改变"弹不弹"**，
 *   解析时直接跳过
 * - 按**顶层逗号**切多个基类（跳过模板参数里的逗号：`: public Base<int, char>` 是**一个**基类）
 * - 每个基类只取**名字**：`public std::string` → `string`（本文件没这个定义 → 那一层不弹）
 * - 不判断基类在不在本文件里 —— 缺定义时那个分支自然返回空，
 *   而派生类**自己的成员照常弹**（有断言守着）
 */
function matchBaseClasses(trimmed: string): string[] | undefined {
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex < 0) {
    return undefined;
  }

  const braceIndex = trimmed.indexOf('{');
  const tail = trimmed.slice(colonIndex + 1, braceIndex >= 0 ? braceIndex : trimmed.length);

  const bases: string[] = [];
  for (const part of splitByTopLevelComma(tail)) {
    const identifiers = (part.match(/[A-Za-z_]\w*/g) ?? []).filter(
      (identifier) => !INHERITANCE_SPECIFIERS.has(identifier),
    );
    const name = identifiers[identifiers.length - 1];
    if (name !== undefined) {
      bases.push(name);
    }
  }

  return bases.length > 0 ? bases : undefined;
}

/**
 * 类体内一行的成员（可能不止一个：`int a, b;`）。
 *
 * 方法 vs 字段的判据：**含 `(` 且 `=` 不在括号前** → 方法。
 * （`int x = foo(1);` 里的 `(` 属于初始化表达式，所以要先排除 `=`。）
 *
 * `access` 由调用方传入（当前访问段），`static` 就地识别 —— 两者都只用于 detail 展示。
 */
function matchClassMembers(trimmed: string, access: CppMember['access']): CppMember[] {
  const isStatic = /\bstatic\b/.test(trimmed);

  const parenIndex = trimmed.indexOf('(');
  if (parenIndex >= 0) {
    const before = trimmed.slice(0, parenIndex);
    if (!before.includes('=')) {
      const name = matchTrailingIdentifier(before);
      if (name !== undefined && !CONTROL_KEYWORDS.has(name)) {
        return [{ name, isMethod: true, isStatic, access }];
      }
    }
    return []; // 有括号但不是方法声明 → 不当成员（宁可漏）
  }

  return matchVariableDeclarations(trimmed).map((variable) => ({
    name: variable.name,
    isMethod: false,
    isStatic,
    access,
  }));
}

/** 变量声明：`int value;` / `Box b;` / `Box *p;` / `Box& r;` / `int a, b;` */
function matchVariableDeclarations(trimmed: string): Array<{ name: string; type: CppVariableType }> {
  if (!trimmed.endsWith(';') || trimmed.includes('(')) {
    return [];
  }

  const body = trimmed.slice(0, -1);
  const beforeEqualsAll = body.split('=')[0];
  // 成员访问 / 下标出现在 `=` 之前 → 更像表达式，不是声明
  if (beforeEqualsAll.includes('->') || beforeEqualsAll.includes('.')) {
    return [];
  }

  const declarators = splitByTopLevelComma(body);
  const results: Array<{ name: string; type: CppVariableType }> = [];

  for (let index = 0; index < declarators.length; index++) {
    const beforeEquals = declarators[index].split('=')[0];
    const identifiers = beforeEquals.match(/[A-Za-z_]\w*/g) ?? [];
    const meaningful = identifiers.filter((identifier) => !STORAGE_OR_QUALIFIER.has(identifier));

    // 第一个声明符要「类型 + 名字」；后续声明符只写名字
    const minimum = index === 0 ? 2 : 1;
    if (meaningful.length < minimum) {
      continue;
    }

    const name = meaningful[meaningful.length - 1];
    if (CONTROL_KEYWORDS.has(name)) {
      continue;
    }

    results.push({ name, type: describeVariableType(beforeEquals, name) });
  }

  return results;
}

/**
 * 变量名 → 类型信息。
 *
 * 先**剥掉模板参数**，再取类型部分最后一个标识符：
 *  - `Box b;`              → `Box`
 *  - `Box<int> b;`         → `Box`（剥完参数才是「最后一个标识符」）
 *  - `std::vector<int> v;` → `vector`
 *
 * 它到底是不是**本文件里定义的类**，由 `classMembers` 表判定：表里没有就不给成员。
 * 所以 `std::vector<int> v;` 之后敲 `v.` 会**静默不弹**（本文件没有 `vector` 的定义）——
 * 这是"推不出来就不补"，不是错误。
 */
function describeVariableType(beforeEquals: string, name: string): CppVariableType {
  const nameIndex = beforeEquals.lastIndexOf(name);
  const typePart = nameIndex >= 0 ? beforeEquals.slice(0, nameIndex) : '';
  const withoutTemplates = stripTemplateArguments(typePart);
  const identifiers = (withoutTemplates.match(/[A-Za-z_]\w*/g) ?? []).filter(
    (identifier) => !STORAGE_OR_QUALIFIER.has(identifier),
  );
  return {
    className: identifiers[identifiers.length - 1],
    isPointer: typePart.includes('*'),
  };
}

/**
 * 按**顶层逗号**切分，跳过尖括号里的逗号。两个地方都用它：
 *
 *  - 切声明符：`int a, b;` → `['int a', ' b']`；
 *    `Box<int, std::string> m;` → `['Box<int, std::string> m']`（**一个**声明符）
 *  - 切继承列表：`public B1, public B2` → `[' public B1', ' public B2']`；
 *    而 `public Base<int, char>` 是**一个**基类
 *
 * 直接 `split(',')` 会把模板参数里的逗号当分隔符 —— 真踩过：
 * `Box<int, std::string> m;` 的 `m` 被当成第二个声明符，类型算成了 `string`。
 */
function splitByTopLevelComma(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const character of body) {
    if (character === '<') {
      depth++;
    } else if (character === '>') {
      if (depth > 0) {
        depth--;
      }
    } else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  parts.push(current);
  return parts;
}

/**
 * 剥掉类型里的模板参数：`Box<int>` → `Box`、`std::vector<int, string>` → `std::vector`。
 *
 * 按**尖括号配平**剥离，所以嵌套模板也对：`Box<vector<int>>` → `Box`。
 * 尖括号不配平时按原样返回（不做猜测）。
 */
function stripTemplateArguments(typeName: string): string {
  let depth = 0;
  let result = '';
  for (const character of typeName) {
    if (character === '<') {
      depth++;
    } else if (character === '>') {
      if (depth === 0) {
        return typeName; // 尖括号不配平 → 不猜
      }
      depth--;
    } else if (depth === 0) {
      result += character;
    }
  }
  return depth === 0 ? result : typeName;
}

/** 顶层函数声明 / 定义：`int foo(int a) {` / `void bar();` */
function matchFunctionName(trimmed: string): string | undefined {
  const parenIndex = trimmed.indexOf('(');
  if (parenIndex < 0) {
    return undefined;
  }

  const before = trimmed.slice(0, parenIndex);
  if (before.includes('=')) {
    return undefined; // 初始化 / 赋值里的调用
  }

  const tokens = before.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < 2) {
    return undefined; // 至少「类型 + 名字」
  }

  const name = matchTrailingIdentifier(before);
  if (name === undefined || CONTROL_KEYWORDS.has(name)) {
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

/** 取一段文本末尾的标识符（`int get` → `get`、`~Box` → `Box`） */
function matchTrailingIdentifier(text: string): string | undefined {
  return /([A-Za-z_]\w*)\s*$/.exec(text)?.[1];
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
