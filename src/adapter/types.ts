import type * as vscode from 'vscode';

/**
 * 符号类别。
 *
 * 只用于给候选配图标和派生默认排序权重 —— 通用层不会根据它反推语言，
 * 也不允许在通用层写「某某语言该用什么类别」这类判断。
 */
export type SymbolCategory =
  | 'function'
  | 'method'
  | 'class'
  | 'variable'
  | 'constant'
  | 'field'
  | 'keyword'
  /** 宏（如 C 的 `#define`）。纯展示类别，不含任何语言知识 */
  | 'macro'
  /** 命名空间（如 C++ 的 `namespace ns {}`）。同上，纯展示类别 */
  | 'namespace'
  | 'other';

/** `LanguageAdapter.scanSymbols()` 的产物：当前文件里扫到的一个定义。 */
export interface SymbolInfo {
  /** 符号名，默认也是候选的落定文本 */
  name: string;
  category: SymbolCategory;
  /** 右侧说明，例如 `def parse(text)` 或 `class Parser` */
  detail?: string;
  /** 定义所在行（0-based），用于稳定排序 */
  line?: number;
}

/**
 * 本扩展自己的「补全上下文」。
 *
 * 别和 `vscode.CompletionContext` 混淆：那个是 VSCode 传给 provider 的
 * （只有 triggerKind / triggerCharacter），适配器碰不到也不该碰。
 * 这里装的是**通用层切段算出来的结果**，作为只读入参交给适配器。
 *
 * 硬性约定：适配器只能读，不得修改，不得产生副作用。
 */
export interface CompletionContext {
  /** 当前打开的文件（只读用途） */
  readonly document: vscode.TextDocument;
  /** 光标位置 */
  readonly position: vscode.Position;

  /** 当前段已输入的文本（从段首到光标，已去掉首尾空白） */
  readonly segmentText: string;
  /** 当前段在文档中的替换范围，与 segmentText 对应 */
  readonly segmentRange: vscode.Range;

  /** 当前段之前的各段，按出现顺序；分隔符自身也各算一段 */
  readonly previousSegments: readonly string[];
  /** 光标处的括号深度，0 表示不在任何括号内 */
  readonly depth: number;
  /** 触发当前段的那个分隔符；行首或没有分隔符时为 undefined */
  readonly delimiter?: string;
  /** 第几个参数（1-based）；不在括号内时为 undefined */
  readonly argumentIndex?: number;
}

/**
 * `LanguageAdapter.getLiterals()` 的产物：一个「当前上下文可插入的固定值」。
 *
 * 语义边界要注意：不是「任意数字都能补」，而是「**这个位置允许的那几个值**」。
 * 有定义位置、可跳转的（枚举成员、宏定义）算符号，不算字面量。
 */
export interface LiteralInfo {
  /** 实际插入的值 */
  value: string;
  /** 列表中展示的文本；缺省时用 value */
  label?: string;
  /** 右侧说明 */
  detail?: string;
}

/**
 * 切段策略：由适配器自己声明「怎么切段」，通用层只读取字段、不解释其含义。
 *
 * 同一份结构要能表达两种形态（这是硬性要求，不许退回成只支持一种）：
 *  - 语法驱动：`delimiters = ['.', '(', ',']`，`pairs = [['(', ')']]`
 *  - 空格式：  `whitespace = true`，`delimiters = []`
 *
 * 要求简单：就是一个描述对象，不要为它新增 strategy 抽象类或框架。
 *
 * 阶段 2 只读 `delimiters` 和 `pairs`；`whitespace`（空格式）留待将来做
 * 「空格式指令树」时才实现，现在既不读、也不实现。
 */
export interface SegmentStrategy {
  /**
   * 段边界字符。这些字符**自身也各算一段**：
   * 例如 `foo(` 应切出 `foo` 与 `(`，当前段是 `(` 之后的空段。
   */
  delimiters?: string[];
  /** 空白是否也算段边界（空格式指令用）—— 阶段 2 不读 */
  whitespace?: boolean;
  /** 成对括号，用于判断「光标在第几个参数」 */
  pairs?: Array<[string, string]>;
  /**
   * 哪些分隔符表示「成员访问」（C：`.` 与 `->`；Python：`.`；将来 C++ 还有 `::`）。
   *
   * 通用层用它**收窄候选来源**：处于成员访问语境时**不合并字面量** ——
   * 字面量表达的是「这个位置允许的固定值」，而成员访问位置允许的是**成员**，不是值。
   * 没有这个声明时，推不出成员会退化成弹字面量
   * （例：C 的嵌套 struct 位置会弹 `NULL` / `EOF`；Python 的 `name.` 会混进 `True`/`False`/`None`）。
   *
   * 这是数据驱动的通用能力，通用层只读它、不解释语言。
   */
  memberAccess?: string[];
  /** 落定一段后自动补上的连接符，例如 `,` 或 `.` —— 阶段 2 不读 */
  joinWith?: string;
}

/**
 * 语言适配器接口。每个目标语言一个实现；
 * 通用层只通过这个接口工作，不做任何语言判断。
 */
export interface LanguageAdapter {
  /** 适配器名字，仅用于日志与状态展示 */
  readonly name: string;
  /** 负责的 VSCode languageId；含 `'*'` 表示兜底适配器 */
  readonly languageIds: readonly string[];

  /**
   * 认领判定：这个适配器要不要处理这个文件。
   *
   * **可选** —— 不实现就等价于「`languageIds` 里有这个 languageId 就认领」。
   *
   * 实现了它的适配器必须让判据**互斥**（同一个文件不能被两个适配器同时认领）：
   * 判据互斥之后，`registry.resolve` 的「第一个匹配赢」就退化成无关紧要的实现细节，
   * **注册顺序不影响结果**。
   *
   * 这是**接口能力**，不是语言知识 —— 判据由各适配器自己实现，通用层只调用。
   */
  claims?(document: vscode.TextDocument): boolean;

  /**
   * 自研符号扫描。硬性约束：
   *  - 只读传入的这一个 document，禁止扫描工作区其它文件；
   *  - 禁止调用任何 LSP 相关命令（`executeDocumentSymbolProvider` 等）；
   *  - 纯文本 / 正则扫描，同步返回。
   *
   * 阶段 4 起多带一个 `context`：成员访问（`s.` / `"abc".`）这类场景必须知道
   * 「点号左边是什么」才能只给出对应类型的成员，光有 document 做不到。
   * 这是范围 B 逼出来的必要演进，不是重构。
   *
   * 内置清单（Python 内置函数、内置类型方法）是「只扫当前打开的文件」的**唯一**例外。
   */
  scanSymbols(document: vscode.TextDocument, context: CompletionContext): SymbolInfo[];

  /**
   * 当前上下文可插入的固定值集合。
   *
   * 名字容易引起误解：它不是「所有字面量」，而是「**这个位置**允许的那几个固定值」，
   * 例如某参数要求 1–10 时返回 1…10，而不是「什么数字都弹」。
   *
   * 阶段 2 只新增这一个入口，不会再有别的候选入口（命令树候选不参与阶段 2）。
   *
   * 硬性约束：入参只读、不修改 context、无副作用、同步返回。
   */
  getLiterals(context: CompletionContext): LiteralInfo[];

  /** 声明本语言怎么切段。通用层只调用，不关心具体是哪一种形态。 */
  getSegmentStrategy(): SegmentStrategy;
}
