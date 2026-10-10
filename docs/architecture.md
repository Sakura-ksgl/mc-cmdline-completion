# 架构约束（硬性）

> 这份文档是本项目的「宪法」。改代码之前先读它。
> **任何与它冲突的方案一律作废 —— 包括 AI 助手自己提出来的方案。**
> 如果觉得某条约束让实现变难、想换做法，先问，不要自己换。

## 0. 项目目标

把 VSCode 的代码补全交互，改造成《我的世界》指令输入式的**分段命令行体验**。

```
输入        →  自动弹出候选（随上下文变化）
Tab / ⇧Tab  →  候选列表里上/下移动高亮（不改文本）
Enter       →  落定当前段（原生行为，本扩展不接管）
敲分隔符     →  候选重新弹出，进入下一段
Esc         →  关闭候选，Tab 恢复缩进
```

**本扩展不执行任何 Minecraft 指令**，只是借用它的交互形式。
个人学习项目，不做通用框架，目标是跑通核心体验。

## 1. 硬性约束

| # | 约束 | 说明 |
|---|---|---|
| 1 | **UI 复用 VSCode 原生 suggest 列表** | 不做 Webview 自绘。`Tab`/`Shift+Tab` 抢绑到本扩展的命令，再转发给内置的 `selectNextSuggestion` / `selectPrevSuggestion` |
| 2 | **符号来源必须是自研扫描** | 只走 `LanguageAdapter.scanSymbols()`，正则 / 文本扫描 |
| 3 | **只扫当前打开的文件** | 不扫描工作区其它文件、不建索引。**唯一例外**是适配器内部硬编码的内置清单（Python 内置函数与方法） |
| 4 | **禁止接入 LSP** | 不得调用 `executeDocumentSymbolProvider`、`executeCompletionItemProvider`、`executeWorkspaceSymbolProvider`，以及 semanticTokens / signatureHelp / hover 等任何语言服务命令 |
| 5 | **通用层禁止出现任何语言判断** | `src/completion/`、`src/interaction/`、`src/adapter/registry.ts`、`src/adapter/types.ts` 里不允许出现语言名判断或行为分支。`extension.ts` 只允许**装配引用**（`new XxxAdapter()`），不允许判断。语言知识只能存在于具体适配器目录里 |
| 6 | **切段策略由适配器声明** | 通过 `LanguageAdapter.getSegmentStrategy()`；通用层只调用、不解释返回值含义。`delimiters` 支持**多字符项**（如 C 的 `->`），切段按**最长匹配优先**。⚠️ `delimiters` **不等于**触发字符，见约束 15 |
| 7 | **不要为切段新增抽象层** | 不写 strategy 框架 / 抽象类 / 注册机制，一个描述对象（`SegmentStrategy`）足够 |
| 8 | **改方案先问** | 任何一步觉得「用 LSP 更省事」或遇到模糊需求，先确认，不得自行切换 |
| 9 | **候选入口只有两个** | 只有 `scanSymbols`（符号）与 `getLiterals`（字面量）。命令树候选尚未参与（等做「空格式指令树」时再加） |
| 10 | **Enter 不接管** | 不接管 `Enter`、不自动补分隔符、不自动推进。逐段推进靠**用户手动敲分隔符**触发 |
| 11 | **代码注释一律用中文** | |
| 12 | **一个 languageId 一次注册** | 装配按 **languageId 分组**：每个 languageId 只注册一次 provider，触发字符取该 languageId 下**所有适配器的并集**。**禁止**把所有适配器的 languageId 合成一份 selector、把所有 delimiters 合成一份触发字符。⚠️ **一个 languageId 绝不能被多条注册覆盖** —— VSCode 凡命中的注册都会调用 provider，而每次 `resolve` 都返回同一个适配器，于是**候选成倍**（`.cpp` 候选双倍就是这么来的：CAdapter 声明 `['c','cpp']`、CppAdapter 也声明 `cpp`，`.cpp` 命中两条；而 `.c` / `.py` 各只命中一条所以正常）。`verify.mjs` 有「每个 languageId 只出现一次」与「cpp 只命中一条」两条断言守着 |
| 13 | **不得注册 `languageIds: ['*']` 的适配器** | 兜底适配器一旦注册就会在任何语言里弹候选，让「没有适配器的语言不弹候选」失效。`stubAdapter` 因此不参与装配（文件保留，供 `scripts/verify.mjs` 验证通用层逻辑） |
| 14 | **文件归属判断放在适配器内部** | 装配层拿不到 document 内容（注册是激活时的一次性行为），所以「这个文件归谁」只能由适配器自己判断 —— 通过可选的 `claims(document)` 回答（见第 9 节）。**各适配器的判据必须互斥**，这样 `resolve` 的「第一个匹配赢」就无关紧要，注册顺序不影响结果 |
| 15 | **分隔符 ≠ 触发字符** | **触发字符决定「什么时候叫醒 provider」，分隔符决定「叫醒后怎么切段」**。`delimiters` 可以多字符，但注册给 VSCode 的 `triggerCharacters` **只能单字符** —— 官方语义是「用户敲下的那一个字符」（`only from providers that registered the typed character`），多字符元素会被**静默忽略**。所以通用层取**每个分隔符的末字符**（`'->'`→`'>'`、`'::'`→`':'`，单字符原样保留，且只取末字符以免敲 `-` 也触发）。**适配器不需要自己判断「是否形成了 `->`」** —— 那个判断由切段层给出的 `context.delimiter` 回答。`verify.mjs` 有一条不变量断言守着「触发字符全是单字符」 |

