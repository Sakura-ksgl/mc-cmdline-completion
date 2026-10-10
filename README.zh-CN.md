# MC Cmdline Completion

[English](README.md) | [简体中文](README.zh-CN.md)

把 VSCode 的补全弹窗改造成**《我的世界》指令输入式的分段命令行**：你打字，候选弹出，`Tab` 在候选间
移动，`Enter` 落定 —— 然后你**自己**敲下一个分隔符，下一段的候选接着弹出。

> **本扩展不执行任何 Minecraft 指令**，只借用它的交互形式。个人学习项目，不做通用补全框架。

<!-- 截图占位 —— 把演示 GIF 放进 docs/images/ 后取消注释：
![演示](docs/images/demo.gif)
-->

## 支持的语言

| 语言 | 补全什么（**只扫当前打开的文件**） |
|---|---|
| **Python** | 顶层 `def` / `class` / 类内方法 / 顶层赋值；从字面量推断类型；内置函数；`s.` 成员 |
| **C** | 函数、变量、`struct`、`#define`、`typedef`；`struct` 成员；约 70 个标准库函数；`NULL` / `EOF` |
| **C++** | 类与命名空间（字段 + 方法）；模板剥参数；单继承与多继承递归合并；`::` 访问；访问级别标注；内置 `std` 常用项 + `string` / `vector` / `map` 方法表 |

## 核心特性

- **`Tab` / `Shift+Tab` 移动选择** —— 它们**不**接受候选，候选可见时也不缩进。`Enter` 落定
  （原生行为，本扩展刻意不接管）。
- **逐段推进** —— 分隔符（`.`、`(`、`,`、`->`、`::`）由**你自己**敲，敲完下一段的候选会重新弹出。
  引擎还会告诉你光标处在「第几个参数」。
- **模糊匹配 + 命中排序** —— 子序列打分，所以 `pnt` 也能找到 `printf`。
- **一个语言一个独立适配器** —— 通用层**不含任何语言判断**；每个适配器只扫你当前打开的那个文件。
- **不接 LSP** —— 所有符号都来自自研的正则 / 文本扫描。这是硬约束，详见 CONTRIBUTING。

## 安装

