import type * as vscode from 'vscode';
import type {
  CompletionContext,
  LanguageAdapter,
  LiteralInfo,
  SegmentStrategy,
  SymbolInfo,
} from '../types';
import { BUILTIN_CPP_SYMBOLS, BUILTIN_CPP_TYPE_MEMBERS } from './builtins';
import { scanCppFile, type CppMember, type ScannedCppFile } from './cppScanner';

/**
 * C++ 适配器（阶段 6）。
 *
 * ⚠️ **本步（第 3 步）只有骨架 + 归属**：
 *  - `scanSymbols` 返回空（扫描在第 4 步）
 *  - `getLiterals` 返回空（内置清单在第 5 步）
 *
 * 本步真正生效的是 **`claims`**：把 `.cpp` / `.cc` / `.cxx` / `.hpp` 以及
 * **含 C++ 特征的 `.h`** 从 CAdapter 手里接管过来。
 */
export class CppAdapter implements LanguageAdapter {
  readonly name = 'cpp';

  /**
   * 只声明 `cpp` —— VSCode 里 C++ 文件的 languageId 就是 `cpp`
   * （官方 Language Identifiers 列表里 C++ 对应 `cpp`；`.cpp` / `.cc` / `.cxx` / `.hpp`
   * 以及被 C/C++ 扩展接管后的 `.h` 都是它）。
   *
   * 曾经还声明过 `c++`，但那个 id 不是 VSCode 的标准值 —— 一条**永远不会命中的死注册**，
   * 已删除（同一 languageId 被多条注册覆盖会让候选成倍，见 `registry.registrations()`）。
   * **如果哪天有环境真把 C++ 文件报成 `c++`，把 `'c++'` 加回这个数组即可。**
   */
  readonly languageIds = ['cpp'];

  /**
   * 认领判定。**必须与 CAdapter 的判据严格互斥**（同一个文件不能被两个适配器同时认领），
   * 这样才能保证 `registry.resolve` 的结果与注册顺序无关。
   *
   * 分工（与 CAdapter 的判据互为反面）：
   *  - 后缀 `.cpp` / `.cc` / `.cxx` / `.hpp` 等 → 认领
   *  - 后缀 `.h` → **看内容**：含 `class` / `namespace` / `template` / `::` 任一就认领；
   *    否则让位（纯 C 的头文件留给 CAdapter）
   *  - 其余后缀 → 不认领（即使语言被手动设成 C++，比如 `notes.txt`）
   */
  claims(document: vscode.TextDocument): boolean {
    const fileName = document.fileName.toLowerCase();

    // 头文件要看内容：只有带 C++ 特征的才归 C++
    if (fileName.endsWith('.h')) {
      return looksLikeCpp(document.getText());
    }

    return CPP_SOURCE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
  }

  scanSymbols(document: vscode.TextDocument, context: CompletionContext): SymbolInfo[] {
    const scanned = scanCppFile(document.getText());

    // 成员访问语境（`obj.` / `obj->` / `Box::`）：只给该类型的成员；推不出来就什么都不给
    if (
      context.delimiter === '.' ||
      context.delimiter === '->' ||
      context.delimiter === '::'
    ) {
      return classMemberSymbols(scanned, context);
    }

    // 普通语境：文件里的定义 + 内置清单。
    // 文件定义排在前面 —— 候选池按 label 去重时保留先出现的，也就是用户自己的。
    return [...scanned.symbols, ...BUILTIN_CPP_SYMBOLS];
  }

  getLiterals(_context: CompletionContext): LiteralInfo[] {
    // 第 4.1 小步不实现内置清单 / 字面量（第 6 步接上）
    return [];
  }

  getSegmentStrategy(): SegmentStrategy {
    return CPP_STRATEGY;
  }
}

/**
 * 成员访问的候选：**只给该类型的成员**，字段与方法都给。
 *
 * 三种访问符的分工：
 *  - `obj.` / `obj->` → 接收者是**变量**，查 `variableTypes` 拿类名；
 *    **访问符要与变量形态匹配**（值用 `.`、指针用 `->`，交叉一律不弹）
 *  - `Box::` / `ns::`  → 接收者是**类型名**，直接查 `classMembers`；
 *    **宽松给全部成员**（静态 + 非静态 + 方法），不严格只给静态 ——
 *    C++ 里 `static` / `constexpr` / `inline` 变体多，漏掉的困惑比多给的噪音更烦人
 *
 * 共同规则：
 *  - 推不出来就不弹（未声明变量、函数返回值、`std::vector<int>` 这类文件外类型…）；
 *    查不到类定义时**静默不弹** —— 不报错，也不退化成"弹全部"
 *  - 方法用 `method` 类别、说明带括号（`Box::get()`）；字段用 `field` 类别（`Box::value`）
 *  - 说明里标注 `static` 与访问级别（`private: Box::secret`）—— **只标注，不过滤**
 */