## 2. 分层与职责

```
src/
  extension.ts            激活入口：装配注册表、逐个适配器注册 provider、注册命令
                          —— 只做装配，不含任何语言判断

  adapter/                语言适配层（按语言独立）
    types.ts              LanguageAdapter / CompletionContext / LiteralInfo /
                          SymbolInfo / SegmentStrategy —— 通用层与适配器的契约
    registry.ts           适配器注册表：按 languageId 查表 + 装配信息映射
    stubAdapter.ts        占位适配器（不参与装配，仅用于通用层验证）
    python/
      pythonAdapter.ts    PythonAdapter（阶段 4，范围 B）
      builtins.ts         Python 内置函数 / 内置类型方法清单（硬编码）
    c/                    CAdapter（阶段 5）
      cAdapter.ts         适配器：两层 `.h` 归属判断 + 符号入口
      cScanner.ts         C 扫描（纯逻辑，不依赖 vscode，可脱离宿主验证）
    cpp/      ← 阶段 6    CppAdapter

  completion/             补全引擎层（通用）
    segment.ts            解析调度：按策略切段（纯字符串运算，不依赖 vscode）
    pool.ts               合并候选：符号 + 字面量 → 去重
    matcher.ts            模糊匹配：全局唯一一份，所有语言共用
    provider.ts           出口：串起上面几步并输出 CompletionItem

  interaction/            交互层（通用）
    keymap.ts             Tab / Shift+Tab / 手动触发候选
```

**依赖方向单向向下**：`extension` → `completion` / `interaction` → `adapter` 接口。
通用层永远不 import 具体适配器的实现（装配只发生在 `extension.ts`）。

## 3. 接口契约

### `LanguageAdapter`

```ts
interface LanguageAdapter {
  readonly name: string;                    // 日志与状态展示用
  readonly languageIds: readonly string[];  // 负责的 VSCode languageId

  scanSymbols(document: TextDocument, context: CompletionContext): SymbolInfo[];
  getLiterals(context: CompletionContext): LiteralInfo[];
  getSegmentStrategy(): SegmentStrategy;
}
```

`scanSymbols` 带 `context` 的原因：成员访问（`s.` / `p->`）必须知道「点号左边是什么」
才能只给出对应类型的成员，光有 document 做不到（阶段 4 为 Python 引入，阶段 5 的 C 复用同一机制）。

### `SymbolCategory`（展示类别）

`function` / `method` / `class` / `variable` / `constant` / `field` / `keyword` / `macro` / `other`。

- `macro` 是阶段 5 为 C 的 `#define` 加的 —— 它是**通用类别**，不含语言知识
- `namespace` 是阶段 6 为 C++ 的 `namespace` 加的 —— 同上，纯展示类别（映射到 `Module` 图标）
- VSCode 没有「宏」这个 `CompletionItemKind`，映射成 `Constant` 的图标

### `CompletionContext`（本扩展自己的上下文）

装的是**通用层切段算出来的结果**，作为**只读入参**交给适配器。
适配器只能读、不得修改、不得产生副作用。

⚠️ 别和 `vscode.CompletionContext` 混淆 —— 那是 VSCode 传给 provider 的。

字段：`document`、`position`、`segmentText`、`segmentRange`、`previousSegments`、`depth`、`delimiter`、`argumentIndex`。

> 取成员访问接收者的办法：分隔符自身算一段，所以 `s.` 的 `previousSegments` 是
> `['s', '.']`、`p->` 的是 `['p', '->']` —— 接收者都是**倒数第二段**。

### `LiteralInfo`（字面量）

```ts
{ value: string; label?: string; detail?: string }
```

**语义边界**：字面量不是「任意值都能补」，而是「**这个位置允许的那几个固定值**」。
有定义位置、可跳转的（枚举成员、宏定义）算符号，不算字面量。
Python 给 `True`/`False`/`None`；C 给 `NULL`/`EOF`。

⚠️ **成员访问语境下字面量不参与合并**（通用层按 `memberAccess` 声明判断）——
那个位置允许的是「成员」，不是「值」。少了这条收窄，推不出成员时会退化成弹字面量
（C 的嵌套 struct 位置弹出 `NULL`/`EOF`、Python 的 `name.` 混进 `True`/`False`/`None`）。

### `SegmentStrategy`（切段策略）

同一份结构必须能表达两种形态（**这是要求，不是巧合**）：

```ts
// 语法驱动（当前实现的那一种；delimiters 的每一项可以是多字符）
{ delimiters: ['.', '->', '(', ',', ')'], pairs: [['(', ')']], memberAccess: ['.', '->'] }  // C
{ delimiters: ['.', '(', ',', ')'],       pairs: [['(', ')']], memberAccess: ['.'] }        // Python

// 空格式（只在接口上预留，尚未实现、不读）
{ whitespace: true, delimiters: [] }
```

字段用途：

- `delimiters` + `pairs`：切段（见第 5 节）
- **`memberAccess`**：哪些分隔符表示「成员访问」。通用层据此**收窄候选来源**
  （成员访问语境不合并字面量）。纯数据驱动，通用层不解释语言 ——
  C 是 `['.', '->']`、Python 是 `['.']`、将来 C++ 还要加 `'::'`
- `whitespace` 与 `joinWith` 留待将来（尚未读取）

## 4. 补全引擎的固定链路

