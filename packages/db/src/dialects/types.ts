import type { DriverFactory } from '../drivers/types.ts';
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
export type Dialect = 'pgsql' | 'mysql' | 'sqlite' | 'mssql';

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
 * 渲染列定义需要的**字段视图**。
 *
 * 为什么用"视图"而不是直接 import `model.ts` 的 `Field`：那样会形成
 * `model.ts → dialects/* → model.ts` 的循环依赖。`Field` 在结构上满足这个接口，
 * 所以调用处直接传 `Field` 即可，无需转换。
 */
export interface RenderableField {
  readonly column: string;
  readonly name: string;
  readonly type: LogicalType;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue?: unknown;
  readonly autoIncrement: boolean;
  readonly comment?: string;
}

/** 渲染建表语句需要的**表视图**（`Model` 结构上满足它）。 */
export interface RenderableModel {
  readonly table: string;
  readonly comment?: string;
  readonly fields: readonly RenderableField[];
}

/**
 * 自增身份的方言片段（位置有讲究，所以结构化返回而不是拼字符串）：
 *   - PostgreSQL：`beforeNotNull`（IDENTITY 写在类型后面、NOT NULL 前面）
 *   - MySQL：`afterNotNull`（AUTO_INCREMENT 必须是 NOT NULL 之后、PRIMARY KEY 之前）
 *   - SQLite：`override`（整个列定义接管：`"id" integer PRIMARY KEY AUTOINCREMENT`）
 */
export interface AutoIncrementPieces {
  override?: string;
  beforeNotNull?: string;
  afterNotNull?: string;
}

/** 内省出来的一列（各方言的行形状不同，由各自 `toColumn` 归一）。 */
export interface IntrospectedColumn {
  name: string;
  /** 规范化后的类型（用于与 model 声明比较）。 */
  type: string;
  /** 数据库原样报告的类型（报错时给人看）。 */
  rawType: string;
  notNull: boolean;
  hasDefault: boolean;
}

/** 内省：表存在性与列信息（SQLite 的 PRAGMA 不支持占位符，所以形状允许 `{ pragma }`）。 */
export interface Introspection {
  tableExists(table: string): { sql: string; params: readonly unknown[] };
  columns(table: string): { sql: string; params: readonly unknown[] } | { pragma: string };
  /** 把驱动返回的一行归一成列信息。 */
  toColumn(row: Record<string, unknown>): IntrospectedColumn;
}

/**
 * 类型文本的**通用**规范化：小写、去空格、需要时补长度。
 *
 * 各方言只需在 `normalizeDbType` 里先做自己的别名映射（pg 的 `character varying` → `varchar` 等），
 * 再调这里 —— 避免把同一段规则抄三遍。
 */
export function normalizeTypeText(rawType: string, length?: number | null): string {
  const text = String(rawType).toLowerCase().trim();
  const size = length ?? null;
  // 需要"补长度才能与 DDL 对上"的类型名（含 SQL Server 的 n 前缀与二进制类型）
  const needsLength = /^(n?varchar|n?char|character|varbinary|binary)$/.test(text);
  return needsLength && size !== null && !text.includes('(') ? `${text}(${size})` : text;
}

/** SQL 字符串字面量：单引号翻倍（三个方言通用）。 */
export function sqlString(text: string): string {
  return `'${String(text).split("'").join("''")}'`;
}

