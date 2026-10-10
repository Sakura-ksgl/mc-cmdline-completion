import type { SymbolCategory, SymbolInfo } from '../types';
import type { CppMember } from './cppScanner';

/**
 * C++ 标准库常用项（硬编码）。
 *
 * 这是「只扫当前打开的文件」的**唯一例外** —— 清单硬编码在适配器目录内，
 * 不去扫标准库头文件、不建索引、不读工作区。
 *
 * 覆盖范围（已与用户确认）：
 *  - 常用全局项 / 类型名 / 少数工具函数（**短名显示、说明里写全名**）
 *  - 虚拟的 `std` 命名空间（敲 `std::` 时给同一批项）
 *  - 三个容器的方法表：`string` / `vector` / `map`（6.2 小步加）
 *
 * **明确不做**：其它容器（list / deque / unordered_*）、运算符重载
 * （`std::cout <<` 是运算符，不是成员函数）。
 */

/** 一条内置项：短名、说明里的全名、以及它属于哪一类 */
interface CppBuiltinEntry {
  name: string;
  category: SymbolCategory;
  /** 说明里写的全名，如 `std::string` */
  qualified: string;
}

/**
 * 常用内置项。
 *
 * 短名给候选（`string`）、全名进说明（`std::string`）—— 与命名空间的显示约定一致：
 * 用户敲的是短名所以要能匹配上，归属写在全名里。
 */
const CPP_BUILTIN_ENTRIES: CppBuiltinEntry[] = [
  // 流对象与操纵符：它们不是类型，是对象 / 值
  { name: 'cout', category: 'constant', qualified: 'std::cout' },
  { name: 'cin', category: 'constant', qualified: 'std::cin' },
  { name: 'cerr', category: 'constant', qualified: 'std::cerr' },
  { name: 'endl', category: 'constant', qualified: 'std::endl' },
  // 常用类型
  { name: 'string', category: 'class', qualified: 'std::string' },
  { name: 'vector', category: 'class', qualified: 'std::vector' },
  { name: 'map', category: 'class', qualified: 'std::map' },
  { name: 'set', category: 'class', qualified: 'std::set' },
  { name: 'pair', category: 'class', qualified: 'std::pair' },
  { name: 'shared_ptr', category: 'class', qualified: 'std::shared_ptr' },
  { name: 'unique_ptr', category: 'class', qualified: 'std::unique_ptr' },
  { name: 'size_t', category: 'class', qualified: 'std::size_t' },
  // 工具函数
  { name: 'move', category: 'function', qualified: 'std::move' },
  { name: 'swap', category: 'function', qualified: 'std::swap' },
  { name: 'make_unique', category: 'function', qualified: 'std::make_unique' },
  { name: 'make_shared', category: 'function', qualified: 'std::make_shared' },
];

/** 普通语境下追加的符号：短名 + 全名说明 */
export const BUILTIN_CPP_SYMBOLS: SymbolInfo[] = CPP_BUILTIN_ENTRIES.map((entry) => ({
  name: entry.name,
  category: entry.category,
  detail: entry.qualified,
}));

/**
 * 内置**类型 / 命名空间**的成员表：键是类型名，值是成员。
 *
 * 目前只有虚拟的 `std`（6.2 再加 `string` / `vector` / `map` 三个容器的方法表）。
 *
 * **为什么与 `classMembers` 分开存**：`classMembers` 只装「本文件里真实扫到的类」，
 * 内置清单是另一份数据。查询时**先查文件、查不到再回退到这里** ——
 * 这样用户自己写的 `class string {...}` 天然优先，不需要写任何覆盖判断。
 */
/** 虚拟 `std` 命名空间的成员：就是那批内置项 */
const CPP_STD_MEMBERS: CppMember[] = CPP_BUILTIN_ENTRIES.map((entry) => ({
  name: entry.name,
  isMethod: entry.category === 'function',
  isStatic: false,
  // 类别与说明都直接给定，不走「类名::成员名」的拼装（那会拼出 `std::std` 之类）
  category: entry.category,
  detail: entry.qualified,
}));

/**
 * 三个容器的方法表。
 *
 * **键用短名**（`string` / `vector` / `map`）—— 因为类型推断那边走的是
 * 「剥模板参数 → 取类型部分**最后一个标识符**」，所以 `std::string s;` 与
 * `string s;`（`using namespace std` 写法）产出的类型名**都是 `string`**，
 * 一个键同时覆盖两种写法。改成全名键（`std::string`）反而会把短名写法漏掉。
 *
 * **明确不做**：其它容器（list / deque / unordered_*）、运算符重载
 * （`operator[]` / `std::cout <<` 都不是成员函数）。
 */
const CPP_BUILTIN_METHODS: Record<string, string[]> = {
  string: [
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
  ],
  vector: [
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
  ],
  map: ['insert', 'erase', 'find', 'count', 'size', 'empty', 'clear', 'at', 'begin', 'end'],
};

/** 方法名列表 → 成员列表（说明写成 `string::size()` 这样） */
function methodsOf(owner: string, names: string[]): CppMember[] {
  return names.map((name) => ({
    name,
    isMethod: true,
    isStatic: false,
    category: 'method',
    detail: `${owner}::${name}()`,
  }));
}

/**
 * 内置**类型 / 命名空间**的成员表：键是类型名，值是成员。
 *
 * 键：虚拟的 `std` + 三个容器（`string` / `vector` / `map`）。
 *
 * **为什么与 `classMembers` 分开存**：`classMembers` 只装「本文件里真实扫到的类」，
 * 内置清单是另一份数据。查询时**先查文件、查不到再回退到这里** ——
 * 这样用户自己写的 `class string {...}` 天然优先，不需要写任何覆盖判断。
 *
 * ⚠️ **不要往这张表里加 `auto` 键**：`auto a = 1;` 的类型名是 `auto`，
 * 现在靠"查不到"实现「auto 一律不弹」；加了这个键就会开始乱弹。
 * `verify.mjs` 有一条断言守着这一点。
 */
export const BUILTIN_CPP_TYPE_MEMBERS: Map<string, CppMember[]> = new Map([
  ['std', CPP_STD_MEMBERS],
  ...Object.entries(CPP_BUILTIN_METHODS).map(
    ([owner, names]): [string, CppMember[]] => [owner, methodsOf(owner, names)],
  ),
]);
