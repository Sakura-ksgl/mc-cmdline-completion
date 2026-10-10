import type { SymbolInfo } from '../types';

/**
 * C 标准库常用函数清单（硬编码）。
 *
 * 这是「只扫当前打开的文件」这条硬约束的**唯一**例外，
 * 而且只存在于适配器内部 —— 通用层不知道有这回事，它只看到一堆普通符号。
 */

/** 常用项，按用途分组便于维护 */
const BUILTIN_FUNCTION_NAMES: string[] = [
  // 输入输出
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf',
  'puts', 'putchar', 'getchar', 'fgets', 'fputs', 'fopen', 'fclose',
  'fread', 'fwrite', 'fflush', 'perror',
  // 内存
  'malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memmove', 'memset', 'memcmp',
  // 字符串
  'strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat', 'strncat',
  'strchr', 'strrchr', 'strstr', 'strtok', 'strdup',
  // 转换
  'atoi', 'atol', 'atof', 'strtol', 'strtoul', 'strtod', 'strtof', 'abs', 'labs',
  'qsort', 'bsearch',
  // 数学
  'sqrt', 'pow', 'fabs', 'floor', 'ceil', 'round', 'sin', 'cos', 'tan',
  'log', 'log10', 'exp', 'rand', 'srand',
  // 断言与进程
  'assert', 'exit', 'abort', 'system', 'getenv', 'setenv',
];

/** 内置函数候选（作为普通符号返回，kind 用 function） */
export const BUILTIN_FUNCTIONS: SymbolInfo[] = BUILTIN_FUNCTION_NAMES.map((name) => ({
  name,
  category: 'function',
  detail: 'C 标准库函数',
}));