`provider.ts` 里顺序固定，不要改：

```
① 解析调度      sliceSegment(当前行, 光标列, 策略)
② 组装上下文    按只读契约拼出 CompletionContext
③ 合并候选      buildPool(scanSymbols(document, context), 字面量)
                └ 成员访问语境（delimiter ∈ strategy.memberAccess）时，字面量取空数组
④ 模糊过滤排序   fuzzyMatch(当前段文本, 候选 label)
⑤ 输出          转成 CompletionItem（range = 当前段范围）
```

**触发字符**由适配器声明的 `delimiters` 汇总而来（`registry.registrations()`），
逐个适配器注册 provider 时传入 —— 不声明的话敲 `(` `,` `.` `->` 之后不会有任何反应。

## 5. 切段规则（语法驱动版）

1. `delimiters` 里的每一项都是段边界，且**自身算一段**。
   每项可以是**多字符**（如 `->`），扫描时按**最长匹配优先** ——
   `p->x` 切出 `p` 与 `->`，不会被拆成 `-` 和 `>`
2. 被分隔符隔开的非空内容各算一段，**首尾空白不计入段内**
3. 当前段 = 最后一个分隔符之后、光标之前的内容
4. `pairs` 用于维护括号深度；`depth > 0` 时，
   「第几个参数」= 当前括号层内已出现的逗号数 + 1（**1-based**）
5. 参数分隔符固定为逗号：只有策略把 `,` 声明为分隔符时才有「第几个参数」的概念
6. `memberAccess` 里声明的分隔符是「成员访问语境」—— 它**不改变切段**，
   只让通用层在合并候选时**不并入字面量**（见第 4 节第 ③ 步）
7. `whitespace`（空格式）尚未读取

自查方式：`npm run verify`，或命令面板里的 `MC 补全：查看光标处的切段结果`。

## 6. Python 适配器（阶段 4，范围 B）

**做：**

1. 扫当前文件：顶层 `def`、顶层 `class`、类内方法、顶层赋值（含 `name: str = "x"` 类型注解形式）
2. 顶层赋值的**直接字面量** → 推断变量类型：`"..."` → str、`123` → int、`1.5` → float、`[...]` → list、`{...}` → dict
3. 内置函数清单硬编码（`print` / `len` / `range` …）
4. 内置类型方法清单硬编码（str / list / dict / int / float）
5. 成员访问语境（`context.delimiter === '.'`）**只给该类型的方法**；推不出类型就什么都不给

**不做：** 不扫工作区与 import 模块；不做函数参数/返回值/变量传递的类型推断；
不做字符串 / 注释识别；方括号 `[` `]` 未进 delimiters。

## 7. C / C++ 适配器（阶段 5 / 6）

### 7.1 归属判断（**文件名优先**，由 `claims` 回答）

CAdapter 声明 `languageIds = ['c', 'cpp']`，`claims(document)` 的判断顺序：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | 文件名以 `.h` 结尾 | **无论 languageId 是 `c` 还是 `cpp`**，都看内容：含 `class` / `namespace` / `template` / `::` 任一 → 让位；否则认领 |
| 2 | 其余文件 | languageId 为 `c`（`.c`）→ 认领；其余（`.cpp` / `.hpp` / `.cc`…）→ 让位，交给阶段 6 的 CppAdapter |

**为什么文件名必须排在第一**：VSCode 内置默认把 `.h` 关联成 `c`，装了 C/C++ 扩展后可能变成 `cpp` ——
所以头文件**不能靠 languageId 区分**。早先把「`languageId === 'c'` → 直接按 C 处理」放在第一层，
导致 languageId 为 `c` 的 `.h` 完全跳过内容判断（C++ 的头文件被当成 C 扫了：
`class Foo {};` 走变量分支产出 `Foo`）。

**归属判断只在 `claims` 里回答一次**（阶段 6 第 2 步的职责归位）：
`scanSymbols` / `getLiterals` **不再自带判断** —— `registry.resolve` 已经用 `claims` 筛过，
只有被认领的文件才会走到它们。于是"让位时不给候选"这个保证比之前更强：
claims 为 false 时 `resolve` 返回 undefined，provider 直接 `return undefined`，连字面量都不会取。

`getSegmentStrategy()` 没有 context、无法按文件变化，但 C 与 C++ 的分隔符一致，无影响。

### 7.2 符号扫描与内置清单

扫当前文件：函数定义/声明、变量定义（含 `int a, b, c;` 多声明）、`struct` 定义、`#define` 宏、单行 `typedef`。
用启发式正则 + 花括号配平，**原则是「宁可漏，不要误报」**（误报污染候选池，漏报只是少几条候选）。
struct 体内的字段**不当作顶层符号**（靠花括号深度识别 struct 体），但会顺手收进字段表。

**内置清单**：C 标准库常用函数（`printf` / `malloc` / `memcpy` / `strlen` …，约 70 个）
硬编码在 `adapter/c/builtins.ts`，作为 `category: 'function'` 的普通符号返回。

- 这是**「只扫当前打开的文件」的唯一例外**，且只存在于适配器内部 —— 通用层不知道有这回事
- 文件里的同名定义排在清单**之前**，所以候选池去重时保留用户自己的定义
- **成员访问语境下不给内置清单**（`origin.` 只给字段）
- 让位的文件（`.cpp` / C++ 的 `.h`）连内置清单也不给

### 7.3 struct 成员访问（阶段 5 第二步，已完成）

