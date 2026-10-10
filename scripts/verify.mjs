// 验收脚本：直接跑编译产物里的纯逻辑（切段 / 模糊匹配 / 候选合并）。
//
// 用法：npm run compile && npm run verify
//
// 这些逻辑刻意不依赖 vscode 模块（切段是纯字符串运算），所以能脱离扩展宿主验证。
// 交互手感（Tab / Enter / 候选弹窗）无法在这里验证，必须 F5 手动测。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sliceSegment } = require('../out/completion/segment.js');
const { fuzzyMatch } = require('../out/completion/matcher.js');
const { buildPool } = require('../out/completion/pool.js');
const { createStubAdapter } = require('../out/adapter/stubAdapter.js');

const adapter = createStubAdapter();
const strategy = adapter.getSegmentStrategy();

let failed = 0;
/** 断言总数：末尾会校验，防止「某条断言抛异常导致后面全没跑，却仍然显示全绿」 */
let checkCount = 0;
function check(name, actual, expected) {
  checkCount++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`      期望: ${JSON.stringify(expected)}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
    failed++;
  }
}

/** 把切段结果压成便于断言的形状（undefined 统一成 null，否则 JSON 比较会失真）。 */
function shape(line, offset, customStrategy) {
  const slice = sliceSegment(line, offset, customStrategy ?? strategy);
  return {
    text: slice.text,
    range: [slice.start, slice.end],
    before: slice.before,
    depth: slice.depth,
    delimiter: slice.delimiter ?? null,
    argument: slice.argumentIndex ?? null,
  };
}

console.log('--- 切段（阶段 2 验收场景）---');

// 场景 1：空场景 / 无分隔符
check('场景1a 空行行首 → 空段', shape('', 0), {
  text: '', range: [0, 0], before: [], depth: 0, delimiter: null, argument: null,
});
check('场景1b 整行没有分隔符 → 整行作为当前段', shape('player', 6), {
  text: 'player', range: [0, 6], before: [], depth: 0, delimiter: null, argument: null,
});

// 场景 2：单分隔符 foo(
check('场景2 foo( 光标在 ( 之后 → 切出 foo 和 (', shape('foo(', 4), {
  text: '', range: [4, 4], before: ['foo', '('], depth: 1, delimiter: '(', argument: 1,
});

// 场景 3：多参数 foo(a, b, c)
check('场景3 foo(a, b, c) 光标在 b 之后 → 第 2 个参数', shape('foo(a, b, c)', 8), {
  text: 'b', range: [7, 8], before: ['foo', '(', 'a', ','], depth: 1, delimiter: ',', argument: 2,
});
check('场景3b 光标在 c 之后 → 第 3 个参数', shape('foo(a, b, c)', 11), {
  text: 'c', range: [10, 11], before: ['foo', '(', 'a', ',', 'b', ','], depth: 1, delimiter: ',', argument: 3,
});

// 场景 4：成员访问 obj.met
check('场景4 obj.met 光标在 met 之后 → 当前段 met', shape('obj.met', 7), {
  text: 'met', range: [4, 7], before: ['obj', '.'], depth: 0, delimiter: '.', argument: null,
});

// 场景 5：落定 player 后手动敲 (（VSCode 会自动补上右括号）
check('场景5 player() 光标在括号内 → 进入下一段', shape('player()', 7), {
  text: '', range: [7, 7], before: ['player', '('], depth: 1, delimiter: '(', argument: 1,
});

// 边界补充
check('边界 逗号后的空格不混进段文本', shape('foo(a,  b', 9), {
  text: 'b', range: [8, 9], before: ['foo', '(', 'a', ','], depth: 1, delimiter: ',', argument: 2,
});
check('边界 嵌套括号 → 深度 2、内层第 2 个参数', shape('foo(bar(a, b', 12), {
  text: 'b', range: [11, 12], before: ['foo', '(', 'bar', '(', 'a', ','], depth: 2, delimiter: ',', argument: 2,
});
check('边界 右括号收尾 → 深度回落、不再有参数序号', shape('foo(a)', 6), {
  text: '', range: [6, 6], before: ['foo', '(', 'a', ')'], depth: 0, delimiter: ')', argument: null,
});
check('边界 策略里没声明的括号字符当普通字符处理', shape('arr[0', 5), {
  text: 'arr[0', range: [0, 5], before: [], depth: 0, delimiter: null, argument: null,
});

console.log('--- 模糊匹配（所有语言共用的那一份）---');
check('pl 命中 player', !!fuzzyMatch('pl', 'player'), true);
check('pl 命中 place', !!fuzzyMatch('pl', 'place'), true);
check('pyr 子序列命中 player', !!fuzzyMatch('pyr', 'player'), true);
check('abc 不命中 player', fuzzyMatch('abc', 'player') ?? null, null);
check('空 pattern 放行全部候选', !!fuzzyMatch('', 'anything'), true);
check('大小写不敏感：PL 命中 player', !!fuzzyMatch('PL', 'player'), true);
check('前缀得分高于子序列', fuzzyMatch('play', 'player').score > fuzzyMatch('pyr', 'player').score, true);
check('camelCase 边界加分：PD 命中 PlayerData', !!fuzzyMatch('PD', 'PlayerData'), true);

console.log('--- 候选合并 ---');
const pool = buildPool(adapter.scanSymbols(), adapter.getLiterals({}));
check('stub 符号 12 + 字面量 3 = 15 条候选', pool.length, 15);
check(
  '字面量以 literal 来源并入',
  pool.filter((c) => c.source === 'literal').map((c) => c.label),
  ['true', 'false', 'null'],
);
check(
  '同名去重：符号优先于字面量',
  buildPool([{ name: 'true', category: 'variable' }], [{ value: 'true' }]),
  [{ label: 'true', insertText: 'true', detail: undefined, source: 'symbol', category: 'variable', weight: 1 }],
);

console.log('--- Python 适配器（阶段 4 / 范围 B）---');
const { PythonAdapter } = require('../out/adapter/python/pythonAdapter.js');
const python = new PythonAdapter();

const PY_SOURCE = [
  'import os',
  '',
  'MAX_SIZE = 100',
  'count = 0',
  'name = "hello"',
  'items = [1, 2, 3]',
  'table = {}',
  'ratio = 1.5',
  'result = compute()',
  '',
  'def parse(text):',
  '    return text',
  '',
  'class Parser:',
  '    def __init__(self):',
  '        self.value = 1',
  '    def run(self):',
  '        return 1',
].join('\n');

const pyDoc = { getText: () => PY_SOURCE };
/** 只造 PythonAdapter 真正会读的两个字段 */
const pyCtx = (previousSegments, delimiter) => ({ previousSegments, delimiter });
const pyNames = (ctx) => python.scanSymbols(pyDoc, ctx).map((s) => s.name);
const pySymbols = (ctx) => python.scanSymbols(pyDoc, ctx);

const plain = pyNames(pyCtx([], undefined));
const allSymbols = pySymbols(pyCtx([], undefined));

check('扫到顶层函数 parse', plain.includes('parse'), true);
check('扫到顶层类 Parser', plain.includes('Parser'), true);
check('扫到类内方法 run', plain.includes('run'), true);
check('扫到顶层变量 name', plain.includes('name'), true);
check(
  'MAX_SIZE 归为常量',
  allSymbols.find((s) => s.name === 'MAX_SIZE').category,
  'constant',
);
check('run 的说明带上所属类名', allSymbols.find((s) => s.name === 'run').detail, 'Parser.run()');
check('内置函数 print 在列', plain.includes('print'), true);
check('import 的模块名不进候选（不扫 import）', plain.includes('os'), false);
check('类内 self.value 不扫', plain.includes('value'), false);
check('普通语境下不给类型方法', plain.includes('upper'), false);

check('变量 name（= "hello"）→ 给 str 方法', pyNames(pyCtx(['name', '.'], '.')).includes('upper'), true);
check('字面量 "abc". → 给 str 方法', pyNames(pyCtx(['"abc"', '.'], '.')).includes('split'), true);
check('items（= [1,2,3]）→ 给 list 方法', pyNames(pyCtx(['items', '.'], '.')).includes('append'), true);
check('table（= {}）→ 给 dict 方法', pyNames(pyCtx(['table', '.'], '.')).includes('keys'), true);
check('count（= 0）→ 给 int 方法', pyNames(pyCtx(['count', '.'], '.')).includes('bit_length'), true);
check('ratio（= 1.5）→ 给 float 方法', pyNames(pyCtx(['ratio', '.'], '.')).includes('is_integer'), true);
check('result（= compute()）→ 推不出类型，不补', pySymbols(pyCtx(['result', '.'], '.')).length, 0);
check('未定义变量 → 不补', pySymbols(pyCtx(['unknown', '.'], '.')).length, 0);
check('s. 语境下不给文件符号', pyNames(pyCtx(['name', '.'], '.')).includes('parse'), false);
check(
  'obj.attr. → 接收者是属性，推不出类型，不补',
  pySymbols(pyCtx(['obj', '.', 'attr', '.'], '.')).length,
  0,
);
check('Python 字面量是 True/False/None', python.getLiterals({}).map((l) => l.value), ['True', 'False', 'None']);
// 只比该比的：memberAccess 是各语言自己的声明，本来就不该和占位适配器一致
check(
  'Python 的分隔符与占位适配器同一套',
  JSON.stringify(python.getSegmentStrategy().delimiters),
  JSON.stringify(strategy.delimiters),
);
check(
  'Python 的括号表与占位适配器同一套',
  JSON.stringify(python.getSegmentStrategy().pairs),
  JSON.stringify(strategy.pairs),
);
check(
  'Python 声明了自己的成员访问分隔符',
  JSON.stringify(python.getSegmentStrategy().memberAccess),
  '["."]',
);
check('languageIds 只声明 python', JSON.stringify(python.languageIds), '["python"]');

console.log('--- C 适配器（阶段 5 第一步：符号扫描）---');
const { CAdapter } = require('../out/adapter/c/cAdapter.js');
const cAdapter = new CAdapter();
const cStrategy = cAdapter.getSegmentStrategy();
const cDoc = (text, languageId = 'c', fileName = 'sample.c') => ({
  getText: () => text,
  languageId,
  fileName,
});
const cScan = (text, languageId, fileName) =>
  cAdapter.scanSymbols(cDoc(text, languageId, fileName), {});
const cNames = (text, languageId, fileName) => cScan(text, languageId, fileName).map((s) => s.name);

const C_SOURCE = [
  '#include <stdio.h>',
  '#define MAX_SIZE 100',
  '#define MIN(a, b) ((a) < (b) ? (a) : (b))',
  '',
  'typedef unsigned int uint;',
  '',
  'struct Point {',
  '    int x;',
  '    int y;',
  '    struct Point *next;',
  '};',
  '',
  'int count = 0;',
  'char *label;',
  'struct Point origin;',
  '',
  'int add(int a, int b);',
  'void print_point(struct Point *p);',
  '',
  'int add(int a, int b) {',
  '    int sum = a + b;',
  '    return sum;',
  '}',
].join('\n');

const cPlain = cNames(C_SOURCE);
const cAll = cScan(C_SOURCE);

check('扫到宏 MAX_SIZE', cPlain.includes('MAX_SIZE'), true);
check('宏的类别是 macro', cAll.find((s) => s.name === 'MAX_SIZE').category, 'macro');
check('扫到带参数宏 MIN', cPlain.includes('MIN'), true);
check('扫到 typedef 出来的类型 uint', cPlain.includes('uint'), true);
check('扫到 struct Point', cPlain.includes('Point'), true);
check('扫到全局变量 count', cPlain.includes('count'), true);
check('扫到指针变量 label', cPlain.includes('label'), true);
check('扫到 struct 变量 origin', cPlain.includes('origin'), true);
check('扫到函数声明 add', cPlain.includes('add'), true);
check('扫到函数声明 print_point', cPlain.includes('print_point'), true);
check('函数声明 + 定义都被扫到（去重交给候选池）', cPlain.filter((n) => n === 'add').length, 2);
check('struct 字段 x 不当成全局变量', cPlain.includes('x'), false);
check('struct 字段 next 不当成全局变量', cPlain.includes('next'), false);
check('函数内局部变量 sum 也扫到', cPlain.includes('sum'), true);
check('#include 不产生符号', cPlain.includes('stdio'), false);
check('return 语句不产生符号', cPlain.includes('return'), false);

console.log('--- C 适配器：.h 归属判断（改由 claims 回答）---');
// 同一份 .h 内容 × 两种 languageId 都要成立 ——
// VSCode 内置把 .h 关联成 c，装了 C/C++ 扩展可能变成 cpp，两条路径都必须覆盖
const CPP_HEADER = 'class Foo { };\nint f(void);';
const PURE_C_HEADER = 'int foo(void);\nstruct Point { int x; int y; };';

/**
 * 归属判断现在**只由 claims 回答**（scanSymbols / getLiterals 不再自带判断），
 * 所以这里直接测 claims；端到端的 resolve 验证放在后面的「认领判据互斥」一节。
 * 注意：claims 为 false 时 resolve 直接返回 undefined，provider 会提前 return ——
 * 连 getLiterals 都不会被调用，所以"让位时字面量也为空"这个保证比之前更强。
 */
const claimsOf = (text, languageId, fileName) => cAdapter.claims(cDoc(text, languageId, fileName));

check('.c 文件 → 认领', claimsOf(C_SOURCE, 'c', 'sample.c'), true);
check('含 class 的 .h × languageId cpp → 让位', claimsOf(CPP_HEADER, 'cpp', 'x.h'), false);
check('含 class 的 .h × languageId c → 让位（关键回归）', claimsOf(CPP_HEADER, 'c', 'x.h'), false);
check('含 namespace 的 .h × c → 让位', claimsOf('namespace ns { int f(void); }', 'c', 'x.h'), false);
check('含 template 的 .h × cpp → 让位', claimsOf('template <typename T> T f(T x);', 'cpp', 'x.h'), false);
check('含 :: 的 .h × c → 让位', claimsOf('void ns::f(void);', 'c', 'x.h'), false);
check('纯 C 的 .h × languageId cpp → 认领', claimsOf(PURE_C_HEADER, 'cpp', 'p.h'), true);
check('纯 C 的 .h × languageId c → 认领', claimsOf(PURE_C_HEADER, 'c', 'p.h'), true);
check('.cpp 文件 → 让位', claimsOf(C_SOURCE, 'cpp', 'sample.cpp'), false);
check('.hpp 文件 → 让位（不以 .h 结尾）', claimsOf(C_SOURCE, 'cpp', 'sample.hpp'), false);
check(
  'getLiterals 不再自带归属判断：被认领时就是 NULL / EOF',
  JSON.stringify(cAdapter.getLiterals({}).map((l) => l.value)),
  '["NULL","EOF"]',
);

console.log('--- C 适配器：多字符分隔符切段（方案 i）---');
check('p->x → 切出 p 与 ->，当前段 x', shape('p->x', 4, cStrategy), {
  text: 'x', range: [3, 4], before: ['p', '->'], depth: 0, delimiter: '->', argument: null,
});
check('p-> → 当前段为空、触发符是 ->', shape('p->', 3, cStrategy), {
  text: '', range: [3, 3], before: ['p', '->'], depth: 0, delimiter: '->', argument: null,
});
check('a-b 不切（- 不是分隔符）', shape('a-b', 3, cStrategy), {
  text: 'a-b', range: [0, 3], before: [], depth: 0, delimiter: null, argument: null,
});
check('多字符改动没破坏参数计数：foo(a, b) 第 2 个', shape('foo(a, b)', 8, cStrategy), {
  text: 'b', range: [7, 8], before: ['foo', '(', 'a', ','], depth: 1, delimiter: ',', argument: 2,
});

console.log('--- C 适配器：struct 成员访问（第二步）---');
const MEMBER_SOURCE = [
  'struct Point {',
  '    int x;',
  '    int y;',
  '    char name[32];',
  '};',
  'struct Vec {',
  '    int dx;',
  '    int dy;',
  '};',
  'int count;',
  'char *label;',
  'struct Point origin;',
  'struct Point *cursor;',
  'struct Vec speed;',
  'int get_count(void);',
].join('\n');

/** 只取名字，便于断言 */
const memberNames = (previousSegments, delimiter) =>
  cAdapter.scanSymbols(cDoc(MEMBER_SOURCE), { previousSegments, delimiter }).map((s) => s.name);
/** 取完整符号，便于断言 detail / category */
const memberAll = (previousSegments, delimiter) =>
  cAdapter.scanSymbols(cDoc(MEMBER_SOURCE), { previousSegments, delimiter });

check(
  'struct 值变量 origin. → 弹该 struct 的字段',
  JSON.stringify(memberNames(['origin', '.'], '.')),
  '["x","y","name"]',
);
check(
  'struct 指针 cursor-> → 弹该 struct 的字段',
  JSON.stringify(memberNames(['cursor', '->'], '->')),
  '["x","y","name"]',
);
check('字段的说明带上所属 struct', memberAll(['origin', '.'], '.')[0].detail, 'Point.x');
check('字段的类别是 field', memberAll(['origin', '.'], '.')[0].category, 'field');
check('成员访问语境下不给普通符号', memberNames(['origin', '.'], '.').includes('count'), false);
check(
  '另一个 struct 不串味：speed. 只给 Vec 的字段',
  JSON.stringify(memberNames(['speed', '.'], '.')),
  '["dx","dy"]',
);
check('非 struct 变量 count. → 不弹', memberNames(['count', '.'], '.').length, 0);
check('指针变量 label. → 不弹（指向的是 char，不是 struct）', memberNames(['label', '.'], '.').length, 0);
check(
  '函数返回值 get_count(). → 不弹（接收者是右括号）',
  memberNames(['get_count', '(', ')', '.'], '.').length,
  0,
);
check('未声明的变量 → 不弹', memberNames(['unknown', '.'], '.').length, 0);
check('形态不匹配：值变量用 -> → 不弹', memberNames(['origin', '->'], '->').length, 0);
check('形态不匹配：指针用 . → 不弹', memberNames(['cursor', '.'], '.').length, 0);

console.log('--- C 适配器：单行 struct ---');
/** 在任意源码上做成员访问，取候选名 */
const namesIn = (source, previousSegments, delimiter) =>
  cAdapter.scanSymbols(cDoc(source), { previousSegments, delimiter }).map((s) => s.name);

const INLINE_SOURCE = [
  'struct Vec { int dx; int dy; };',
  'struct Vec speed;',
  'struct Single { int only; };',
  'struct Single s;',
  'struct Nested { struct Inner { int deep; } inner; };',
  'struct Nested nested;',
].join('\n');

check(
  '单行 struct：字段能收到',
  JSON.stringify(namesIn(INLINE_SOURCE, ['speed', '.'], '.')),
  '["dx","dy"]',
);
check('单行 struct：单字段也正常', JSON.stringify(namesIn(INLINE_SOURCE, ['s', '.'], '.')), '["only"]');
check('单行嵌套 struct：放弃（宁可漏不误报）', namesIn(INLINE_SOURCE, ['nested', '.'], '.').length, 0);

const MULTILINE_NESTED = [
  'struct Outer {',
  '    struct Inner {',
  '        int deep;',
  '    } inner;',
  '    int shallow;',
  '};',
  'struct Outer o;',
].join('\n');

check(
  '多行嵌套 struct：放弃（不把内层字段当成外层的）',
  namesIn(MULTILINE_NESTED, ['o', '.'], '.').length,
  0,
);
check(
  '多行平铺 struct 仍正常',
  JSON.stringify(namesIn('struct P {\n int a;\n int b;\n};\nstruct P v;\n', ['v', '.'], '.')),
  '["a","b"]',
);

// 写法 ②：单行定义并同时声明变量（变量名与 struct 定义在同一行）
check(
  '写法②：`struct Vec { … } speed;` 字段能收到',
  JSON.stringify(namesIn('struct Vec { int dx; int dy; } speed;', ['speed', '.'], '.')),
  '["dx","dy"]',
);
check(
  '写法②：同一行的指针变量也认得（要用 ->）',
  JSON.stringify(namesIn('struct Vec { int dx; int dy; } *sp;', ['sp', '->'], '->')),
  '["dx","dy"]',
);

// 写法 ③：typedef 内联 struct
const TYPEDEF_SOURCE = [
  'typedef struct Node { int key; struct Node *next; } Node;',
  'struct Node head;',
].join('\n');
check(
  '写法③：`typedef struct X { … } Y;` 字段能收到',
  JSON.stringify(namesIn(TYPEDEF_SOURCE, ['head', '.'], '.')),
  '["key","next"]',
);
check(
  '写法③：匿名 struct + typedef 名做变量声明也能补成员',
  JSON.stringify(namesIn(['typedef struct { int key; int value; } Entry;', 'Entry e;'].join('\n'), ['e', '.'], '.')),
  '["key","value"]',
);
check(
  '写法③：结构体标签与 typedef 别名不同时，两个名字都能用',
  JSON.stringify(
    namesIn('typedef struct Tag { int a; } Alias;\nstruct Tag t;\nAlias a2;', ['t', '.'], '.'),
  ),
  '["a"]',
);

console.log('--- C 适配器：内置清单与字面量（第三步）---');
const C_PLAIN_SOURCE = 'int foo(void);';
const cPlainAll = cAdapter.scanSymbols(cDoc(C_PLAIN_SOURCE), {});

check('内置函数 printf 在列', cPlainAll.some((s) => s.name === 'printf'), true);
check('内置函数 malloc 在列', cPlainAll.some((s) => s.name === 'malloc'), true);
check('内置函数 free 在列', cPlainAll.some((s) => s.name === 'free'), true);
check('内置函数 memcpy 在列', cPlainAll.some((s) => s.name === 'memcpy'), true);
check('内置函数 strlen 在列', cPlainAll.some((s) => s.name === 'strlen'), true);
check('内置函数 strcmp 在列', cPlainAll.some((s) => s.name === 'strcmp'), true);
check('内置函数的类别是 function', cPlainAll.find((s) => s.name === 'printf').category, 'function');
check('内置函数的说明标明来源', cPlainAll.find((s) => s.name === 'printf').detail, 'C 标准库函数');
check(
  '文件里的同名定义排在内部清单之前（去重时保留用户的）',
  cAdapter.scanSymbols(cDoc('int printf(void);'), {}).filter((s) => s.name === 'printf')[0].detail,
  'printf()',
);
check(
  '成员访问语境下不给内置函数',
  namesIn(MEMBER_SOURCE, ['origin', '.'], '.').includes('printf'),
  false,
);
check(
  '字面量只有 NULL 与 EOF',
  JSON.stringify(cAdapter.getLiterals({ document: cDoc(C_PLAIN_SOURCE) }).map((l) => l.value)),
  '["NULL","EOF"]',
);
check(
  '让位文件（.cpp）的 claims 为 false（归属判断已归位到 claims）',
  cAdapter.claims(cDoc('class Foo {};', 'cpp', 'x.cpp')),
  false,
);

console.log('--- 成员访问语境声明（方案甲）---');
const { isMemberAccessContext } = require('../out/completion/segment.js');
const pyStrategy = python.getSegmentStrategy();

check('C 的 . 被判为成员访问语境', isMemberAccessContext('.', cStrategy), true);
check('C 的 -> 被判为成员访问语境', isMemberAccessContext('->', cStrategy), true);
check('C 的 ( 不是成员访问语境', isMemberAccessContext('(', cStrategy), false);
check('C 的 , 不是成员访问语境', isMemberAccessContext(',', cStrategy), false);
check('无分隔符时不是成员访问语境', isMemberAccessContext(undefined, cStrategy), false);
check('Python 的 . 被判为成员访问语境', isMemberAccessContext('.', pyStrategy), true);
check('Python 的 ( 不是成员访问语境', isMemberAccessContext('(', pyStrategy), false);
check(
  '第 4 条回归：嵌套 struct 的 o. 符号数为 0（放弃生效）',
  namesIn(MULTILINE_NESTED, ['o', '.'], '.').length,
  0,
);
check(
  '第 4 条回归：该位置属于成员访问语境 → 字面量不并入，候选池为空',
  isMemberAccessContext('.', cStrategy),
  true,
);

console.log('--- 接收者粒度（方案 D：适配器内识别接收者）---');
const pyNamesIn = (source, previousSegments, delimiter) =>
  python.scanSymbols({ getText: () => source }, { previousSegments, delimiter }).map((s) => s.name);

// C：同一行多语句（本次缺陷）
check(
  'C：同一行多语句 `… } speed; speed.` 接收者不被污染',
  JSON.stringify(
    namesIn(
      'struct Vec { int dx; int dy; } speed; speed.',
      ['struct Vec { int dx; int dy; } speed; speed', '.'],
      '.',
    ),
  ),
  '["dx","dy"]',
);
check(
  'C：分两行写法仍正常（防回归）',
  JSON.stringify(namesIn('struct Vec { int dx; int dy; };\nstruct Vec speed;', ['speed', '.'], '.')),
  '["dx","dy"]',
);
check(
  'C：`foo(a).` 仍不弹（访问符前扫不到标识符）',
  namesIn(MEMBER_SOURCE, ['foo', '(', 'a', ')', '.'], '.').length,
  0,
);
check(
  'C：`arr[i].` 仍不弹（没放宽成"随便取一个名字"）',
  namesIn(MEMBER_SOURCE, ['arr[i]', '.'], '.').length,
  0,
);

// Python：同一行多语句同样受惠
check(
  'Python：`y = 1; x.` 同一行多语句仍取到 x',
  pyNamesIn('x = "hello"\ny = 1; x.', ['y = 1; x', '.'], '.').includes('upper'),
  true,
);
check(
  'Python：`obj.attr.` 不会误取成 obj（推不出类型 → 空）',
  pyNamesIn('obj = "hi"\n', ['obj', '.', 'attr', '.'], '.').length,
  0,
);

console.log('--- CppAdapter：认领判据（阶段 6 第 3 步）---');
const { CppAdapter } = require('../out/adapter/cpp/cppAdapter.js');
const cppAdapter = new CppAdapter();
const cppDoc = (text, fileName, languageId = 'cpp') => ({ getText: () => text, fileName, languageId });
const cppClaims = (text, fileName, languageId) => cppAdapter.claims(cppDoc(text, fileName, languageId));

check('.cpp → 认领', cppClaims('int main() {}', 'main.cpp'), true);
check('.cc → 认领', cppClaims('int main() {}', 'main.cc'), true);
check('.cxx → 认领', cppClaims('int main() {}', 'main.cxx'), true);
check('.hpp → 认领', cppClaims('class A {};', 'a.hpp'), true);
check('.h 含 class → 认领', cppClaims('class Foo {};', 'x.h'), true);
check('.h 含 namespace → 认领', cppClaims('namespace n {}', 'x.h'), true);
check('.h 含 template → 认领', cppClaims('template <class T> void f();', 'x.h'), true);
check('.h 含 :: → 认领', cppClaims('void ns::f() {}', 'x.h'), true);
check('.h 纯 C（无 C++ 特征）→ 让位', cppClaims('int foo(void);', 'pure.h'), false);
check('.c → 不认领（后缀不在清单里）', cppClaims('int foo(void);', 'main.c'), false);
check('语言被手动设成 C++ 但后缀是 .txt → 不认领', cppClaims('hello', 'notes.txt'), false);
check(
  '第 3 步的「返回空」占位断言已作废：现在能扫到类名',
  cppAdapter
    .scanSymbols(cppDoc('class A { int x; };', 'a.cpp'), {})
    .map((s) => s.name)
    .includes('A'),
  true,
);
check('C++ 暂不提供字面量（范围外）：getLiterals 返回空', cppAdapter.getLiterals({}).length, 0);

console.log('--- CppAdapter：类成员扫描与成员访问（阶段 6 第 4.1 小步）---');

/** 三个容器的方法表（须与 builtins.ts 的清单一致；6.2 起生效） */
const CPP_STRING_METHODS = [
  'size',
  'length',
  'empty',
  'clear',
  'substr',
  'find',
  'rfind',
  'append',
  'at',
  'c_str',
  'compare',
  'begin',
  'end',
  'replace',
  'insert',
  'erase',
];
const CPP_VECTOR_METHODS = [
  'push_back',
  'pop_back',
  'size',
  'empty',
  'clear',
  'at',
  'front',
  'back',
  'begin',
  'end',
  'resize',
  'reserve',
  'erase',
  'insert',
];
const CPP_MAP_METHODS = ['insert', 'erase', 'find', 'count', 'size', 'empty', 'clear', 'at', 'begin', 'end'];

const CPP_CLASS_SOURCE = [
  'class Box {',
  'public:',
  '    int value;',
  '    int width, height;',
  '    int get() const { return value; }',
  '    void set(int v);',
  '    Box();',
  'private:',
  '    int secret;',
  '};',
  'Box box;',
  'Box *ptr;',
  'int plain;',
  'std::string text;',
  'int freeFunction(void);',
].join('\n');

/** 在指定源码上做成员访问，取候选名 */
const cppNamesIn = (source, previousSegments, delimiter) =>
  cppAdapter.scanSymbols(cppDoc(source, 'sample.cpp'), { previousSegments, delimiter }).map((s) => s.name);
/** 同上但取完整符号 */
const cppAllIn = (source, previousSegments, delimiter) =>
  cppAdapter.scanSymbols(cppDoc(source, 'sample.cpp'), { previousSegments, delimiter });
/** 顶层符号名 */
const cppTopNames = (source) =>
  cppAdapter.scanSymbols(cppDoc(source, 'sample.cpp'), {}).map((s) => s.name);

const CPP_BOX_MEMBERS = ['value', 'width', 'height', 'get', 'set', 'Box', 'secret'];

check('顶层扫到类名 Box', cppTopNames(CPP_CLASS_SOURCE).includes('Box'), true);
check('顶层扫到函数 freeFunction', cppTopNames(CPP_CLASS_SOURCE).includes('freeFunction'), true);
check('顶层扫到变量 box', cppTopNames(CPP_CLASS_SOURCE).includes('box'), true);
check('顶层扫到宏（如有）与类成员互不干扰', cppTopNames(CPP_CLASS_SOURCE).includes('value'), false);

check(
  'box. → 弹该类的全部成员（字段 + 方法，按源码顺序）',
  JSON.stringify(cppNamesIn(CPP_CLASS_SOURCE, ['box', '.'], '.')),
  JSON.stringify(CPP_BOX_MEMBERS),
);
check(
  'ptr-> → 同样弹全部成员',
  JSON.stringify(cppNamesIn(CPP_CLASS_SOURCE, ['ptr', '->'], '->')),
  JSON.stringify(CPP_BOX_MEMBERS),
);
check(
  '方法的类别是 method',
  cppAllIn(CPP_CLASS_SOURCE, ['box', '.'], '.').find((s) => s.name === 'get').category,
  'method',
);
check(
  '字段的类别是 field',
  cppAllIn(CPP_CLASS_SOURCE, ['box', '.'], '.').find((s) => s.name === 'value').category,
  'field',
);
check(
  '方法的说明带括号',
  cppAllIn(CPP_CLASS_SOURCE, ['box', '.'], '.').find((s) => s.name === 'get').detail,
  'Box::get()',
);
check(
  '字段的说明不带括号',
  cppAllIn(CPP_CLASS_SOURCE, ['box', '.'], '.').find((s) => s.name === 'value').detail,
  'Box::value',
);
check(
  'private 成员本步不过滤（标注留到 4.2）',
  cppNamesIn(CPP_CLASS_SOURCE, ['box', '.'], '.').includes('secret'),
  true,
);
check('访问修饰符标签本身不是成员', cppNamesIn(CPP_CLASS_SOURCE, ['box', '.'], '.').includes('public'), false);

check('形态不匹配：值变量用 -> → 不弹', cppNamesIn(CPP_CLASS_SOURCE, ['box', '->'], '->').length, 0);
check('形态不匹配：指针用 . → 不弹', cppNamesIn(CPP_CLASS_SOURCE, ['ptr', '.'], '.').length, 0);
check('非类变量 plain. → 不弹', cppNamesIn(CPP_CLASS_SOURCE, ['plain', '.'], '.').length, 0);
// 这条 6.1 时是「不弹」（那时内置表只有 std），6.2 加容器方法表后**按计划反转**成「能弹」
check(
  'std::string text. → 弹 string 的方法表',
  JSON.stringify(cppNamesIn(CPP_CLASS_SOURCE, ['text', '.'], '.')),
  JSON.stringify(CPP_STRING_METHODS),
);
check('未声明的变量 → 不弹', cppNamesIn(CPP_CLASS_SOURCE, ['unknown', '.'], '.').length, 0);
check('函数返回值 freeFunction(). → 不弹', cppNamesIn(CPP_CLASS_SOURCE, ['freeFunction', '(', ')', '.'], '.').length, 0);

// 多行方法体：方法名要收下，方法体内部的局部变量不能被当成员
const CPP_METHOD_BODY = [
  'class Calc {',
  '    int total;',
  '    int add(int a) {',
  '        int local = a * 2;',
  '        if (local > 0) {',
  '            return local;',
  '        }',
  '        return total;',
  '    }',
  '    int sub(int a) {',
  '        return total - a;',
  '    }',
  '};',
  'Calc calc;',
].join('\n');

check(
  '多行方法体：成员恰好是 total / add / sub',
  JSON.stringify(cppNamesIn(CPP_METHOD_BODY, ['calc', '.'], '.')),
  JSON.stringify(['total', 'add', 'sub']),
);
check(
  '多行方法体：内部的局部变量 local 不当成员',
  cppNamesIn(CPP_METHOD_BODY, ['calc', '.'], '.').includes('local'),
  false,
);
check(
  '多行方法体：体内的 return 不当成员',
  cppNamesIn(CPP_METHOD_BODY, ['calc', '.'], '.').includes('return'),
  false,
);

// 嵌套类：内外层分不清 → 整个放弃（宁可漏不误报，与 C 的嵌套策略一致）
const CPP_NESTED_CLASS = [
  'class Outer {',
  '    class Inner {',
  '        int deep;',
  '    };',
  '    int shallow;',
  '};',
  'Outer outer;',
].join('\n');

check(
  '嵌套类：外层成员整个放弃（不把 Inner 的成员当外层的）',
  cppNamesIn(CPP_NESTED_CLASS, ['outer', '.'], '.').length,
  0,
);

console.log('--- CppAdapter 4.2：模板剥参数 / :: / 访问级别标注 ---');

// ① 模板剥参数
const CPP_TEMPLATE_SOURCE = [
  'class Box {',
  '    int value;',
  '    int get() { return value; }',
  '};',
  'Box<int> boxed;',
  'Box<int, std::string> multi;',
  'std::vector<int> nums;',
  'Box plain;',
].join('\n');

check(
  'Box<int> boxed. → 剥参数后查到 Box',
  JSON.stringify(cppNamesIn(CPP_TEMPLATE_SOURCE, ['boxed', '.'], '.')),
  JSON.stringify(['value', 'get']),
);
check(
  '多层模板 Box<int, std::string> → 也剥对',
  JSON.stringify(cppNamesIn(CPP_TEMPLATE_SOURCE, ['multi', '.'], '.')),
  JSON.stringify(['value', 'get']),
);
// 同 text. 那条：6.1 时「不弹」，6.2 按计划反转成「能弹」
check(
  'std::vector<int> nums. → 弹 vector 的方法表',
  JSON.stringify(cppNamesIn(CPP_TEMPLATE_SOURCE, ['nums', '.'], '.')),
  JSON.stringify(CPP_VECTOR_METHODS),
);
check(
  '剥完查不到时不抛异常（返回空数组）',
  Array.isArray(cppNamesIn(CPP_TEMPLATE_SOURCE, ['nums', '.'], '.')),
  true,
);
check(
  '非模板写法 Box plain. 不受影响',
  JSON.stringify(cppNamesIn(CPP_TEMPLATE_SOURCE, ['plain', '.'], '.')),
  JSON.stringify(['value', 'get']),
);

// ② `::` 访问（静态成员 + 命名空间成员）
const CPP_SCOPE_SOURCE = [
  'class Counter {',
  'public:',
  '    static int count;',
  '    int value;',
  '    static int get() { return count; }',
  '    void reset();',
  '};',
  'namespace ns {',
  '    int helper;',
  '    void work();',
  '}',
].join('\n');

check(
  'Counter:: → 弹全部成员（宽松，不只静态）',
  JSON.stringify(cppNamesIn(CPP_SCOPE_SOURCE, ['Counter', '::'], '::')),
  JSON.stringify(['count', 'value', 'get', 'reset']),
);
check(
  'Counter:: → static 字段标注 static',
  cppAllIn(CPP_SCOPE_SOURCE, ['Counter', '::'], '::').find((s) => s.name === 'count').detail,
  'static Counter::count',
);
check(
  'Counter:: → static 方法标注 static 且带括号',
  cppAllIn(CPP_SCOPE_SOURCE, ['Counter', '::'], '::').find((s) => s.name === 'get').detail,
  'static Counter::get()',
);
check(
  'Counter:: → 非静态成员不标 static',
  cppAllIn(CPP_SCOPE_SOURCE, ['Counter', '::'], '::').find((s) => s.name === 'value').detail,
  'Counter::value',
);
check(
  'ns:: → 弹命名空间成员',
  JSON.stringify(cppNamesIn(CPP_SCOPE_SOURCE, ['ns', '::'], '::')),
  JSON.stringify(['helper', 'work']),
);
check(
  '命名空间名进顶层符号，类别是 namespace',
  cppAdapter
    .scanSymbols(cppDoc(CPP_SCOPE_SOURCE, 'sample.cpp'), {})
    .find((s) => s.name === 'ns').category,
  'namespace',
);
check(
  '未定义的类名 Xyz:: → 静默不弹',
  cppNamesIn(CPP_SCOPE_SOURCE, ['Xyz', '::'], '::').length,
  0,
);
check(
  ':: 访问不受变量形态影响（不需要变量表）',
  cppNamesIn(CPP_SCOPE_SOURCE, ['Counter', '::'], '::').length > 0,
  true,
);

// ③ 访问级别：不过滤，只标注
const CPP_ACCESS_SOURCE = [
  'class Account {',
  'public:',
  '    int open;',
  '    void deposit();',
  'private:',
  '    int secret;',
  '    void hide();',
  'protected:',
  '    int guarded;',
  '};',
  'Account account;',
].join('\n');

check(
  '访问标签本身不是成员',
  cppNamesIn(CPP_ACCESS_SOURCE, ['account', '.'], '.').includes('public'),
  false,
);
check(
  'private 成员照样弹（不过滤）',
  cppNamesIn(CPP_ACCESS_SOURCE, ['account', '.'], '.').includes('secret'),
  true,
);
check(
  'protected 成员照样弹（不过滤）',
  cppNamesIn(CPP_ACCESS_SOURCE, ['account', '.'], '.').includes('guarded'),
  true,
);
check(
  'public 段成员不标访问级别',
  cppAllIn(CPP_ACCESS_SOURCE, ['account', '.'], '.').find((s) => s.name === 'open').detail,
  'Account::open',
);
check(
  'private 字段标注 private',
  cppAllIn(CPP_ACCESS_SOURCE, ['account', '.'], '.').find((s) => s.name === 'secret').detail,
  'private: Account::secret',
);
check(
  'private 方法标注 private 且带括号',
  cppAllIn(CPP_ACCESS_SOURCE, ['account', '.'], '.').find((s) => s.name === 'hide').detail,
  'private: Account::hide()',
);
check(
  'protected 字段标注 protected',
  cppAllIn(CPP_ACCESS_SOURCE, ['account', '.'], '.').find((s) => s.name === 'guarded').detail,
  'protected: Account::guarded',
);

console.log('--- CppAdapter 5.1：单继承与递归合并（含防循环）---');

const CPP_INHERIT_SOURCE = [
  'class GrandBase {',
  'public:',
  '    int grand;',
  '    void grandMethod();',
  '};',
  'class Base : public GrandBase {',
  'public:',
  '    int baseValue;',
  '    void baseMethod();',
  'private:',
  '    int baseSecret;',
  '};',
  'class Derived : public Base {',
  'public:',
  '    int own;',
  '    void ownMethod();',
  '};',
  'Derived derived;',
  'Base baseObject;',
].join('\n');

const INHERIT_ALL = [
  'own',
  'ownMethod',
  'baseValue',
  'baseMethod',
  'baseSecret',
  'grand',
  'grandMethod',
];

check(
  'Derived:: 递归合并三层：自己的 + Base 的 + GrandBase 的',
  JSON.stringify(cppNamesIn(CPP_INHERIT_SOURCE, ['Derived', '::'], '::')),
  JSON.stringify(INHERIT_ALL),
);
check(
  '派生类对象 derived. 同样合并（继承不只在 :: 上生效）',
  JSON.stringify(cppNamesIn(CPP_INHERIT_SOURCE, ['derived', '.'], '.')),
  JSON.stringify(INHERIT_ALL),
);
check(
  '基类对象只弹自己那一层（含它自己的基类，不含派生类的）',
  JSON.stringify(cppNamesIn(CPP_INHERIT_SOURCE, ['baseObject', '.'], '.')),
  JSON.stringify(['baseValue', 'baseMethod', 'baseSecret', 'grand', 'grandMethod']),
);
check(
  '继承来的成员 detail 写归属 Base',
  cppAllIn(CPP_INHERIT_SOURCE, ['derived', '.'], '.').find((s) => s.name === 'baseMethod').detail,
  'Base::baseMethod()',
);
check(
  '递归两层继承来的成员 detail 写归属 GrandBase',
  cppAllIn(CPP_INHERIT_SOURCE, ['derived', '.'], '.').find((s) => s.name === 'grand').detail,
  'GrandBase::grand',
);
check(
  '自己的成员 detail 写自己',
  cppAllIn(CPP_INHERIT_SOURCE, ['derived', '.'], '.').find((s) => s.name === 'own').detail,
  'Derived::own',
);
check(
  '继承来的 private 成员照样弹（与本类规则一致，不过滤）',
  cppNamesIn(CPP_INHERIT_SOURCE, ['derived', '.'], '.').includes('baseSecret'),
  true,
);
check(
  '继承来的 private 成员标注 private 且写归属 Base',
  cppAllIn(CPP_INHERIT_SOURCE, ['derived', '.'], '.').find((s) => s.name === 'baseSecret').detail,
  'private: Base::baseSecret',
);
check(
  '基类不在本文件（std::string）→ 不弹它的成员，也不报错',
  cppNamesIn(
    ['class Weird : public std::string {', 'public:', '    int own;', '};', 'Weird w;'].join('\n'),
    ['w', '.'],
    '.',
  ).length,
  1,
);

// 防循环：非法但确实写得出来，必须能返回而不是栈溢出
const CPP_CYCLE_SOURCE = [
  'class A : public B {',
  'public:',
  '    int a;',
  '};',
  'class B : public A {',
  'public:',
  '    int b;',
  '};',
  'A cycleA;',
].join('\n');

check(
  'A : B, B : A 互相继承不死循环（能正常返回）',
  JSON.stringify(cppNamesIn(CPP_CYCLE_SOURCE, ['cycleA', '.'], '.')),
  JSON.stringify(['a', 'b']),
);
check(
  '自继承 Self : Self 不死循环',
  JSON.stringify(
    cppNamesIn(
      ['class Self : public Self {', 'public:', '    int me;', '};', 'Self s;'].join('\n'),
      ['s', '.'],
      '.',
    ),
  ),
  JSON.stringify(['me']),
);

// 本步边界：多继承留给 5.2（写成多继承时整个放弃基类，只弹自己的成员）
const CPP_MULTI_SOURCE = [
  'class B1 {',
  'public:',
  '    int one;',
  '};',
  'class B2 {',
  'public:',
  '    int two;',
  '};',
  'class Multi : public B1, public B2 {',
  'public:',
  '    int own;',
  '};',
  'Multi multi;',
].join('\n');

check(
  '多继承生效（5.2 起）：B1 与 B2 的成员都合并进来',
  JSON.stringify(cppNamesIn(CPP_MULTI_SOURCE, ['multi', '.'], '.')),
  JSON.stringify(['own', 'one', 'two']),
);

console.log('--- CppAdapter 5.2：多继承 ---');

const CPP_MULTI_INHERIT = [
  'class GrandBase2 {',
  'public:',
  '    int grand;',
  '};',
  'class B1 : public GrandBase2 {',
  'public:',
  '    int one;',
  '    void oneMethod();',
  'private:',
  '    int oneSecret;',
  '};',
  'class B2 {',
  'public:',
  '    int two;',
  '    void twoMethod();',
  '};',
  'class Multi : public B1, public B2 {',
  'public:',
  '    int own;',
  '};',
  'Multi multi;',
  'B1 b1;',
].join('\n');

const MULTI_ALL = ['own', 'one', 'oneMethod', 'oneSecret', 'grand', 'two', 'twoMethod'];

check(
  'Multi:: 合并两个基类（含各自的递归基类）',
  JSON.stringify(cppNamesIn(CPP_MULTI_INHERIT, ['Multi', '::'], '::')),
  JSON.stringify(MULTI_ALL),
);
check(
  'Multi 对象 multi. 同样合并且顺序一致',
  JSON.stringify(cppNamesIn(CPP_MULTI_INHERIT, ['multi', '.'], '.')),
  JSON.stringify(MULTI_ALL),
);
check(
  '归属：第一个基类 B1 的成员标 B1',
  cppAllIn(CPP_MULTI_INHERIT, ['multi', '.'], '.').find((s) => s.name === 'one').detail,
  'B1::one',
);
check(
  '归属：第二个基类 B2 的成员标 B2',
  cppAllIn(CPP_MULTI_INHERIT, ['multi', '.'], '.').find((s) => s.name === 'two').detail,
  'B2::two',
);
check(
  '归属：B1 递归来的成员标 GrandBase2（不是 B1）',
  cppAllIn(CPP_MULTI_INHERIT, ['multi', '.'], '.').find((s) => s.name === 'grand').detail,
  'GrandBase2::grand',
);
check(
  '归属：自己的成员标 Multi',
  cppAllIn(CPP_MULTI_INHERIT, ['multi', '.'], '.').find((s) => s.name === 'own').detail,
  'Multi::own',
);
check(
  '多继承下访问级别仍标注',
  cppAllIn(CPP_MULTI_INHERIT, ['multi', '.'], '.').find((s) => s.name === 'oneSecret').detail,
  'private: B1::oneSecret',
);
check(
  'B1 对象只弹自己这一支（不含 B2 的）',
  JSON.stringify(cppNamesIn(CPP_MULTI_INHERIT, ['b1', '.'], '.')),
  JSON.stringify(['one', 'oneMethod', 'oneSecret', 'grand']),
);

// 多继承链上的循环：A1 : Bx, C1 且 Bx : A1
const CPP_MULTI_CYCLE = [
  'class C1 {',
  'public:',
  '    int c;',
  '};',
  'class A1 : public Bx, public C1 {',
  'public:',
  '    int a;',
  '};',
  'class Bx : public A1 {',
  'public:',
  '    int b;',
  '};',
  'A1 obj;',
].join('\n');

check(
  '多继承链上的循环（A1 : Bx, C1 且 Bx : A1）不死循环',
  JSON.stringify(cppNamesIn(CPP_MULTI_CYCLE, ['obj', '.'], '.')),
  JSON.stringify(['a', 'b', 'c']),
);

// 菱形继承：Diamond : Left, Right 且两者都继承 Root
// → Root 的成员**只收一次**（这是 visited 顺带买到的性质，不是两次）
const CPP_DIAMOND = [
  'class Root {',
  'public:',
  '    int root;',
  '};',
  'class Left : public Root {',
  'public:',
  '    int left;',
  '};',
  'class Right : public Root {',
  'public:',
  '    int right;',
  '};',
  'class Diamond : public Left, public Right {',
  'public:',
  '    int own;',
  '};',
  'Diamond diamond;',
].join('\n');

check(
  '菱形继承：Root 的成员只被收一次（visited 生效，不是两次）',
  JSON.stringify(cppNamesIn(CPP_DIAMOND, ['diamond', '.'], '.')),
  JSON.stringify(['own', 'left', 'root', 'right']),
);

// 缺基类定义：派生类自己的成员照常弹
check(
  '多个基类定义缺失时，自己的成员仍能弹',
  JSON.stringify(
    cppNamesIn(
      ['class NoBase : public Missing1, public Missing2 {', 'public:', '    int own;', '};', 'NoBase nb;'].join(
        '\n',
      ),
      ['nb', '.'],
      '.',
    ),
  ),
  JSON.stringify(['own']),
);
check(
  '单个基类定义缺失时同理',
  JSON.stringify(
    cppNamesIn(
      ['class OnlyMissing : public Nope {', 'public:', '    int own;', '};', 'OnlyMissing om;'].join('\n'),
      ['om', '.'],
      '.',
    ),
  ),
  JSON.stringify(['own']),
);

console.log('--- CppAdapter 6.1：内置清单（全局项 + 虚拟 std）---');

const CPP_EMPTY_SOURCE = 'int main() { return 0; }';
const cppTopSymbols = (source) => cppAdapter.scanSymbols(cppDoc(source, 'sample.cpp'), {});
const cppBuiltin = (name) => cppTopSymbols(CPP_EMPTY_SOURCE).find((s) => s.name === name);
const cppStdSymbol = (previousSegments, delimiter, name) =>
  cppAllIn(CPP_EMPTY_SOURCE, previousSegments, delimiter).find((s) => s.name === name);

check('普通语境包含内置全局项 cout', cppTopNames(CPP_EMPTY_SOURCE).includes('cout'), true);
check('普通语境包含内置全局项 string', cppTopNames(CPP_EMPTY_SOURCE).includes('string'), true);
check('普通语境包含内置工具函数 make_unique', cppTopNames(CPP_EMPTY_SOURCE).includes('make_unique'), true);
check('内置项的说明写全名（cout → std::cout）', cppBuiltin('cout').detail, 'std::cout');
check('cout 的类别是 constant（它是对象，不是类型）', cppBuiltin('cout').category, 'constant');
check('string 的类别是 class', cppBuiltin('string').category, 'class');
check('move 的类别是 function', cppBuiltin('move').category, 'function');
check(
  '文件里的同名定义排在内置清单之前（候选池去重会保留用户的）',
  cppTopNames('int cout(void);').indexOf('cout'),
  0,
);

// 虚拟 std 命名空间
const CPP_STD_MEMBERS = [
  'cout',
  'cin',
  'cerr',
  'endl',
  'string',
  'vector',
  'map',
  'set',
  'pair',
  'shared_ptr',
  'unique_ptr',
  'size_t',
  'move',
  'swap',
  'make_unique',
  'make_shared',
];

check(
  'std:: → 弹出全部内置项（走 :: 成员访问分支）',
  JSON.stringify(cppNamesIn(CPP_EMPTY_SOURCE, ['std', '::'], '::')),
  JSON.stringify(CPP_STD_MEMBERS),
);
check('std:: 下 cout 的说明仍是全名', cppStdSymbol(['std', '::'], '::', 'cout').detail, 'std::cout');
check(
  'std:: 下 string 的类别是 class（不是 field —— 类别覆盖生效）',
  cppStdSymbol(['std', '::'], '::', 'string').category,
  'class',
);
check(
  'std:: 下 move 的类别是 function',
  cppStdSymbol(['std', '::'], '::', 'move').category,
  'function',
);

// 优先级：文件里真实扫到的类优先于内置清单
const CPP_SHADOW_SOURCE = ['class string {', 'public:', '    int mine;', '};', 'string s;'].join('\n');
check(
  '用户自己定义的 string 优先，不串到内置表',
  JSON.stringify(cppNamesIn(CPP_SHADOW_SOURCE, ['s', '.'], '.')),
  JSON.stringify(['mine']),
);

// 仍然静默不弹的场景
check('未定义的类型 Xyz:: 仍静默不弹', cppNamesIn(CPP_EMPTY_SOURCE, ['Xyz', '::'], '::').length, 0);
check('未声明的变量 x. 仍静默不弹', cppNamesIn(CPP_EMPTY_SOURCE, ['x', '.'], '.').length, 0);
check(
  '内置表里没有的内置类型（int）的变量也不弹',
  cppNamesIn(['int x;', 'x.'].join('\n'), ['x', '.'], '.').length,
  0,
);

console.log('--- CppAdapter 6.2：三个容器的方法表（键用短名）---');

// 有 / 无 `std::` 前缀两种写法都要弹 —— 类型推断已把它们合流成同一个短名
const CPP_CONTAINER_SOURCE = [
  'std::string a;',
  'using namespace std;',
  'string b;',
  'std::vector<int> c;',
  'vector<int> d;',
  'std::map<string, int> e;',
  'map<string, int> f;',
].join('\n');

const cppContainerOf = (name) => cppNamesIn(CPP_CONTAINER_SOURCE, [name, '.'], '.');
const cppContainerSymbol = (name, member) =>
  cppAllIn(CPP_CONTAINER_SOURCE, [name, '.'], '.').find((s) => s.name === member);

check('std::string a. → string 方法表', JSON.stringify(cppContainerOf('a')), JSON.stringify(CPP_STRING_METHODS));
check(
  'using namespace std 的短名写法 string b. → 同样弹（不漏）',
  JSON.stringify(cppContainerOf('b')),
  JSON.stringify(CPP_STRING_METHODS),
);
check(
  'std::vector<int> c. → vector 方法表（模板参数不影响）',
  JSON.stringify(cppContainerOf('c')),
  JSON.stringify(CPP_VECTOR_METHODS),
);
check('vector<int> d. → 同样弹', JSON.stringify(cppContainerOf('d')), JSON.stringify(CPP_VECTOR_METHODS));
check(
  'std::map<string, int> e. → map 方法表（模板里含逗号也剥对）',
  JSON.stringify(cppContainerOf('e')),
  JSON.stringify(CPP_MAP_METHODS),
);
check('map<string, int> f. → 同样弹', JSON.stringify(cppContainerOf('f')), JSON.stringify(CPP_MAP_METHODS));

// 区分性断言：证明确实取的是**对应**那张表，而不是随便哪一张
check('string 有 length（vector / map 都没有）', cppContainerOf('a').includes('length'), true);
check('string 有 rfind（只有它有）', cppContainerOf('a').includes('rfind'), true);
check('string 没有 reserve（那是 vector 的）', cppContainerOf('a').includes('reserve'), false);
check('vector 有 reserve（string / map 没有）', cppContainerOf('c').includes('reserve'), true);
check(
  'vector 有 push_back 与 front',
  ['push_back', 'front'].every((m) => cppContainerOf('c').includes(m)),
  true,
);
check('vector 没有 length', cppContainerOf('c').includes('length'), false);
check('map 有 count（只有它有）', cppContainerOf('e').includes('count'), true);
check('map 没有 push_back', cppContainerOf('e').includes('push_back'), false);
check('map 没有 length', cppContainerOf('e').includes('length'), false);

check('容器方法的类别是 method', cppContainerSymbol('a', 'size').category, 'method');
check('容器方法的说明带括号与归属（string::size()）', cppContainerSymbol('a', 'size').detail, 'string::size()');
check('vector 方法的说明带 vector 归属', cppContainerSymbol('c', 'resize').detail, 'vector::resize()');
check('map 方法的说明带 map 归属', cppContainerSymbol('e', 'count').detail, 'map::count()');

// 用户自定义同名类仍然优先
const CPP_USER_STRING = ['class string {', 'public:', '    int mine;', '};', 'string s;'].join('\n');
check(
  '用户自己的 class string 仍然优先（不弹内置方法表）',
  JSON.stringify(cppNamesIn(CPP_USER_STRING, ['s', '.'], '.')),
  JSON.stringify(['mine']),
);

// 守卫：内置表的键集合
const { BUILTIN_CPP_TYPE_MEMBERS } = require('../out/adapter/cpp/builtins.js');
check(
  '内置表里不允许出现 auto 键（auto 靠"查不到"实现，加了会乱弹）',
  BUILTIN_CPP_TYPE_MEMBERS.has('auto'),
  false,
);
check(
  '内置表的键恰好是 std + 三个容器',
  JSON.stringify([...BUILTIN_CPP_TYPE_MEMBERS.keys()]),
  JSON.stringify(['std', 'string', 'vector', 'map']),
);
check(
  '内置表里没有其它容器（list / deque / unordered_*）',
  ['list', 'deque', 'unordered_map', 'unordered_set'].every((key) => !BUILTIN_CPP_TYPE_MEMBERS.has(key)),
  true,
);

console.log('--- 装配（按 languageId 分组，一个 languageId 一条）---');
const { AdapterRegistry } = require('../out/adapter/registry.js');
const registry = new AdapterRegistry();
registry.register(python);
registry.register(cAdapter);
registry.register(cppAdapter);
const registrations = registry.registrations();

// 锚点是 **languageId 数**，不是适配器数 —— 一个 languageId 只能注册一次 provider。
// 曾经这条写的是「三个适配器三条」，正好把「.cpp 候选双倍」的错误行为锁成了验收标准。
check(
  '三个 languageId 三条装配信息（每个 languageId 一条）',
  JSON.stringify(registrations.map((r) => r.selectors)),
  JSON.stringify([['python'], ['c'], ['cpp']]),
);
check('python 的选择器只含 python', JSON.stringify(registrations[0].selectors), '["python"]');
check('python 的触发字符是 . ( , )', registrations[0].triggerCharacters.join(''), '.(,)');
check('python 那边没有 C 的 ->（不跨语言泄漏）', registrations[0].triggerCharacters.includes('->'), false);
check('c 的选择器只含 c', JSON.stringify(registrations[1].selectors), '["c"]');
check('c 的触发字符含 >（来自 -> 的末字符）', registrations[1].triggerCharacters.includes('>'), true);
check('c 的语言里没有 C++ 的 :（不跨语言泄漏）', registrations[1].triggerCharacters.includes(':'), false);
check('cpp 的选择器只含 cpp', JSON.stringify(registrations[2].selectors), '["cpp"]');
check(
  'cpp 的触发字符是 C 与 Cpp 的并集（含 > 与 :）',
  registrations[2].triggerCharacters.includes('>') && registrations[2].triggerCharacters.includes(':'),
  true,
);

// ★ 通用不变量：每个 languageId 只注册一次
// —— VSCode 凡命中的注册都会调用 provider，重复注册会让候选成倍（.cpp 双倍就是这么来的）
const registeredLanguages = registrations.flatMap((r) => r.selectors);
check(
  '每个 languageId 在注册列表里只出现一次',
  JSON.stringify(registeredLanguages),
  JSON.stringify([...new Set(registeredLanguages)]),
);
/** 某个 languageId 会被几条注册覆盖 */
const hitCount = (languageId) => registrations.filter((r) => r.selectors.includes(languageId)).length;
check('cpp 只命中一条注册（候选不会双倍）', hitCount('cpp'), 1);
check('c 与 python 也各只命中一条', JSON.stringify(['c', 'python'].map(hitCount)), '[1,1]');

// 通用不变量：触发字符必须全是单字符
// —— 多字符项会被 VSCode 静默忽略（曾因此让 C 的 -> 从阶段 5 起一直不触发）
const allTriggerCharacters = registrations.flatMap((r) => r.triggerCharacters);
check(
  '触发字符全是单字符（多字符项会被 VSCode 静默忽略）',
  allTriggerCharacters.every((character) => character.length === 1),
  true,
);
check('C 的触发字符不含多字符项 ->', registrations[1].triggerCharacters.includes('->'), false);
check('C 的触发字符不含 -（敲 - 不必叫醒 provider）', registrations[1].triggerCharacters.includes('-'), false);
check('Cpp 的触发字符不含多字符项 ::', registrations[2].triggerCharacters.includes('::'), false);
check(
  'C 与 Cpp 的分隔符里仍然保留多字符项（切段要用）',
  JSON.stringify([cStrategy.delimiters.includes('->'), cppAdapter.getSegmentStrategy().delimiters.includes('::')]),
  '[true,true]',
);
// resolve 从阶段 6 第一步起按 document 解析（不再接收 languageId 字符串）。
// mock 必须带 fileName —— CAdapter.claims 会读它（少了这个会直接抛异常）
const docWithLanguage = (languageId) => ({
  languageId,
  fileName: `sample.${languageId}`,
  getText: () => '',
});
check('python 文件命中 python 适配器', registry.resolve(docWithLanguage('python')).name, 'python');
check('c 文件命中 C 适配器', registry.resolve(docWithLanguage('c')).name, 'c');
check('markdown 文件没有适配器（不弹候选）', registry.resolve(docWithLanguage('markdown')) ?? null, null);
check('没有任何 languageIds 为 * 的兜底适配器', registrations.some((r) => r.selectors.includes('*')), false);

console.log('--- resolve 的认领机制（阶段 6 第一步）---');
/** 造一个最小字段的假适配器，单测 resolve 的机制（真实的 C/C++ 互斥断言在第 2 步加） */
const mockAdapter = (name, languageIds, claims) => ({
  name,
  languageIds,
  claims,
  scanSymbols: () => [],
  getLiterals: () => [],
  getSegmentStrategy: () => ({}),
});

const noClaim = new AdapterRegistry();
noClaim.register(mockAdapter('plain', ['x']));
check('未实现 claims → 按 languageId 认领', noClaim.resolve(docWithLanguage('x')).name, 'plain');
check('languageId 不命中 → undefined', noClaim.resolve(docWithLanguage('y')) ?? null, null);

const claimsYes = new AdapterRegistry();
claimsYes.register(mockAdapter('yes', ['x'], () => true));
check('claims 返回 true → 认领', claimsYes.resolve(docWithLanguage('x')).name, 'yes');

const claimsNo = new AdapterRegistry();
claimsNo.register(mockAdapter('no', ['x'], () => false));
check('claims 返回 false → 让位（undefined）', claimsNo.resolve(docWithLanguage('x')) ?? null, null);

const claimsMixed = new AdapterRegistry();
claimsMixed.register(mockAdapter('no', ['x'], () => false));
claimsMixed.register(mockAdapter('yes', ['x'], () => true));
check('前面让位、后面认领 → 取后面那个', claimsMixed.resolve(docWithLanguage('x')).name, 'yes');

const claimsOtherLanguage = new AdapterRegistry();
claimsOtherLanguage.register(mockAdapter('other', ['z'], () => true));
check(
  'claims 恒真但 languageId 不命中 → 仍 undefined',
  claimsOtherLanguage.resolve(docWithLanguage('x')) ?? null,
  null,
);

console.log('--- 认领判据互斥（真实适配器：CAdapter + CppAdapter）---');
// 两个 claims 是**同一判据的两面**，所以注册顺序不该影响 resolve 结果。
// 这里刻意用真实适配器（不是 mock），因为它要守的就是这两个实现的互斥性。
const realRegistry = new AdapterRegistry();
realRegistry.register(cAdapter);
realRegistry.register(cppAdapter);

const pureCHeader = { languageId: 'cpp', fileName: 'pure.h', getText: () => 'int foo(void);' };
const cppHeader = { languageId: 'cpp', fileName: 'cppish.h', getText: () => 'class Foo {};' };
const cppSource = { languageId: 'cpp', fileName: 'main.cpp', getText: () => 'int main() {}' };
const cFile = { languageId: 'c', fileName: 'main.c', getText: () => 'int foo(void);' };
const claimCases = [pureCHeader, cppHeader, cppSource, cFile];

check('纯 C 的 .h → CAdapter 认领', realRegistry.resolve(pureCHeader).name, 'c');
check('含 class 的 .h → CppAdapter 认领', realRegistry.resolve(cppHeader).name, 'cpp');
check('.cpp → CppAdapter 认领', realRegistry.resolve(cppSource).name, 'cpp');
check('.c → CAdapter 认领', realRegistry.resolve(cFile).name, 'c');

// 硬守卫：每个文件被认领它的适配器数量必须恰好是 1（不是 0，也不是 2）
const claimCounts = claimCases.map(
  (document) =>
    realRegistry
      .list()
      .filter(
        (adapter) =>
          adapter.languageIds.includes(document.languageId) &&
          (adapter.claims === undefined || adapter.claims(document)),
      ).length,
);
check('互斥性：每个文件恰好被 1 个适配器认领（不存在 0 个或 2 个）', JSON.stringify(claimCounts), '[1,1,1,1]');

// 顺序反转后结果必须一致 —— 这正是「判据互斥」要买到的性质
const reversedRegistry = new AdapterRegistry();
reversedRegistry.register(cppAdapter);
reversedRegistry.register(cAdapter);
check(
  '注册顺序反转：四种文件的归属完全不变',
  JSON.stringify(claimCases.map((document) => reversedRegistry.resolve(document).name)),
  JSON.stringify(['c', 'cpp', 'cpp', 'c']),
);

console.log('--- 工作区根目录白名单（防陌生文件混入）---');
// 根目录一级条目必须**恰好等于**这份白名单。
//
// 为什么需要这道检查：`.vscodeignore` 是**黑名单**（没列出的都会进包），仓库的 `.gitignore`
// 同理 —— 两处只要漏一条，无关文件（对话导出 / 日志 / 临时排查脚本 / 未清理的备份）
// 就会悄悄进包或进仓库。这道检查查的是**源头**：任何陌生条目一落进根目录，verify 立刻失败。
//
// 唯一的合法动态项是打包产物 `*.vsix`（会随打包出现 / 消失）。
// 注意 `Microsoft/`（PowerShell 缓存误落到这里产生的目录）**不在**白名单里 ——
// 它的正确处置是**删掉**，不是合法化；如果环境再次落缓存，就让这条断言失败提醒你手动清理。
const { readdirSync } = require('node:fs');

/** 根目录一级条目白名单（8 个目录 + 12 个文件 = 20 项） */
const ROOT_WHITELIST = [
  // 目录
  '.github',
  '.npm-cache',
  '.vscode',
  'docs',
  'node_modules',
  'out',
  'scripts',
  'src',
  // 文件
  '.editorconfig',
  '.gitignore',
  '.npmrc',
  '.vscodeignore',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];

/**
 * 合法的动态项 —— 这些条目「本地可能没有、CI 一定有」（或反之），所以**不能**进白名单：
 *
 *  - `*.vsix`：打包产物，会随打包出现 / 消失
 *  - `.git`：`git init` 之前本地没有，而 CI clone 下来天然带一个
 *
 * ⚠️ `.git` **绝不能**放进 `ROOT_WHITELIST` —— 那样未 init 的本地环境会反过来失败。
 * 踩过：这条断言在本地通过、在 CI 直接失败，根因就是它把「本地此刻的状态」当成了通用规则。
 */
const ROOT_DYNAMIC = [/\.vsix$/, /^\.git$/];

// verify 由 `npm run verify` 从项目根启动，所以 cwd 就是仓库根
const rootEntries = readdirSync(process.cwd())
  .filter((name) => !ROOT_DYNAMIC.some((pattern) => pattern.test(name)))
  .sort();

check(
  '根目录一级条目恰好等于白名单（多出陌生文件 / 少了已知文件都算失败）',
  JSON.stringify(rootEntries),
  JSON.stringify([...ROOT_WHITELIST].sort()),
);

console.log('');
// 断言总数校验：数字对不上就说明有断言没跑到（例如某条抛异常导致脚本提前终止），
// 这种情况下「FAIL: 0」是假绿 —— 必须当失败处理。
// 踩过一次：mock document 少了 fileName，claims 抛 TypeError，脚本在中间就死了，
// 后面 13 条断言全没跑，而 grep FAIL 却什么都查不到。
const EXPECTED_CHECKS = 279;
if (checkCount !== EXPECTED_CHECKS) {
  console.log(`断言总数不符：期望 ${EXPECTED_CHECKS}，实际 ${checkCount}（有断言没跑到？）`);
  failed++;
}
console.log(`断言总数：${checkCount} / ${EXPECTED_CHECKS}`);
if (failed === 0) {
  console.log('全部通过。');
} else {
  console.log(`有 ${failed} 项未通过。`);
  process.exitCode = 1;
}
