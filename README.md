# MC Cmdline Completion

[English](README.md) | [简体中文](README.zh-CN.md)

Turns VSCode's completion popup into a **Minecraft-style segmented command line**: you type, candidates
pop up, `Tab` walks through them, `Enter` accepts — then you type the next separator yourself and the
next segment's candidates appear.

> **This extension does not run any Minecraft command.** Only the interaction style is borrowed.
> Personal learning project, not a general-purpose completion framework.

<!-- Screenshot placeholder — drop a demo GIF into docs/images/ and uncomment:
![demo](docs/images/demo.gif)
-->

## Supported languages

| Language | What it completes (current file only) |
|---|---|
| **Python** | top-level `def` / `class` / methods / assignments, types inferred from literals, builtins, `s.` members |
| **C** | functions, variables, `struct`, `#define`, `typedef`; `struct` members; ~70 stdlib functions; `NULL` / `EOF` |
| **C++** | classes & namespaces (fields + methods), template arguments stripped, single & multiple inheritance merged recursively, `::` access, access-level annotation, builtin `std` names + `string` / `vector` / `map` methods |

## Core features

- **`Tab` / `Shift+Tab` move the selection** — they do *not* accept, and they do not indent while the
  suggest list is visible. `Enter` accepts (native behaviour, deliberately not intercepted).
- **Segment-by-segment advance** — *you* type the separator (`.`, `(`, `,`, `->`, `::`); candidates
  re-open for the next segment. The engine also reports which argument you are on.
- **Fuzzy matching with ranking** — subsequence scoring, so `pnt` still finds `printf`.
- **One adapter per language** — the shared layer contains **no language judgement**; each adapter only
  scans the file you currently have open.
- **No LSP** — every symbol comes from self-written regex / text scanning. Hard constraint, see CONTRIBUTING.

## Installation

1. Download `mc-cmdline-completion-0.1.0.vsix` from
   [Releases](https://github.com/Sakura-ksgl/mc-cmdline-completion/releases).
2. In VSCode: Extensions panel → `...` (top-right) → **Install from VSIX…** → pick the file.
   Or from a terminal: `code --install-extension mc-cmdline-completion-0.1.0.vsix`
3. **Restart VSCode** (or run `Developer: Reload Window`).

Requires **VSCode ≥ 1.140**.

## Keybindings

| Action | Key | Condition |
|---|---|---|
| Move down | `Tab` | suggest list visible **and** `mcSuggest.tabMovesSelection` on (default) |
| Move up | `Shift+Tab` | same |
| Accept | `Enter` | native — this extension does not intercept it |
| Open manually | `Ctrl+Space` | ⚠️ does nothing at an *empty segment* (right after `name.`), see Known limitations |

Turning `mcSuggest.tabMovesSelection` off restores native `Tab` completely. `Tab` is also native
whenever the suggest list is not visible — **the rebind only applies while it is visible**.

Two self-check commands (Command Palette → search `MC`):

- `MC 补全：查看适配器状态` — which adapter claimed the current file
- `MC 补全：查看光标处的切段结果` — current segment text and range, trigger delimiter, bracket depth, argument index

## Environment requirements

⚠️ **Two settings are required** for C / C++ `struct` / `class` member completion:

```jsonc
// settings.json
"[c]":   { "editor.suggest.showFields": true },
"[cpp]": { "editor.suggest.showFields": true }
```

**Why this is needed** — struct/class members are emitted with the `Field` item kind. Some extensions
push a **language-level default** (`configurationDefaults`) that sets `editor.suggest.showFields: false`
for the `c` / `cpp` scopes. Such a value never shows up in your `settings.json`, and the Settings UI
usually still displays the global default (looks enabled), so it is very hard to notice.

Without them, `origin.` / `cursor->` shows **nothing at all** even though the provider did return field
candidates (the diagnostic log says `最终候选 = 2`). Python is unaffected because its member candidates
use the `Method` kind.

An **explicit user setting wins over any language-level default**, which is why the two lines above fix it.

## Known limitations

Deliberate trade-offs, not bugs.

**Suggestion list**

- The list is **merged, not exclusive** — VSCode shows candidates from other extensions (Pylance,
  clangd, …) alongside ours; we cannot prevent that.
- Our candidates are **filtered a second time by VSCode**, and the final ordering can be overridden by
  native match scores (`sortText` only applies when VSCode considers the scores equal).
- **Hit highlighting is drawn by VSCode only** — `CompletionItem` cannot carry custom highlighting.
- `editor.acceptSuggestionOnEnter` must be `on` — set to `smart`, `Enter` right after `.` / `(` inserts a
  newline instead of accepting. (This extension ships it as a `configurationDefault`.)
- **`Ctrl+Space` at an empty segment does nothing** — right after `name.` / `p->` VSCode does not open
  the widget for "invoke with no input text". Typing the separator triggers it normally.
- **Ordinary completion does not fire when several statements share a line** (`int foo(void); fo`) —
  `;` is not a separator, so the current segment text becomes `"; fo"` and can never prefix-match `foo`.
  Put the next statement on its own line.

**Scanning — all of these under-report; none of them produce false candidates**

- **C**: function-pointer declarations, multi-line anonymous struct typedefs, `//` inside string
  literals, `#if` branches (every branch is scanned, conditions are not evaluated), declarations with
  subscripts (`MyType v[3];`). Member access only recognises **direct variable names**, so `p.v.`,
  `(*p).`, `arr[i].` and function return values complete nothing; nested / anonymous struct fields are
  abandoned wholesale (inner and outer fields cannot be told apart).
- **C++**: single-line class definitions (`class B { int x; };`) yield **no members** — the scanner is
  line-based and leaves the body as soon as the braces close on the same line. Multi-line is fine.
- **C++**: `my::ns::string` is mistaken for the standard `std::string`, because a type name is taken as
  the **last identifier** of the declaration. A same-named class in your own namespace can therefore hit
  the builtin table. Left unfixed on purpose — both fixes are worse than the problem.
- **Python**: no cross-module or cross-function type inference. `s = "hello"` works; `x = some_func()`
  and `x = y` do not (if the type cannot be inferred, nothing is offered).

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)**. The main extension point is **writing a new language
adapter** — the guide covers the `LanguageAdapter` interface, its four methods, how to declare
`languageIds` / `claims` / `delimiters` / `memberAccess`, and how to add acceptance assertions.

Before pushing:

```powershell
npm run compile
npm run verify
```

> `verify` prints `断言总数：N / 279` and **fails if the count does not match** — a silently skipped
> assertion is treated as a failure. So do not look at `FAIL: 0` alone; look at that total too.

## Architecture

Three layers: interaction (`src/interaction/`), completion engine (`src/completion/`), language adapters
(`src/adapter/`). The shared layer holds **no language judgement** — every adapter declares its own
segmentation strategy, its file ownership rule (`claims`) and its symbol scanning.

The full design notes, the 15 hard constraints, and the complete list of trade-offs are in
**[docs/architecture.md](docs/architecture.md)**.

## License

[MIT](LICENSE)