`p.` / `p->` 语境（`context.delimiter` 是 `.` 或 `->`）**只给该 struct 的字段**：

| 情况 | 结果 |
|---|---|
| `struct Point origin;` 后 `origin.` | 给 `Point` 的字段（`x` / `y` / `name`） |
| `struct Point *cursor;` 后 `cursor->` | 给 `Point` 的字段 |
| `int count;` 后 `count.` | 不弹（不是 struct 变量） |
| `char *label;` 后 `label.` | 不弹（指针指向的不是 struct） |
| `get_count().` | 不弹（切段后接收者是 `)`，推不出类型） |
| 值变量写 `->` / 指针写 `.` | 不弹（形态不匹配，C 里这么写是错的） |

**C 没有内置方法表，成员完全来自当前文件里的 struct 定义**（这一点与 Python 的硬编码方法表不同）。
字段信息由 `scanCFile` 在扫描时顺手收好（`structFields` / `variableTypes`），
成员访问直接复用，**不重扫文件**。

struct 定义支持的写法：

- 多行：`struct Point {` 换行 `int x;` 换行 `};` —— 逐行收字段
- **单行**：`struct Point { int x; int y; };` —— 把花括号内的内容按 `;` 切分抽字段
- **单行定义并同时声明变量**：`struct Vec { int dx; int dy; } speed;` ——
  字段与 `speed` 的类型都会收好（尾部的声明符单独解析）
- **typedef 内联 struct**：`typedef struct X { … } Y;` —— 字段同时挂在结构体标签与别名下，
  所以 `struct X x; x.` 和 `Y y; y.` 都能补
- **嵌套 / 匿名 struct** 整个放弃：内外层字段分不清，宁可漏不要误报。
  单行嵌套（花括号内含 `{`）和多行嵌套（体内出现 `{`）都放弃

变量类型推断认两种类型写法：`struct Point p;` 直接取标签名；
`VecT v;`（typedef 出来的类型）取类型部分最后一个标识符当**候选**名 ——
它到底是不是 struct，由 `structFields` 表判定，表里没有就不给成员
（所以 `int count;` 的 `count.` 依然不弹）。

### 7.4 字面量

`getLiterals()` 只给 `NULL` 与 `EOF`。不放 `0` / `1` —— 按字面量的既定边界
（「这个位置允许的那几个固定值」），`0`/`1` 是「任意整数」的代表，塞进来只会变成噪音。

### 7.5 C 扫描与成员访问的已知限制

扫描侧（都是「漏报」，不产生误报）：函数指针声明、跨行的匿名 struct typedef
（`typedef struct {` … `} Foo;`）、字符串里含 `//`（会被当行注释截断）、
`#if` 条件编译分支（全部扫，不判断条件）、含下标的非内置类型声明（`MyType v[3];`）。

成员访问侧：只认**直接变量名**，所以 `p.v.`（字段链）、`(*p).`、`arr[i].`、
函数返回值、函数参数一律不弹；嵌套 / 匿名 struct 的字段一律放弃（内外层分不清）。

### 7.6 C++ 适配器（阶段 6）

**骨架与归属（阶段 6 第 3 步，已完成）**：

- `adapter/cpp/cppAdapter.ts`：`CppAdapter`
  - `languageIds = ['cpp']`（只这一个 —— VSCode 里 C++ 文件的 id 就是 `cpp`；
    曾经多声明了一个不是标准值的 `c++`，那是永远不会命中的死注册，已删）
  - `claims`：后缀 `.cpp` / `.cc` / `.cxx` / `.c++` / `.hpp` / `.hh` / `.hxx` → 认领；
    `.h` → **看内容**（含 `class` / `namespace` / `template` / `::` 任一才认领，否则留给 CAdapter）；
    其余后缀 → 不认领（即使语言被手动设成 C++，例如 `notes.txt`）
  - 分隔符含 `->` 与 `::`（多字符，切段按最长匹配优先），`memberAccess = ['.', '->', '::']`
- `adapter/cpp/builtins.ts`：**占位**，返回空（第 6 步实现内置清单）

**类成员扫描与成员访问（第 4.1 + 4.2 小步，已完成）**：

- `adapter/cpp/cppScanner.ts`：扫 `class` / `struct` / `namespace` 的成员，外加顶层函数 / 变量 / `#define`
- `obj.` / `obj->` / `Box::` **只给该类型的成员**；方法与字段**都弹**，区分放在类别与说明上 ——
  方法用 `method` 类别、说明带括号（`Box::get()`）；字段用 `field` 类别（`Box::value`）
- 访问符与变量形态**必须匹配**：值用 `.`、指针用 `->`，交叉一律不弹（`::` 不查变量表）
- **模板剥参数**：`Box<int> boxed;` → 类型名取 `Box`（按尖括号配平剥离，嵌套模板也对）；
  剥完查不到本文件的类定义就**静默不弹**（`std::vector<int> nums;` → 本文件没有 `vector` 的定义）
- **`::` 宽松给全部成员**（静态 + 非静态 + 方法），不严格只给静态 ——
  C++ 里 `static` / `constexpr` / `inline` 变体多，漏掉的困惑比多给的噪音更烦人
- **访问级别不过滤，只在说明里标注**，且**只标 `private` / `protected`** ——
  `public` 是「默认可见」，标出来是噪音（主流 C++ 工具也这么做）。
  类里没写访问标签时**不猜默认值**（既不假设 `class` 默认 private，也不假设 `struct` 默认 public）
