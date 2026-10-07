import { DbConfigError } from './errors.ts';

/** 支持的方言。默认 `pgsql`（用户拍板）。 */
export type Dialect = 'pgsql' | 'mysql' | 'sqlite';

/** 逻辑字段类型：model 层写的是它，方言层负责映射成真实列类型。 */
export type LogicalType =
  | 'uuid'
  | 'string'
  | 'text'
  /** 定长字符串（`char(n)`，默认长度 1）；三方言都按标准走。 */
  | 'char'
  /** 小文本（MySQL `tinytext`；PG/SQLite 就是 `text`）。 */
  | 'tinyText'
  /** 大文本（MySQL `longtext`；PG/SQLite 就是 `text`）。 */
  | 'bigText'
  /** 中等文本（MySQL `mediumtext`；PG/SQLite 就是 `text`）。 */
  | 'mediumText'
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
  | 'timestamp'
  /** **不带时区**的时间戳（PG `timestamp` / MySQL `datetime(3)`）；要带时区请用 `timestamp`。 */
  | 'dateTime'
  | 'json'
  | 'blob'
  /** 定长/变长二进制（MySQL `varbinary(n)`）。 */
  | 'binary';

/** 列类型映射的附加参数（按需使用；不适用的方言忽略它）。 */
export interface ColumnTypeOptions {
  /** `string` / `binary` 的长度。 */
  length?: number;
  /** `decimal` 的总位数（默认 10）。 */
  precision?: number;
  /** `decimal` 的小数位（默认 2）。 */
  scale?: number;
}

export const DIALECTS: readonly Dialect[] = ['pgsql', 'mysql', 'sqlite'];

/** 各方言的默认端口（sqlite 没有端口）。 */
export const DEFAULT_PORTS: Record<Dialect, number | null> = { pgsql: 5432, mysql: 3306, sqlite: null };

/** 各方言默认懒加载的驱动包名。 */
export const DRIVER_PACKAGES: Record<Dialect, string> = { pgsql: 'pg', mysql: 'mysql2', sqlite: 'node:sqlite' };

/**
 * 该方言是否支持 `INSERT … RETURNING`（自增主键要靠它回读生成值）。
 * MySQL 没有 RETURNING，只能用结果里的 `insertId`。
 */
export function supportsReturning(dialect: Dialect): boolean {
  assertDialect(dialect);
  return dialect !== 'mysql';
}

/** 占位符风格：pg 用 `$n`，mysql/sqlite 用 `?`。 */
export function placeholderFor(dialect: Dialect): (index: number) => string {
  if (dialect === 'pgsql') return (index) => `$${index}`;
  return () => '?';
}

function quoteChar(dialect: Dialect): string {
  return dialect === 'mysql' ? '`' : '"';
}

/** 标识符引号 + 转义（同名引号翻倍）——防注入经由标识符。 */
export function quoteIdentifier(dialect: Dialect, name: string): string {
  const q = quoteChar(dialect);
  return `${q}${String(name).split(q).join(q + q)}${q}`;
}

/** `schema.table`（sqlite 没有 schema，忽略第二参）。 */
export function quoteTable(dialect: Dialect, schemaOrTable: string, maybeTable?: string): string {
  if (maybeTable === undefined || dialect === 'sqlite') return quoteIdentifier(dialect, schemaOrTable);
  return `${quoteIdentifier(dialect, schemaOrTable)}.${quoteIdentifier(dialect, maybeTable)}`;
}

/**
 * 逻辑类型 → 真实列类型。逐条对照（三个方言各一行），不做"听起来对"的猜测。
 */
