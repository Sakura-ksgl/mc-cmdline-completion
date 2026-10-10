import type { SymbolInfo } from '../types';

/**
 * Python 适配器硬编码的内置清单（范围 B 第 2、3 条）。
 *
 * 这是「只扫当前打开的文件」这条硬约束的**唯一**例外，
 * 而且只存在于适配器内部 —— 通用层不知道有这回事，它只看到一堆符号。
 */

/** 范围 B 支持类型推断的字面量类型 */
export type PythonType = 'str' | 'list' | 'dict' | 'int' | 'float';

/** 内置函数名（常用项，硬编码） */
const BUILTIN_FUNCTION_NAMES: string[] = [
  'print', 'len', 'range', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'input', 'open', 'enumerate', 'zip', 'map', 'filter', 'sum', 'min', 'max', 'abs', 'round',
  'sorted', 'reversed', 'isinstance', 'issubclass', 'type', 'repr', 'format', 'super', 'id',
  'hash', 'iter', 'next', 'callable', 'getattr', 'setattr', 'hasattr', 'vars', 'dir',
];

/** 内置函数候选 */
export const BUILTIN_FUNCTIONS: SymbolInfo[] = BUILTIN_FUNCTION_NAMES.map((name) => ({
  name,
  category: 'function',
  detail: 'Python 内置函数',
}));

/** 各内置类型的常用方法名（硬编码） */
const TYPE_METHOD_NAMES: Record<PythonType, string[]> = {
  str: [
    'upper', 'lower', 'strip', 'lstrip', 'rstrip', 'split', 'rsplit', 'join', 'replace',
    'startswith', 'endswith', 'find', 'rfind', 'index', 'count', 'format', 'capitalize',
    'title', 'casefold', 'center', 'ljust', 'rjust', 'zfill', 'isdigit', 'isalpha', 'isalnum',
    'isspace', 'isupper', 'islower', 'splitlines', 'encode',
  ],
  list: [
    'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'index', 'count', 'sort',
    'reverse', 'copy',
  ],
  dict: [
    'get', 'keys', 'values', 'items', 'update', 'pop', 'popitem', 'setdefault', 'clear',
    'copy', 'fromkeys',
  ],
  int: [
    'bit_length', 'bit_count', 'to_bytes', 'from_bytes', 'as_integer_ratio', 'conjugate',
  ],
  float: [
    'is_integer', 'hex', 'as_integer_ratio', 'conjugate',
  ],
};

/** 类型 → 该方法类型的候选（只在成员访问语境下给出） */
export const TYPE_METHODS: Record<PythonType, SymbolInfo[]> = {
  str: methodSymbols('str', TYPE_METHOD_NAMES.str),
  list: methodSymbols('list', TYPE_METHOD_NAMES.list),
  dict: methodSymbols('dict', TYPE_METHOD_NAMES.dict),
  int: methodSymbols('int', TYPE_METHOD_NAMES.int),
  float: methodSymbols('float', TYPE_METHOD_NAMES.float),
};

function methodSymbols(type: PythonType, names: string[]): SymbolInfo[] {
  return names.map((name) => ({
    name,
    category: 'method',
    detail: `${type}.${name}()`,
  }));
}