- 推不出来就不弹（未声明变量、函数返回值、文件外定义的类型…）

> **⚠️ 两个踩过的坑，别重犯：**
>
> 1. **不能继承 C 的「体内出现 `{` 就放弃嵌套」策略**。C 里 `struct` 体内有 `{` 就等于嵌套，
>    可以直接放弃；但 C++ 的**方法体本身带 `{`**，照搬会误杀所有带方法体的类。
>    所以改用**方法体深度**（`methodBodyDepth`）：进入方法体时记下当时的花括号深度，
>    之后比它更深的行一律跳过 —— 方法名收得下，方法体内部的局部变量不会被当成成员。
>    **嵌套类仍然整个放弃**（内外层分不清）。
> 2. **按逗号切声明符时要跳过尖括号里的逗号**（`splitDeclarators`）。
>    直接 `split(',')` 会把 `Box<int, std::string> m;` 切成两个声明符，
>    于是 `m` 的类型被算成 `string` —— 表现是 `m.` 静默不弹，
>    看起来像"模板没支持"，其实是解析错。

**与 CAdapter 的互斥**：两个 `claims` 是**同一判据的两面** ——
`.h` 上一个要 `!looksLikeCpp`、另一个要 `looksLikeCpp`；非 `.h` 靠后缀集合 + languageId 区分。
所以 `resolve` 的结果与注册顺序无关（前端有断言守着）。

**继承（第 5.1 + 5.2 小步，已完成）**：

- 扫 `class Derived : public Base {` 形式的继承（`public` / `protected` / `private` /
  `virtual` 一律跳过 —— **继承方式不改变"弹不弹"**）
- **递归合并**：`Derived::` / `derived.` 给出自己的成员 **+ 所有基类的成员**，沿继承链逐层往上收
- **多继承**：`class M : public B1, public B2 {` → 两个基类的成员全部合并（各自再递归）。
  按**顶层逗号**切基类，所以 `: public Base<int, char>` 仍算**一个**基类
- **菱形继承**：`D : Left, Right` 且两者都继承 `Root` → `Root` 的成员**只收一次**
  （`visited` 顺带买到的性质，有断言守着）
- **每个成员带来源类名**，detail 里写归属（`Base::move()`、`GrandBase::grand`）——
  一眼能看出它不是派生类自己的
- **防循环**：`A : B` 且 `B : A`、自继承 `A : A`、以及多继承链上的环
  （`A1 : Bx, C1` 且 `Bx : A1`）都靠 `visited` 集合拦住，不会栈溢出 —— 三条断言守着
- **只认当前文件里定义的基类**：`class D : public std::string` 里 `string` 不在本文件 →
  那一层返回空，不弹也不报错。**基类定义缺失时，派生类自己的成员照常弹**（有断言）
- 继承来的 **private 成员照样弹**（与本类规则一致，不过滤），只是 detail 标 `private:`
- 顺序：自己的成员在前，基类按声明顺序在后；同名成员由候选池去重保留先出现的（即派生类自己的）

**内置清单（第 6.1 小步，已完成）**：

- `adapter/cpp/builtins.ts` 硬编码 16 项常用标准库项 —— 这是「只扫当前文件」的**唯一例外**
- **全局项**（短名显示、说明写全名）：`cout` `cin` `cerr` `endl` / `string` `vector` `map` `set`
  `pair` `shared_ptr` `unique_ptr` `size_t` / `move` `swap` `make_unique` `make_shared`。
  类别按性质分：流对象 → `constant`、类型 → `class`、工具函数 → `function`
- **虚拟 `std` 命名空间**：敲 `std::` 弹出同一批项（走 `::` 成员访问分支，复用 4.2 加的机制）
- 文件里的同名定义**排在清单之前**（候选池按 label 去重时保留用户的）

> **设计决定：内置类型表与「文件扫到的类」分开存，查询时「先文件、后内置」。**
> `classMembers` 只装**本文件里真实扫到的类**；内置清单是另一份数据
> （`BUILTIN_CPP_TYPE_MEMBERS`）。查询时先查 `classMembers`，查不到再回退内置 ——
> 好处是①数据来源分明，边界与「内置清单是唯一例外」一致；②用户自己写
> `class string {...}` 时**天然优先**，不需要任何覆盖判断；③查询点只有一处
> （`classMemberSymbols`），回退成本极低。
> **没有**选「启动时把内置类型预填进 `classMembers`」：那会把"扫到的"与"硬编码的"
> 混在一张表里，既说不清来源，又要额外处理覆盖顺序。

**三个容器的方法表（第 6.2 小步，已完成）**：

- 内置表加了三个键：`string`（16 个方法）/ `vector`（14 个）/ `map`（10 个），与虚拟的 `std` 并列
- **适配器零改动** —— 6.1 已经把「先查 `classMembers`、查不到回退内置表」的回退逻辑写好了，
  这一小步只是往数据表里加键

> **键为什么用短名**（`string` 而不是 `std::string`）：类型推断走的是「剥模板参数 →
> 取类型部分**最后一个标识符**」，所以 `std::string s;` 与 `string s;`
> （`using namespace std` 写法）产出的类型名**都是 `string`** —— 一个键同时覆盖两种写法。
> 改成全名键反而会**漏掉短名写法**（它没有前缀可补，而"补前缀"需要一张
> 「哪些短名属于 std」的清单，绕一圈又回到短名键）。
>
> **已知限制**：`my::ns::string s;` 会被取成 `string` 而**误命中内置表**
> （弹出 `std::string` 的方法），违反「宁可漏不误报」。概率极低，**不修** ——
> 两条修法都比问题更糟：引入「限定名」字段等于把键改回全名（连带丢掉短名写法），
> 而「类型部分含 `::` 就不回退」会让 `std::string s;` 也不弹。