export function columnTypeFor(dialect: Dialect, logical: LogicalType, options: ColumnTypeOptions = {}): string {
  // 未知方言必须报错：第一版这里对 uuid 用了 `dialect === 'pgsql' ? … : dialect === 'mysql' ? … : 'text'`，
  // 于是 'oracle' 会被**静默当成 sqlite** —— 测试抓到了这个"不认识的输入也照做"的洞。
  assertDialect(dialect);
  const length = options.length;
  switch (logical) {
    case 'uuid':
      // pg 有原生 uuid；mysql 用 char(36)；sqlite 没有类型系统（用 text 存）
      return dialect === 'pgsql' ? 'uuid' : dialect === 'mysql' ? 'char(36)' : 'text';
    case 'string':
      if (length !== undefined) return dialect === 'sqlite' ? 'text' : `varchar(${length})`;
      return dialect === 'mysql' ? 'varchar(255)' : 'text';
    case 'text':
      return 'text';
    case 'char': {
      // 定长：SQL 标准默认长度 1；sqlite 没有定长概念（用 text）
      const size = length ?? 1;
      return dialect === 'sqlite' ? 'text' : `char(${size})`;
    }
    case 'tinyText':
      return dialect === 'mysql' ? 'tinytext' : 'text';
    case 'bigText':
      // MySQL 区分 text/longtext；PG 与 SQLite 只有 text
      return dialect === 'mysql' ? 'longtext' : 'text';
    case 'mediumText':
      return dialect === 'mysql' ? 'mediumtext' : 'text';
    case 'tinyint':
      return dialect === 'mysql' ? 'tinyint' : dialect === 'pgsql' ? 'smallint' : 'integer';
    case 'smallint':
      return dialect === 'sqlite' ? 'integer' : 'smallint';
    case 'integer':
      return dialect === 'pgsql' ? 'integer' : dialect === 'mysql' ? 'int' : 'integer';
    case 'bigint':
      return dialect === 'sqlite' ? 'integer' : 'bigint';
    case 'decimal': {
      // 定点小数：三个方言都保留 precision/scale（sqlite 用 NUMERIC 亲和性，不会变成浮点）
      const precision = options.precision ?? 10;
      const scale = options.scale ?? 2;
      return dialect === 'mysql' ? `decimal(${precision}, ${scale})` : `numeric(${precision}, ${scale})`;
    }
    case 'float':
      // 4 字节浮点：pg 的 real 就是它；sqlite 只有 REAL
      return dialect === 'pgsql' ? 'real' : dialect === 'mysql' ? 'float' : 'real';
    case 'real':
      return dialect === 'pgsql' ? 'double precision' : dialect === 'mysql' ? 'double' : 'real';
    case 'boolean':
      return dialect === 'pgsql' ? 'boolean' : dialect === 'mysql' ? 'tinyint(1)' : 'integer';
    case 'date':
      // 只有日期：sqlite 没有 date 类型，用文本存（'YYYY-MM-DD' 字典序 == 时间序）
      return dialect === 'sqlite' ? 'text' : 'date';
    case 'time':
      return dialect === 'sqlite' ? 'text' : 'time';
    case 'timestamp':
      return dialect === 'pgsql' ? 'timestamptz' : dialect === 'mysql' ? 'datetime(3)' : 'text';
    case 'dateTime':
      // 不带时区：pg 的 timestamp（without time zone）；MySQL 的 datetime 本来就不带时区
      return dialect === 'pgsql' ? 'timestamp' : dialect === 'mysql' ? 'datetime(3)' : 'text';
    case 'json':
      return dialect === 'pgsql' ? 'jsonb' : dialect === 'mysql' ? 'json' : 'text';
    case 'blob':
      return dialect === 'pgsql' ? 'bytea' : dialect === 'mysql' ? 'blob' : 'blob';
    case 'binary':
      // 可变长二进制：MySQL 可以给长度；pg/sqlite 都是同一种
      if (dialect === 'mysql') return length === undefined ? 'varbinary(255)' : `varbinary(${length})`;
      return dialect === 'pgsql' ? 'bytea' : 'blob';
    default:
      throw new DbConfigError(`unknown logical field type "${String(logical)}"`);
  }
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

export function assertDialect(value: unknown): Dialect {
  if (value === undefined || value === null || value === '') return 'pgsql';
  if (DIALECTS.includes(value as Dialect)) return value as Dialect;
  throw new DbConfigError(`unknown dialect "${String(value)}": expected one of ${DIALECTS.join(', ')}`);
}

const SCHEME_TO_DIALECT: Record<string, Dialect> = {
  pgsql: 'pgsql',
  postgres: 'pgsql',
  postgresql: 'pgsql',
  mysql: 'mysql',
  sqlite: 'sqlite',
};

/** 从 DSN 猜方言（不认识就报错，不猜）。 */
export function dialectFromUrl(url: string): Dialect {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(url))?.[1]?.toLowerCase();
  const dialect = scheme === undefined ? undefined : SCHEME_TO_DIALECT[scheme];
  if (dialect === undefined) {
    throw new DbConfigError(`cannot infer the dialect from the connection url (scheme "${String(scheme)}")`);
  }
  return dialect;
}