function classMemberSymbols(scanned: ScannedCppFile, context: CompletionContext): SymbolInfo[] {
  const receiver = readReceiver(context);
  if (receiver === undefined) {
    return [];
  }

  let className: string | undefined;

  if (context.delimiter === '::') {
    // `Box::` / `ns::`：接收者本身就是类型名（不需要变量表）
    className = receiver;
  } else {
    const type = scanned.variableTypes.get(receiver);
    if (type?.className === undefined) {
      return [];
    }
    const isArrowAccess = context.delimiter === '->';
    if (type.isPointer !== isArrowAccess) {
      return []; // 值用 `.`、指针用 `->`，交叉不弹
    }
    className = type.className;
  }

  if (className === undefined) {
    return [];
  }

  // 先查本文件里扫到的类（含继承链）；查不到再回退到内置清单。
  // 这样用户自己写的同名类天然优先，不需要任何覆盖判断。
  const collected = scanned.classMembers.has(className)
    ? collectMembers(scanned, className, new Set())
    : builtinMembersOf(className);

  return collected.map(({ member, owner }) => ({
    name: member.name,
    // 内置清单会直接给定类别与说明；文件里扫到的成员由 isMethod 推断
    category: member.category ?? (member.isMethod ? 'method' : 'field'),
    detail: member.detail ?? describeMember(member, owner, context.delimiter === '::'),
  }));
}

/**
 * 内置清单里某个类型 / 命名空间的成员（`std::` 这类虚拟目标）。
 *
 * 返回形状与 `collectMembers` 一致（都带 `owner`），调用方不必区分来源。
 * 查不到就返回空数组 —— 调用方据此静默不弹。
 */
function builtinMembersOf(className: string): Array<{ member: CppMember; owner: string }> {
  const members = BUILTIN_CPP_TYPE_MEMBERS.get(className);
  if (members === undefined) {
    return [];
  }
  return members.map((member) => ({ member, owner: className }));
}

/**
 * 收集某个类型（含其基类）的全部成员，**递归 + 防循环**。
 *
 * - 顺序：自己的成员在前、基类在后。派生类覆盖基类同名成员时，
 *   候选池去重会保留先出现的那个（也就是派生类自己的）
 * - 每个成员带**来源类名**，detail 里写这个归属（`Base::move()`）——
 *   一眼能看出它不是派生类自己的成员
 * - **防循环**：`A : B` 且 `B : A`（非法但确实写得出来）靠 `visited` 集合拦住，
 *   否则朴素递归会栈溢出。自继承 `A : A` 同理
 * - 基类不在本文件时 `classMembers` 查不到 → 那一层返回空，**不报错、也不去猜**
 */
function collectMembers(
  scanned: ScannedCppFile,
  className: string,
  visited: Set<string>,
): Array<{ member: CppMember; owner: string }> {
  if (visited.has(className)) {
    return []; // 防循环：这个类已经在继承链上出现过
  }
  visited.add(className);

  const members = scanned.classMembers.get(className);
  if (members === undefined) {
    return [];
  }

  const collected = members.map((member) => ({ member, owner: className }));
  for (const base of scanned.classBases.get(className) ?? []) {
    collected.push(...collectMembers(scanned, base, visited));
  }
  return collected;
}

/**
 * 成员的说明文本。
 *
 * **只标 `private` / `protected`** —— `public` 是「默认可见」，标出来只是噪音
 * （主流 C++ 工具也这么做）。`::` 访问时再补一个 `static` 标注（那是"静态成员"
 * 最容易被问到的场合）：
 *  - `Box::value` / `Box::get()`
 *  - `private: Box::secret`
 *  - `static Box::count` / `private: static Box::count()`
 */
function describeMember(member: CppMember, className: string, annotateStatic: boolean): string {
  const qualified = member.isMethod
    ? `${className}::${member.name}()`
    : `${className}::${member.name}`;
  const staticPrefix = annotateStatic && member.isStatic ? 'static ' : '';
  const accessPrefix =
    member.access !== undefined && member.access !== 'public' ? `${member.access}: ` : '';
  return `${accessPrefix}${staticPrefix}${qualified}`;
}

/**
 * 取成员访问的接收者。
 *
 * 与 C 同一套思路：段里含 `;`（同一行多语句）时贴着访问符往前扫一个标识符；
 * 否则整段就是接收者候选。C++ 多一个访问符 `::`。
 */
function readReceiver(context: CompletionContext): string | undefined {
  const segments = context.previousSegments;
  if (segments.length < 2) {
    return undefined;
  }

  const access = segments[segments.length - 1];
  if (access !== '.' && access !== '->' && access !== '::') {
    return undefined;
  }

  const beforeAccess = segments[segments.length - 2];
  if (beforeAccess.includes(';')) {
    return /([A-Za-z_]\w*)$/.exec(beforeAccess)?.[1];
  }
  return beforeAccess;
}

/** 认领的源文件后缀（`.h` 不在这里 —— 它要看内容） */
const CPP_SOURCE_EXTENSIONS = ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx'];

/**
 * C++ 的分隔符含两个多字符项：`->` 与 `::`（切段支持最长匹配优先）。
 *
 * `memberAccess` 声明三个成员访问符 —— 通用层据此在成员访问语境下**不并入字面量**。
 */
const CPP_STRATEGY: SegmentStrategy = {
  delimiters: ['.', '->', '::', '(', ',', ')'],
  pairs: [['(', ')']],
  memberAccess: ['.', '->', '::'],
};

/**
 * 内容里有没有 C++ 特征。
 *
 * 与 CAdapter 用的是**同一组特征**（各适配器自己实现一份，不共享 ——
 * 判据是各适配器的自主决定，将来 C++ 这边可能还会加 `std::` 之类的特征）。
 */
function looksLikeCpp(text: string): boolean {
  return /\bclass\b/.test(text) || /\bnamespace\b/.test(text) || /\btemplate\b/.test(text) || text.includes('::');
}