**边界**：C++ **暂不提供字面量**（`nullptr` 等，范围里没要求，`getLiterals` 返回空）；
**不做**其它容器（list / deque / unordered_*）、**不做**运算符重载（`operator[]` / `cout <<` 都不是成员函数）。
⚠️ **别往内置表里加 `auto` 键**：`auto a = 1;` 的类型名是 `auto`，现在靠"查不到"实现
「auto 一律不弹」；加了它就会开始乱弹 —— `verify.mjs` 有断言守着键集合。

**已批准的 C++ 范围约束（前四条已落实）**：

- 模板：剥掉 `<…>` 取名字；名字在当前文件查不到 → **静默不弹**，不报错 ✅
- 继承：递归合并基类成员，**必须防循环** + 专门断言守卫 ✅
- `::`：**宽松**给该类的全部成员（静态 + 非静态 + 方法）✅
- 访问修饰符：**不过滤，只标 `private` / `protected`**（`public` 不标）✅
- 内置清单只做 `string` / `vector` / `map` 三个容器 + 常用全局项；
  **不做**其它容器（list / deque / unordered_*）与运算符重载（`cout <<` 不是方法）—— 待第 6 步

## 8. 阶段计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 骨架 + 交互链路 | ✅ 已验收 |
| 2 | 切段 + 算第几个参数 + 合并候选 + 模糊过滤 | ✅ 已验收 |
| 3 | 触发字符收窄（方案 A）+ 接口演进（方案甲） | ✅ 随阶段 4 完成 |
| 4 | `PythonAdapter`（范围 B） | ✅ 已验收 |
| 5 | `CAdapter`：① 符号扫描 ② struct 成员访问 ③ 内置清单与字面量 | ✅ 已验收 |
| 6 | `CppAdapter`（C++）：① 接口演进 ✅ ② CAdapter 职责归位 ✅ ③ 骨架 + 归属 ✅ ④ 类成员扫描（4.1 ✅ 4.2 ✅）⑤ 继承（5.1 ✅ 5.2 ✅）⑥ 内置清单（6.1 ✅ 6.2 ✅） | **全部完成**，待 F5 验收 |
| 7+ | Java 等其它语言 | 未开始 |

## 9. 阶段 6 前置（现在就要知道的结构性事实）

- `registry.resolve(languageId)` 现在是「**第一个匹配的适配器赢**」。
- 阶段 6 需要的是「**同一个 languageId 按文件内容分派给不同适配器**」——
  因为 `.h` 的归属（纯 C vs C++）必须看**内容**才能定，而 `resolve` 只拿到 languageId。
- 现状下的冲突：CAdapter 已声明 `['c', 'cpp']`；CppAdapter 也要处理 `cpp`，
  两个适配器会在同一个 languageId 上**抢**，谁先注册谁赢。

### 9.1 接口设计（已定，待实现）

给 `LanguageAdapter` 加一个**可选**的认领判定：

```ts
interface LanguageAdapter {
  readonly name: string;
  readonly languageIds: readonly string[];

  /**
   * 认领判定：这个适配器要不要处理这个文件。
   * 可选 —— 不实现就等价于「languageIds 里有这个 languageId 就认领」。
   */
  claims?(document: vscode.TextDocument): boolean;

  // …其余成员不变
}
```

`resolve` 随之改签名：

```ts
resolve(document: vscode.TextDocument): LanguageAdapter | undefined {
  const candidates = this.adapters.filter((a) => a.languageIds.includes(document.languageId));
  // 实现了 claims 的用它筛；没实现的视为认领
  return candidates.find((a) => a.claims === undefined || a.claims(document));
}
```

### 9.2 硬性要求：认领判据必须互斥

同一个文件**不能被两个适配器同时认领** —— 判据互斥之后， `find` 的「第一个匹配赢」
就退化成无关紧要的实现细节，**注册顺序不影响结果**。

C / C++ 的互斥靠**同一个判据的两面**：

| 适配器 | `.c` | `.h` 纯 C | `.h` 含 C++ 特征 | `.cpp` / `.hpp` |
|---|---|---|---|---|
| CAdapter | 认领 | **认领**（`.h` 且 `!looksLikeCpp`） | 让位 | 让位 |
| CppAdapter | — | 让位 | **认领**（`.h` 且 `looksLikeCpp`） | **认领** |

**这条不能只靠设计自觉，必须有验收断言守卫** —— 已落实（阶段 6 第 3 步的第二小步）：
用**真实的** CAdapter + CppAdapter 注册在一起，覆盖 `.c` / `.cpp` / 纯 C 的 `.h` / C++ 的 `.h` 四种文件，
断言 ① `resolve` 结果正确 ② 每个文件**恰好被 1 个适配器认领**（不是 0 个也不是 2 个）
③ 注册顺序反转后四种文件的归属完全不变。

### 9.3 连带改动（4 个文件，实际调用点只有 2 个）

