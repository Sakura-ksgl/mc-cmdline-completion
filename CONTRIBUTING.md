# Contributing

Thanks for looking at this project. It is a personal learning project, but it is built so that **adding a
language is the only thing you need to do** to extend it.

---

## 1. Getting it running

```powershell
npm install
npm run compile
```

> The npm cache is pinned to `.npm-cache/` inside the project via `.npmrc`, so `npm install` works as-is.

Then open this folder in VSCode and press `F5` — an **Extension Development Host** window opens with the
extension loaded.

---

## 2. Read the hard constraints first

These are not suggestions. A change that violates one of them will be rejected, however convenient it looks.

| # | Constraint |
|---|---|
| 1 | **Reuse VSCode's native suggest list.** No Webview, no custom UI. `Tab` / `Shift+Tab` are rebound to commands that forward to `selectNextSuggestion` / `selectPrevSuggestion`; `Enter` is **not** intercepted |
| 2 | **Symbols come from your own scanning.** Only `LanguageAdapter.scanSymbols()`, regex / text based |
| 3 | **Only the currently open file is scanned.** No workspace index, no other files. The single exception is a hardcoded builtin list kept **inside an adapter's own directory** |
| 4 | **No LSP.** `executeDocumentSymbolProvider`, `executeCompletionItemProvider`, `executeWorkspaceSymbolProvider`, semanticTokens, signatureHelp, hover — all forbidden |
| 5 | **No language judgement in the shared layer.** `src/completion/`, `src/interaction/`, `src/adapter/registry.ts`, `src/adapter/types.ts` must not contain language names or language-dependent branches. `extension.ts` may only contain assembly references (`new XxxAdapter()`) |
| 6 | **The segmentation strategy is declared by the adapter** via `getSegmentStrategy()`. `delimiters` may be multi-character (`->`, `::`); segmentation uses longest-match-first |
| 7 | **Do not add an abstraction layer for segmentation.** One plain description object (`SegmentStrategy`) — no strategy classes or frameworks |
| 8 | **Deciding "which adapter handles this file" belongs inside the adapter** (`claims(document)`). Adapters' rules must be **mutually exclusive**, so registration order never matters |
| 9 | **Only two candidate entry points**: `scanSymbols` (symbols) and `getLiterals` (literals) |
| 10 | **One registration per languageId.** Never register the same `languageId` twice — every matching registration gets invoked, which multiplies candidates |
| 11 | **Delimiters are not trigger characters.** `delimiters` may be multi-character, but `triggerCharacters` handed to VSCode **must be single characters**; the shared layer maps each delimiter to its **last character** (`'->'` → `'>'`) |
| 12 | **Do not register an adapter with `languageIds: ['*']`** — it would pop candidates in every language |
| 13 | **Comments in this repository are written in Chinese.** Keep that convention |
| 14 | **Ask before switching approach.** If something looks like it needs an LSP or a rewritten strategy, raise it first |

---

## 3. Writing a new language adapter

### 3.1 The interface

```ts
// src/adapter/types.ts
export interface LanguageAdapter {
  /** Shown in logs and status output. */
  readonly name: string;
  /** VSCode languageIds this adapter can serve. */
  readonly languageIds: readonly string[];

  /** Optional. Return false to decline a file. Omit it to accept every file with a matching languageId. */
  claims?(document: vscode.TextDocument): boolean;

  /** Your own symbol scan. Only read the document you are given. */
  scanSymbols(document: vscode.TextDocument, context: CompletionContext): SymbolInfo[];

  /** The few fixed values allowed *at this position* — not "any literal". */
  getLiterals(context: CompletionContext): LiteralInfo[];

  /** How to cut the current line into segments. */
  getSegmentStrategy(): SegmentStrategy;
}
```

That is four methods, and **only one of them is optional**.

### 3.2 Declaring `languageIds`

List every languageId you can serve:

```ts
readonly languageIds = ['python'];
```

If you need to serve the *same* languageId as another adapter (the way `CAdapter` also claims `cpp` so it
can take pure-C header files), that is fine — see the next point.

### 3.3 Declaring `claims` (file ownership)

`claims` answers "do I want this file", and it is the **only** place that question is answered.

```ts
claims(document: vscode.TextDocument): boolean {
  if (document.fileName.toLowerCase().endsWith('.h')) {
    return !looksLikeCpp(document.getText());
  }
  return document.languageId === 'c';
}
```