/** 数字字面量；非有限数直接报错（不写一个坏值进 DDL）。 */
export function numericLiteral(fieldName: string, value: unknown): string {
  if (!Number.isFinite(Number(value))) {
    throw new DbConfigError(`default for "${fieldName}" must be finite`);
  }
  return String(value);
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
  /**
   * 这个方言用哪个驱动（把"方言 → 驱动"的绑定也放进描述符）。
   *
   * 驱动本身仍是**懒加载**的：`() => createPgDriver()` 只返回工厂，真正 `import('pg')` 发生在连接时。
   */
  readonly driver: () => DriverFactory;
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

  // --- 语句装配（有些方言连"建表/加列"的关键字都不一样，所以留缝）----------
  /**
   * 建表语句。
   *
   * 为什么必须由方言给：`CREATE TABLE IF NOT EXISTS` 并不是所有方言都有 ——
   * SQL Server 要写成 `IF OBJECT_ID(N'…') IS NULL EXEC(N'CREATE TABLE …')`（T-SQL 的
   * CREATE TABLE 必须是批次首句，所以得走动态 SQL）。
   */
  createTable(model: RenderableModel, columns: string, options: { withComments: boolean }): string;
  /** 加列语句（`table` 已经引号转义过）：T-SQL 是 `ALTER TABLE t ADD col …`，**不写** `COLUMN`。 */
  alterAddColumn(table: string, column: string): string;

  // --- 列定义与注释 -----------------------------------------------------
  /** 自增身份的方言写法；非自增字段返回 `null`。 */
  autoIncrementPieces(field: RenderableField): AutoIncrementPieces | null;
  /** 默认值字面量；`null` = 字段没有默认值，或这个方言不给这种列写默认值。 */
  defaultLiteral(field: RenderableField): string | null;
  /** 内联列注释的**值部分**（`COMMENT ` 之后）；`null` = 该方言不支持内联注释。 */
  inlineComment(field: RenderableField): string | null;
  /** 建表语句的表级后缀（MySQL 的 `COMMENT='…'`）。 */
  tableSuffix(model: RenderableModel, options: { withComments: boolean }): string;
  /** 独立注释语句（PG 的 `COMMENT ON …`）；不支持的方言返回空数组（不假装）。 */
  commentStatements(model: RenderableModel): string[];
  /** 索引是否支持 `IF NOT EXISTS`（MySQL 不支持 → schema 层容忍"已存在"错误）。 */
  readonly indexIfNotExists: boolean;
  /** 这个错误是否只是"索引已存在"（MySQL 没有 IF NOT EXISTS 的补偿）。 */
  isDuplicateIndexError(error: unknown): boolean;

  // --- 内省 -------------------------------------------------------------
  introspection: Introspection;
  /** 把数据库报告的类型规范化到可比形式（先做方言别名映射，再走通用规则）。 */
  normalizeDbType(rawType: string, options: { length?: number | null }): string;

  // --- 值的表示（只放**真正随方言而异**的部分）--------------------------
  /** 写进库里的布尔：pg 用 `true/false`，mysql/sqlite 用 `1/0`。 */
  serializeBoolean(value: unknown): boolean | number;
  /** timestamp 列的写法：sqlite 是 TEXT（ISO 串），pg/mysql 直接给 `Date`。 */
  serializeTimestamp(date: Date): Date | string;

  // --- 注释能力位（代替 schema 层写方言名）-----------------------------
  readonly comments: 'statements' | 'inline' | 'none';

  // --- 连接形状 ---------------------------------------------------------
  /**
   * 连接是"一个文件"还是"host + 端口"。
   *
   * 用能力位而不是方言名：插件里"需要 host 的方言必须给 url"这条判断因此不需要点名 pgsql/mysql。
   */
  readonly connectionKind: 'file' | 'host';
  /** 字段式连接（`{ host, port, … }`）→ 规范化连接（sqlite 取 `filename`）。 */
  connectionFromFields(input: Record<string, unknown>): NormalizedConnection;
  /** DSN → 规范化连接（sqlite 的 path 是**文件名**，其它方言是 database）。 */
  connectionFromUrl(url: string): NormalizedConnection;
  /** 只用于日志/错误：**永远不含密码**。 */
  describe(connection: NormalizedConnection): string;
}

// --- 三个方言共用的连接处理（host 形式的方言直接用；sqlite 自己实现）---------

/** 字段式连接（host/port/user/password/database）—— pg 与 mysql 共用。 */
export function hostConnectionFromFields(
  input: Record<string, unknown>,
  dialect: Dialect,
  defaultPort: number | null,
): NormalizedConnection {
  const result: NormalizedConnection = { dialect };
  const port = input.port === undefined || input.port === null ? (defaultPort ?? undefined) : Number(input.port);
  // 严格模式（exactOptionalPropertyTypes）下不能给可选字段赋 undefined，所以逐个条件赋值
  if (typeof input.host === 'string' && input.host !== '') result.host = input.host;
  if (port !== undefined && port !== null) result.port = port;
  if (typeof input.user === 'string' && input.user !== '') result.user = input.user;
  if (typeof input.password === 'string' && input.password !== '') result.password = input.password;
  if (typeof input.database === 'string' && input.database !== '') result.database = input.database;
  if (result.host === undefined && result.database === undefined) {
    throw new DbConfigError('connection config needs at least a host or a database (or pass a full { url })');
  }
  return result;
}

/** DSN 解析（host 形式）—— pg 与 mysql 共用。 */
export function hostConnectionFromUrl(url: string, dialect: Dialect, defaultPort: number | null): NormalizedConnection {
  const parsed = new URL(url);
  const port = parsed.port === '' ? (defaultPort ?? undefined) : Number(parsed.port);
  const normalized: NormalizedConnection = { dialect, url };
  if (parsed.hostname !== '') normalized.host = parsed.hostname;
  if (port !== undefined && port !== null) normalized.port = port;
  if (parsed.username !== '') normalized.user = decodeURIComponent(parsed.username);
  if (parsed.password !== '') normalized.password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.replace(/^\//, '');
  if (database !== '') normalized.database = database;
  return normalized;
}

/** 日志友好的描述（host 形式）—— **不含密码**。 */
export function hostDescribe(connection: NormalizedConnection, defaultPort: number | null): string {
  const host = connection.host ?? 'localhost';
  const port = connection.port ?? defaultPort ?? '';
  return `${connection.dialect}://${host}:${String(port)}/${String(connection.database ?? '')}`;
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