| 位置 | 改动 |
|---|---|
| `types.ts` | 契约加可选方法 `claims?` |
| `registry.ts` | `resolve` 签名 `(languageId)` → `(document)`，加认领筛选；**去掉 `'*'` 兜底**（硬约束 13 已禁止注册兜底适配器） |
| `provider.ts` | 调用处 1 行：`resolve(document.languageId)` → `resolve(document)` |
| `extension.ts` | `inspectSegment` 命令里 1 行（`showStatus` 只读 languageId，**不调** `resolve`） |

> 全项目的 `resolve` 调用点**只有 2 个**（provider + `inspectSegment`）。对账时把
> `extension.ts` 数成了 2 处，实测后修正 —— 盘调用点时以 grep 结果为准，别凭印象数。

**顺带一次职责归位**：CAdapter 现在的 `shouldHandle(document)` 由 `claims` 取代，
`scanSymbols` / `getLiterals` 里那两处重复判断随之删掉 ——
「要不要处理这个文件」只在一个地方回答。

### 9.4 交付顺序（硬性）—— ✅ 已完成

> **状态：第 1 步（接口演进）与第 2 步（CAdapter 职责归位）均已完成并验收。**
> 实现与本节设计一致，只多了一点：`resolve` 顺手去掉了 `'*'` 兜底分支（约束 13 早已禁止，
> 它只是死代码）。原始要求存档如下。

**第一步只做接口演进（claims），不碰 CppAdapter**：

1. 改上面那 4 处
2. 把 CAdapter 的 `shouldHandle` 迁到 `claims`，删掉两处重复判断
3. 补互斥性验收断言
4. **F5 验证 C 的全部场景不回归**（struct 成员、同一行多语句、`.h` 归属）

只有第 4 步通过、确认 CAdapter 没被接口演进打断之后，才加 CppAdapter。
否则出问题分不清是「接口演进」还是「新适配器」引入的。

- 这是**既定前置**，不是阶段 5 的负担，但阶段 5 的「文件名优先」这套归属判断**将来会被这套机制取代**。
- **接收者识别的粒度由适配器自己定，通用层不参与**（阶段 5 收尾时定下的分工）：
  - 通用层只负责**切段**，把 `previousSegments` 交给适配器；「谁是成员访问的接收者」是适配器的事
  - 适配器**不能**直接取「倒数第二段」—— 段的粒度由 `delimiters` 决定，而 `;` 与空格都不在
    delimiters 里，同一行多语句会被并进一段（**C**：`struct Vec { … } speed; speed.`；
    **Python**：`y = 1; x.`）
  - 正确做法（实际实现）：**段里含 `;` 时**（说明同一行写了多条语句）贴着访问符往前扫一个标识符；
    **不含 `;` 时整段就是接收者候选** —— 否则字面量接收者（`"abc".`）会被扫没。
    各语言的标识符规则不同，所以这条规则必须留在适配器里（通用层不出现语言知识）
  - 阶段 6 的 C++（`::` 与 `->`）、未来的 Java（`.`）复用同一思路：**改各自适配器里的
    `readReceiver`，通用层一行不动**

## 10. 诊断日志

补全链路的诊断日志由配置 `mcSuggest.debugLog` 控制，**默认关闭**。

打开条件（满足其一）：扩展开发模式（F5 起的 Extension Development Host）、
或用户把 `mcSuggest.debugLog` 设成 `true`。

打出来的内容：切段结果、各级候选条数（`scanSymbols` → `getLiterals` → 合并 → 模糊过滤 → 最终）、
每个候选的 `label` / `range` / `kind` / `filterText`、VSCode 的 wordPattern 认为的「当前词」。

**已知缺口**：条数日志里**没有文件名**，多文件测试时无法区分某行日志来自哪个文件
（曾因此把纯 C `.h` 的日志误当成 C++ `.h` 的，多绕了一轮排查）。要补就是在那一行加个 `document.fileName`。

**异常上报不走这个开关**：`scanSymbols` 抛异常时**永远**打 `console.error`（含堆栈），
然后按「这批符号为空」继续走。

## 11. 已知取舍与限制（不是 bug，是设计代价）

- **候选列表是「合并」的，不是「独占」的**：VSCode 会把多个 provider 的候选合并显示，
  无法阻止其它扩展（Pylance / clangd 等）贡献候选。
- **我们的候选会被原生再筛一遍**，最终排序也可能被原生的匹配分数覆盖
  （`filterText` 目前就用 `label`，`sortText` 只在原生认为同分时生效）。
- **命中高亮只能由原生绘制**：`CompletionItem` 不支持自定义高亮。
- **抢绑 `Tab` 有代价**：候选可见时 `Tab` 不再缩进、也不再接受建议；
  候选不可见时恢复原生行为。可用 `mcSuggest.tabMovesSelection` 关闭。
- **`editor.acceptSuggestionOnEnter` 必须为 `on`**：被设成 `smart` 后，
  在 `(` `,` `.` 之后按 `Enter` 会变成换行而不是落定候选。
- **`)` 也在触发字符里**：因为它是 `delimiters` 的一员。
- **C++ 单行类定义收不到成员**：`class B1 { public: int one; };` 写在一行时，成员一个都收不到
  —— 扫描器逐行处理，进入类体后立刻因为花括号同行闭合而退出。多行写法完全正常。
  这是「宁可漏不误报」的自觉取舍，未修。
- **`my::ns::string` 会被误认为标准库的 `string`**：类型名取的是「类型部分最后一个标识符」，
  所以自定义命名空间里的同名类会误命中内置表（弹出 `std::string` 的方法）。
  概率极低，未修（理由见 7.6）。