Rules:

- **Your rule must be mutually exclusive with every other adapter's rule.** When two adapters both
  declare the same languageId, the registry resolves by "first match wins" — and exclusivity is what makes
  that harmless, so **registration order never changes the outcome**.
- Once you implement `claims`, **do not repeat the check inside `scanSymbols` / `getLiterals`**. The
  registry already filtered; a declined file never reaches your adapter at all.
- `verify.mjs` has a mutex guard: it asserts that every test file is claimed by **exactly one** adapter,
  and that reversing registration order changes nothing. Keep it passing.

### 3.4 Declaring `getSegmentStrategy`

```ts
const STRATEGY: SegmentStrategy = {
  delimiters: ['.', '(', ',', ')'],   // may contain multi-character entries, e.g. '->' or '::'
  pairs: [['(', ')']],                // used for bracket depth and "which argument am I on"
  memberAccess: ['.'],                // delimiters that mean "member access"
};
```

- `delimiters` are **also segments themselves**: `foo(` cuts into `foo` and `(`.
- `memberAccess` is what tells the shared layer to **stop merging literals** at that position. Without it,
  a member position with no resolvable type degenerates into offering literals (`NULL` / `EOF` in C,
  `True`/`False`/`None` in Python).
- Do **not** add a strategy class or a registration mechanism. One object is enough.
- Trigger characters are derived from `delimiters` automatically — each delimiter contributes its **last
  character**. You never pass `triggerCharacters` yourself.

### 3.5 Implementing `scanSymbols`

```ts
scanSymbols(document: vscode.TextDocument, context: CompletionContext): SymbolInfo[] {
  const scanned = scanMyLanguage(document.getText());

  // Member access: only members of the resolved type
  if (context.delimiter !== undefined && MEMBER_DELIMITERS.includes(context.delimiter)) {
    return memberSymbols(scanned, context);
  }

  // Ordinary position: file symbols first, then your builtin list —
  // the pool dedupes by label keeping the first, so the user's own definitions win.
  return [...scanned.symbols, ...BUILTIN_SYMBOLS];
}
```

**Guidance drawn from the three existing adapters:**

- **"Can't infer it → offer nothing."** Never fall back to "show everything". A silent empty result is
  correct; a wrong candidate list is not.
- **Scan once, reuse.** Collect fields / member tables / variable types in a single pass over the text and
  answer member queries from that, instead of rescanning.
- **Prefer under-reporting to false candidates.** The existing scanners are written this way on purpose.
- `context.delimiter` is already resolved: for `p->x` it is `'->'`, not `'-'` or `'>'`.
- Member access has to figure out the **receiver** itself. Do not blindly take "the second-to-last
  segment" — segment granularity depends on `delimiters`, so `struct V {…} speed; speed.` puts the whole
  line into one segment. The existing adapters instead scan backwards from the access operator for an
  identifier when the segment contains `;`.

### 3.6 Implementing `getLiterals`

Literals mean **"the few fixed values allowed at this position"**, not "any literal":

```ts
const LITERALS: LiteralInfo[] = [
  { value: 'NULL', detail: 'C 空指针常量' },
  { value: 'EOF', detail: '文件结束标志（stdio.h）' },
];
```

If a value has a definition site you could jump to (enum members, macros), it is a **symbol**, not a literal.

### 3.7 Study the three existing adapters

| Adapter | Shows you |
|---|---|
| `src/adapter/python/` | literal-based type inference, a builtin function list, member access limited to the inferred type |
| `src/adapter/c/` | line-based struct scanning (including inline definitions), field tables, the "abandon nested structs" trade-off |
| `src/adapter/cpp/` | class + namespace members, template argument stripping, recursive inheritance merging with cycle protection, a builtin type/member table lookup |

`src/adapter/cpp/cppScanner.ts` is the most instructive for stateful scanning: it tracks brace depth, class
bodies, **method-body depth** (a method body contains `{`, so "a `{` inside the body means nesting" — which
works for C structs — would kill every class that has methods), and the current access section.

### 3.8 Assembling

Add one line in `src/extension.ts`:

```ts
registry.register(new MyLanguageAdapter());
```

The shared layer needs **no other change**. If you find yourself needing to change the shared layer to
support your language, something is wrong with the design — raise it first.

---

## 4. Adding acceptance assertions

