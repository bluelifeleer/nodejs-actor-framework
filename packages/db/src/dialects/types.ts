import { DbConfigError } from '../errors.ts';

/**
 * 方言描述符（`DialectSpec`）的共享类型与接口。
 *
 * 设计见 `docs/design/m6-dialect-spec.md`：**一个方言一个对象**，加方言时只写一个新文件，
 * 不用去改 `model.ts` / `schema.ts` / `repository.ts` / `mapping.ts`。
 *
 * 注意：这里只放**类型**，不放实现 —— 这样 `dialect.ts`（公开函数）与 `dialects/*.ts`（实现）
 * 之间不会形成循环依赖。
 */

/** 支持的方言。默认 `pgsql`。 */
export type Dialect = 'pgsql' | 'mysql' | 'sqlite';

/** 逻辑字段类型：model 层写的是它，方言层负责映射成真实列类型。 */
export type LogicalType =
  | 'uuid'
  | 'string'
  /** 定长字符串（`char(n)`，默认长度 1）；三方言都按标准走。 */
  | 'char'
  | 'text'
  /** 小文本（MySQL `tinytext`；PG/SQLite 就是 `text`）。 */
  | 'tinyText'
  /** 中等文本（MySQL `mediumtext`；PG/SQLite 就是 `text`）。 */
  | 'mediumText'
  /** 大文本（MySQL `longtext`；PG/SQLite 就是 `text`）。 */
  | 'bigText'
  /** 极小整数（MySQL `tinyint`；PG 用 `smallint`）。 */
  | 'tinyint'
  | 'smallint'
  | 'integer'
  | 'bigint'
  /** 定点小数：用 `precision`/`scale`（默认 10,2），**不要**拿它当浮点用。 */
  | 'decimal'
  /** 4 字节浮点（MySQL `float`；PG `real`）。要双精度请用 `real`。 */
  | 'float'
  | 'real'
  | 'boolean'
  /** 只有日期（`2026-10-07`），没有时间/时区。 */
  | 'date'
  /** 只有时间（`13:45:06`），没有日期/时区。 */
  | 'time'
  /** 带时区的时间戳（PG `timestamptz`）。 */
  | 'timestamp'
  /** **不带时区**的时间戳（PG `timestamp` / MySQL `datetime(3)`）。 */
  | 'dateTime'
  | 'json'
  | 'blob'
  /** 定长/变长二进制（MySQL `varbinary(n)`）。 */
  | 'binary';

/** 列类型映射的附加参数（按需使用；不适用的方言忽略它）。 */
export interface ColumnTypeOptions {
  /** `string` / `char` / `binary` 的长度。 */
  length?: number;
  /** `decimal` 的总位数（默认 10）。 */
  precision?: number;
  /** `decimal` 的小数位（默认 2）。 */
  scale?: number;
}

/** 规范化后的连接配置（DSN 或字段式都归一到这里）。 */
export interface NormalizedConnection {
  dialect: Dialect;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** sqlite 专用：文件路径（`:memory:` 表示内存库）。 */
  filename?: string;
  /** 原始 DSN（**不用于日志**）。 */
  url?: string;
}

/**
 * 一个方言的差异点。
 *
 * **步骤说明**：本次先搬"语法与类型"（Step 1）；`columnExtras`/`defaultLiteral`/`comments`/
 * `introspection`/`normalizeDbType`/`parseValue`/`serializeValue` 会在 Step 2/3 逐步搬进来
 * （见设计文档 §6 的迁移计划）。
 */
export interface DialectSpec {
  readonly name: Dialect;
  /** 懒加载的驱动包名（sqlite 是内置模块，不需要安装）。 */
  readonly driverPackage: string;
  readonly defaultPort: number | null;

  // --- 语法层面 ---------------------------------------------------------
  /** 占位符风格：pg 用 `$n`，mysql/sqlite 用 `?`。 */
  placeholder(index: number): string;
  /** 标识符引号 + 转义（同名引号翻倍）——防注入经由标识符。 */
  quote(name: string): string;
  /** `schema.table`（sqlite 没有 schema，会忽略 schema 参数）。 */
  quoteTable(schema: string | undefined, table: string): string;
  /** 该方言是否支持 `INSERT … RETURNING`（自增主键靠它回读生成值）。 */
  readonly supportsReturning: boolean;

  // --- 类型层面 ---------------------------------------------------------
  /** 逻辑类型 → 真实列类型（实现是每个方言一张类型表，见设计文档 §4）。 */
  columnType(logical: LogicalType, options: ColumnTypeOptions): string;
}

/** 每个方言一张类型表：`Record<LogicalType, …>` 让 TypeScript 强制补齐，漏一个就编译报错。 */
export type TypeRenderers = Record<LogicalType, (options: ColumnTypeOptions) => string>;

/**
 * 从类型表里取渲染函数；未知逻辑类型**明确报错**（三个方言共用一个守卫，避免各写一遍）。
 *
 * 为什么要守卫：TypeScript 只保证"表是完整的"，挡不住运行期传进来的字符串（用户从 JSON/配置里读的）。
 */
export function typeRendererFor(table: TypeRenderers, logical: LogicalType, dialect: Dialect): (options: ColumnTypeOptions) => string {
  const render = table[logical];
  if (typeof render !== 'function') {
    // 用公开的 DbConfigError（errors.ts 是叶子模块，不会形成循环依赖）
    throw new DbConfigError(`unknown logical field type "${String(logical)}" for dialect ${dialect}`);
  }
  return render;
}