- **普通补全在同一行多语句时不弹（阶段 2 起就存在的限制，尚未修）**：
  - 现象：`int foo(void); fo` 光标停在 `fo` 后不弹；把 `fo` 另起一行就正常弹。
  - 原因：`;` 与空格都不在 C 的 delimiters 里，所以**当前段文本**变成 `"; fo"`
    （`;` 不会被 trim 掉，因为它在段首而非空白），拿它做前缀 / 模糊匹配 `foo` 必然失败。
  - 与「接收者粒度」是**两回事**：那个是**接收者识别**（方案 D 已修），
    这个是**当前段文本本身**被污染（未修）。
  - 修的方向：普通补全也从光标往前扫标识符。**但要先评估对其它语言的影响**
    （Python 一行多语句少见，别的语言要逐个看），所以不急着动。
- **手动 `Ctrl+Space` 在「空段」位置不弹候选（VSCode 侧行为，不是本扩展的问题）**：
  - 现象：光标停在 `name.` / `p->` 这类**空段**后面时，手动 `Ctrl+Space` 完全不弹；
    而**敲分隔符自动触发时正常弹**。
  - 原因：VSCode 在「手动 Invoke + 该位置没有任何输入文本」时不打开 suggest widget。
    已用日志证实 provider 侧返回的候选完全正常（条数、过滤、异常、kind 都对）。
  - **排查结论（重要，避免重复排查）：不是 `item.range` 为空导致的。**
    阶段 2 验收通过的 `player(` 场景段范围同样是空 `[7,7)` 却能正常弹出 —— 这个反例直接排除了该假说。
  - 影响：**仅影响手动触发**；主交互路径（敲分隔符自动触发）完全正常。
  - 未来可选方案（**尚未验证**）：空段时改用双 range —— `inserting` 覆盖前一个分隔符、
    `replacing` 保持空、`filterText` 加上分隔符前缀。动手前必须先验证 `inserting`
    是否真的参与「要不要打开 widget」的判断。

## 12. 已知环境依赖

### `editor.suggest.showFields` 必须在 `.c` / `.cpp` 作用域显式为 `true`

- **现象**：C 的 struct 成员访问（`p.` / `p->`）候选**完全不显示**，
  而 provider 侧一切正常（诊断日志显示 `scanSymbols = 2`、`最终候选 = 2`、kind 映射正确）。
- **根因**：有扩展通过**语言级默认值**（`configurationDefaults`）把 `[c]` / `[cpp]` 作用域的
  `editor.suggest.showFields` 压成了 `false`。这类值**不出现在 `settings.json` 里**，
  设置界面通常也只显示全局默认值（看着是勾上的），所以极难发现。
- **定位过程**：把 C 字段候选的 kind 临时从 `Field(4)` 改成 `Method(1)` → 能弹；
  改回 `Field(4)` → 不弹；在用户设置里显式写 `"[c]": { "editor.suggest.showFields": true }`
  → 恢复正常。根因由此锁定。
- **解法**：在用户 `settings.json` 里显式写死（见 README「环境要求」一节）。
- **为什么不改成别的 kind 绕过**：`Field` 语义最正确；而且**每一个** `CompletionItemKind`
  都有对应的 `editor.suggest.show*` 开关（Field→showFields、Variable→showVariables…），
  换 kind 只是换一个同样可能被压的开关，风险并没有降低，还会让图标与语义错位。
- **影响面**：只影响 `.c` / `.cpp` 文件里的 `Field` 类候选
  （即 struct 成员访问）。Python 不受影响 —— 它的成员候选用的是 `Method`。

## 13. 变更规则

1. 新增语言 = 新增一个适配器目录 + 在 `extension.ts` 里 `registry.register(new XxxAdapter())`，
   **通用层零改动**。如果需要改通用层才能接入，说明设计漏了东西，先讨论。
2. 任何引入 LSP 的改动，先问。
3. 改动前先确认它没有违反第 1 节的任何一条。

### 断言维护的四条教训（都真的踩过）

- **描述「目前还没有 X」的断言，必须在加入 X 的那一步同步改掉。**
  第一步留下过一条「字面量为空」的断言，第三步加了 `NULL`/`EOF` 之后它必然失败 ——
  不改就会让「全绿」变成假绿。
- **不要断言整个对象**。曾有一条断言直接比较完整的 `SegmentStrategy`，
  契约一加字段（`memberAccess`）就碎了 —— 要比较具体字段，别图省事比整体。
- **验收脚本必须校验断言总数**。踩过一次：mock document 少了 `fileName`，
  `claims` 抛 `TypeError`，脚本在中间直接终止，后面 13 条断言全没跑 ——
  而**只 grep `FAIL` 的检查方式把「崩溃」读成了「全绿」**。
  现在 `verify.mjs` 末尾会拿实际条数与 `EXPECTED_CHECKS` 对比，不符即判失败。
  **加断言 / 删断言之后必须同步这个常量**；只看 `FAIL: 0` 不算通过。
- **断言要选「语义上真正守恒的量」当锚点**。曾有一条「三个适配器三条装配信息」，
  锚点选的是**适配器数** —— 而装配的正确锚点应该是 **languageId 数**（一个 languageId
  只能注册一次 provider）。结果它不但没发现「`.cpp` 候选双倍」这个 bug，
  还**把错误行为固化成了验收标准**。这和「不要断言整个对象」是同一类问题：
  选锚点前先问一句「这个量在语义上真的守恒吗？」