`npm run verify` runs `scripts/verify.mjs`, a dependency-free Node script. It imports the **compiled**
output from `out/`, so always `npm run compile` first.

Add assertions near the section for your language:

```js
check('普通语境包含内置全局项 cout', namesIn(source, {}).includes('cout'), true);
check(
  'Box<int> boxed. → 剥参数后查到 Box',
  JSON.stringify(memberNamesIn(source, ['boxed', '.'], '.')),
  JSON.stringify(['value', 'get']),
);
```

Three rules learned the hard way:

1. **Bump `EXPECTED_CHECKS`.** The script compares the actual assertion count against that constant and
   **fails on mismatch**. This exists because a crash mid-script once made 13 assertions silently not run —
   and "grep FAIL" reported a clean run.
2. **Never assert on a whole object.** Compare specific fields. One assertion that compared a complete
   `SegmentStrategy` broke the moment a field was added to the contract.
3. **Pick an anchor that is genuinely invariant.** An assertion written as "3 adapters → 3 registrations"
   anchored on *adapter count*, while the real invariant is *languageId count*. It did not catch a real
   bug and it enshrined the buggy behaviour as the acceptance standard. Ask: *is this quantity actually
   conserved?*

Also update assertions that describe **"X is not implemented yet"** in the same change that implements X.

---

## 5. Manual verification (F5)

Before pushing, press `F5` and walk through the relevant section.

**General interaction and segmentation**

1. Run `MC 补全：查看光标处的切段结果` — prints segment text, range, trigger delimiter, bracket depth, argument index.
2. Type `foo(a, b, c)`, put the cursor after `b` → argument index should be `2`.
3. Type `p->x`, put the cursor after `x` → the trigger delimiter should be `->` (one multi-character unit).

**Python** (in a `.py` file)

4. Type `pl` → builtin functions (`print` …) plus definitions starting with `pl` in the file.
5. After `name = "hello"`, type `name.` on the next line → only `str` methods; no file functions, no builtins.
6. After `result = compute()`, type `result.` → **no candidates** (type cannot be inferred).
7. Open a `.md` / `.txt` file and type `.` / `(` → **no candidates from this extension at all**.

**C** (in a `.c` file)

8. Type `pri` → C standard library functions (`printf` …) plus matching definitions in the file.
9. With `struct Point { int x; int y; };` and `int count;`, type `co` → `count` should appear.
10. Inline struct definitions work too — all three spellings should offer `dx` / `dy`:
    - `struct Vec { int dx; int dy; };` plus `struct Vec speed;` on another line
    - `struct Vec { int dx; int dy; } speed;` (definition and variable on one line)
    - `typedef struct Node { int key; } Node;` plus `struct Node head;` or `Node head2;`

    Multiple statements on one line must work as well: `struct Vec { int dx; int dy; } speed; speed.` →
    after `speed.`, `dx` / `dy` appear (the receiver is found by scanning back from the access operator,
    so segment granularity from `;` does not matter).
11. Member access: after `struct Point origin;` type `origin.` → `x` / `y` (with the **Field** icon);
    after `struct Point *cursor;` type `cursor->` → same fields. But `int count;` + `count.` and
    `char *label;` + `label.` → **nothing**. After a **nested** struct
    (`struct Outer { struct Inner { int deep; } inner; };`) type `o.` → **not a single candidate**
    (in particular no `NULL` / `EOF`: member positions do not merge literals). Python's
    `result = compute()` + `result.` must likewise not offer `True` / `False` / `None`.
12. Precondition: the two `showFields` settings from the README must be present, or step 11 shows nothing.
13. `.h` ownership: in a `.h` file run `MC 补全：查看适配器状态` and check the languageId. A pure-C `.h`
    should complete normally; a `.h` containing `class` / `namespace` / `template` / `::` should not.

---

## 6. Before you push

```powershell
npm install
npm run compile
npm run verify     # must print 断言总数：N / 278 with no failures
```

If you touched packaging:

```powershell
npx --yes @vscode/vsce package
npx --yes @vscode/vsce ls      # review what actually goes into the .vsix
```

`package.json` must keep its `repository` field — `vsce` refuses to package when a README contains
relative links and no repository is known.

Also review `.vscodeignore`: it is a **denylist**, so anything not listed gets packaged. New top-level
files that are not part of the extension (screenshots, scratch files, logs) must be added there.