/**
 * 解析连接配置。两种写法都支持：
 *   - DSN：`pgsql://user:pass@host:5432/db`、`mysql://user@host/db`、`sqlite:./data/app.db`
 *   - 字段式：`{ dialect, host, port, user, password, database }` / `{ dialect: 'sqlite', filename }`
 *
 * `dialect` 显式给出时必须与 DSN 一致（不一致直接报错，而不是悄悄用其中一个）。
 */
export function parseConnection(input: { url?: string; dialect?: Dialect } & Record<string, unknown>): NormalizedConnection {
  if (input === null || typeof input !== 'object') {
    throw new DbConfigError('connection config is required: pass { url } or { dialect, host, database, ... }');
  }
  const explicit = input.dialect === undefined ? undefined : assertDialect(input.dialect);
  const url = typeof input.url === 'string' && input.url !== '' ? input.url : undefined;

  if (url !== undefined) {
    const fromUrl = dialectFromUrl(url);
    if (explicit !== undefined && explicit !== fromUrl) {
      // 注意：错误信息里**不能**出现密码
      throw new DbConfigError(
        `connection url looks like ${fromUrl} but dialect ${explicit} was configured — remove one of them`,
      );
    }
    const dialect = explicit ?? fromUrl;
    if (dialect === 'sqlite') {
      const rest = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/)?/, '');
      return { dialect, filename: rest === '' ? ':memory:' : rest, url };
    }
    const parsed = new URL(url);
    const port = parsed.port === '' ? DEFAULT_PORTS[dialect] ?? undefined : Number(parsed.port);
    const normalized: NormalizedConnection = { dialect, url };
    // 严格模式（exactOptionalPropertyTypes）下不能给可选字段赋 undefined，所以逐个条件赋值
    if (parsed.hostname !== '') normalized.host = parsed.hostname;
    if (port !== undefined && port !== null) normalized.port = port;
    if (parsed.username !== '') normalized.user = decodeURIComponent(parsed.username);
    if (parsed.password !== '') normalized.password = decodeURIComponent(parsed.password);
    const database = parsed.pathname.replace(/^\//, '');
    if (database !== '') normalized.database = database;
    return normalized;
  }

  const dialect = explicit ?? 'pgsql';
  if (dialect === 'sqlite') {
    const filename = typeof input.filename === 'string' && input.filename !== '' ? input.filename : ':memory:';
    return { dialect, filename };
  }
  const port = input.port === undefined || input.port === null ? DEFAULT_PORTS[dialect] ?? undefined : Number(input.port);
  const result: NormalizedConnection = { dialect };
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

/** 只用于日志/错误：**永远不含密码**。 */
export function describeConnection(connection: NormalizedConnection): string {
  if (connection.dialect === 'sqlite') return `sqlite:${String(connection.filename ?? ':memory:')}`;
  const host = connection.host ?? 'localhost';
  const port = connection.port ?? DEFAULT_PORTS[connection.dialect] ?? '';
  return `${connection.dialect}://${host}:${String(port)}/${String(connection.database ?? '')}`;
}

/** `createDatabase({ dialect })` 的默认值：dsn 有就按 dsn，否则默认 pgsql。 */
export function dialectFor(options: { dialect?: Dialect; connection?: { url?: string } }): Dialect {
  if (options.dialect !== undefined) return assertDialect(options.dialect);
  const url = options.connection?.url;
  if (typeof url === 'string' && url !== '') return dialectFromUrl(url);
  return 'pgsql';
}