1. 从 [Releases](https://github.com/Sakura-ksgl/mc-cmdline-completion/releases) 下载
   `mc-cmdline-completion-0.1.0.vsix`。
2. 在 VSCode 里：扩展面板 → 右上角 `...` → **从 VSIX 安装…** → 选那个文件。
   或在终端里：`code --install-extension mc-cmdline-completion-0.1.0.vsix`
3. **重启 VSCode**（或执行 `Developer: Reload Window`）。

需要 **VSCode ≥ 1.140**。

## 快捷键

| 操作 | 按键 | 条件 |
|---|---|---|
| 下移候选 | `Tab` | 候选列表可见 **且** `mcSuggest.tabMovesSelection` 为真（默认） |
| 上移候选 | `Shift+Tab` | 同上 |
| 落定候选 | `Enter` | 原生行为 —— 本扩展不接管 |
| 手动弹出 | `Ctrl+Space` | ⚠️ 在**空段**位置（如 `name.` 之后）不弹，见「已知限制」 |

关掉 `mcSuggest.tabMovesSelection` 后 `Tab` 完全恢复原生。候选列表不可见时 `Tab` 也是原生行为 ——
**抢绑只在候选可见时生效**。

两个自查命令（命令面板 → 搜 `MC`）：

- `MC 补全：查看适配器状态` —— 当前文件被哪个适配器认领
- `MC 补全：查看光标处的切段结果` —— 当前段文本与范围、触发分隔符、括号深度、第几个参数

## 环境要求

⚠️ **必须显式打开两条设置**，否则 C / C++ 的 `struct` / `class` 成员补全不弹：

```jsonc
// settings.json
"[c]":   { "editor.suggest.showFields": true },
"[cpp]": { "editor.suggest.showFields": true }
```

**为什么需要** —— struct / class 成员用的是 `Field` 这个候选类别。某些扩展会通过**语言级默认值**
（`configurationDefaults`）把 `c` / `cpp` 作用域下的 `editor.suggest.showFields` 压成 `false`。
这种值**不会出现在你的 `settings.json` 里**，设置界面通常也只显示全局默认值（看起来是勾上的），
所以极难察觉。

不改会怎样：`origin.` / `cursor->` 候选**完全不显示** —— provider 明明返回了字段候选
（诊断日志里写 `最终候选 = 2`），屏幕上什么都不弹。Python 不受影响，因为它的成员候选用 `Method` 类别。

**显式的用户设置会盖过任何语言级默认值**，所以上面两行能解决问题。

## 已知限制

都是自觉的设计取舍，不是 bug。

**候选列表**

- **候选列表是「合并」而非「独占」的** —— VSCode 会把本扩展的候选与其它扩展（Pylance / clangd …）
  的候选一起显示，我们无法阻止。
- **我们自己筛出的候选会被原生再筛一遍**，最终排序也可能被原生的匹配分数覆盖
  （`sortText` 只在 VSCode 认为同分时才生效）。
- **命中高亮只能由 VSCode 绘制** —— `CompletionItem` 不支持自定义高亮。
- **`editor.acceptSuggestionOnEnter` 必须为 `on`** —— 设成 `smart` 后，在 `.` / `(` 之后按 `Enter`
  会变成换行而不是落定候选。（本扩展把它作为 `configurationDefault` 带上了。）
- **`Ctrl+Space` 在空段位置不弹** —— 光标停在 `name.` / `p->` 之后时，VSCode 在「手动触发 + 该位置
  无输入文本」下不会打开候选窗。敲分隔符自动触发完全正常。
- **普通补全在同一行多语句时不弹**（`int foo(void); fo`）—— `;` 不是分隔符，所以当前段文本变成
  `"; fo"`，永远无法前缀匹配 `foo`。把下一条语句另起一行即可。

**扫描侧 —— 以下全部是「漏报」，不会产生错误候选**

- **C**：函数指针声明、跨行的匿名 struct typedef、字符串里含 `//`、`#if` 条件分支（所有分支都扫，
  不判断条件）、含下标的自定义类型声明（`MyType v[3];`）。成员访问**只认直接变量名**，所以
  `p.v.`、`(*p).`、`arr[i].`、函数返回值都不弹；**嵌套 / 匿名 struct 的字段一律放弃**
  （内外层分不清）。
- **C++**：**单行类定义收不到成员** —— `class B { int x; };` 写在一行时一个成员都收不到，
  因为扫描器是逐行的，花括号同行闭合就立刻退出了类体。多行写法完全正常。
- **C++**：`my::ns::string` 会被误认为标准库的 `std::string` —— 类型名取的是类型部分**最后一个
  标识符**，所以自定义命名空间里的同名类会误命中内置表。**有意不修**：两条修法都比问题更糟。
- **Python**：不做跨模块 / 跨函数的类型推断。`s = "hello"` 可以；`x = some_func()` 与 `x = y`
  不行（推不出来就不补）。

## 参与开发

见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。主要扩展点是**写一个新语言适配器** —— 那份指南覆盖了
`LanguageAdapter` 接口、它的四个方法、`languageIds` / `claims` / `delimiters` / `memberAccess`
怎么声明，以及怎么写验收断言。

提交前跑：

```powershell
npm run compile
npm run verify
```

> `verify` 会打印 `断言总数：N / 279`，**数字对不上就判失败** —— 有断言被静默跳过也算失败。
> 所以别只看 `FAIL: 0`，也要看那个总数。

## 架构

三层：交互（`src/interaction/`）、补全引擎（`src/completion/`）、语言适配器（`src/adapter/`）。
通用层**不含任何语言判断** —— 每个适配器自己声明切段策略、文件归属规则（`claims`）与符号扫描。

完整的设计说明、15 条硬约束、以及全部取舍清单在 **[docs/architecture.md](docs/architecture.md)**。

## 许可证

[MIT](LICENSE)
