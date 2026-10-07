import { DIALECT_SPECS, dialectSpec } from './dialects/index.ts';
import type { DialectSpec } from './dialects/types.ts';
import {
  type ColumnTypeOptions,
  type Dialect,
  type LogicalType,
  type NormalizedConnection,
} from './dialects/types.ts';
import { DbConfigError } from './errors.ts';

// 类型都在 dialects/types.ts 里定义（避免与 dialects/* 形成循环依赖），这里**再导出**保持公开 API 不变。
export type {
  ColumnTypeOptions,
  Dialect,
  LogicalType,
  NormalizedConnection,
} from './dialects/types.ts';

/** 支持的方言（**由描述符注册表派生**：加方言只需在 dialects/index.ts 加一行）。 */
export const DIALECTS: readonly Dialect[] = Object.keys(DIALECT_SPECS) as Dialect[];

/** 从描述符里挑一个字段拼成 `Record<Dialect, T>`（避免逐方言手写，加方言不用回来改）。 */
function pickFromSpecs<T>(pick: (spec: DialectSpec) => T): Record<Dialect, T> {
  const result = {} as Record<Dialect, T>;
  for (const [dialect, spec] of Object.entries(DIALECT_SPECS)) result[dialect as Dialect] = pick(spec);
  return result;
}

/** 各方言的默认端口（由描述符派生；sqlite 没有端口 → null）。 */
export const DEFAULT_PORTS: Record<Dialect, number | null> = pickFromSpecs((spec) => spec.defaultPort);

/** 各方言默认懒加载的驱动包名（由描述符派生）。 */
export const DRIVER_PACKAGES: Record<Dialect, string> = pickFromSpecs((spec) => spec.driverPackage);

/** 值是不是已知方言（注册表驱动，不写方言名）。 */
export function isDialect(value: unknown): value is Dialect {
  return typeof value === 'string' && (DIALECTS as readonly string[]).includes(value);
}

/** 该方言是否支持 `INSERT … RETURNING`（自增主键靠它回读生成值）。 */
export function supportsReturning(dialect: Dialect): boolean {
  return dialectSpec(dialect).supportsReturning;
}

/** 占位符风格：pg 用 `$n`，mysql/sqlite 用 `?`（委托给方言描述符）。 */
export function placeholderFor(dialect: Dialect): (index: number) => string {
  return dialectSpec(dialect).placeholder;
}

/** 标识符引号 + 转义（同名引号翻倍）——防注入经由标识符。 */
export function quoteIdentifier(dialect: Dialect, name: string): string {
  return dialectSpec(dialect).quote(name);
}

/** `schema.table`（sqlite 没有 schema，会忽略 schema 参数）。 */
export function quoteTable(dialect: Dialect, schemaOrTable: string, maybeTable?: string): string {
  return dialectSpec(dialect).quoteTable(maybeTable === undefined ? undefined : schemaOrTable, maybeTable ?? schemaOrTable);
}

/**
 * 逻辑类型 → 真实列类型。
 *
 * 实现已搬到**方言描述符**（`dialects/<方言>.ts` 里的类型表，见 docs/design/m6-dialect-spec.md §4）：
 * 加类型＝在 3 张表各加一行；加方言＝加一个文件。这里保留原签名与行为，使用者无感。
 */
export function columnTypeFor(dialect: Dialect, logical: LogicalType, options: ColumnTypeOptions = {}): string {
  return dialectSpec(dialect).columnType(logical, options);
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
    // 连接形状（sqlite 的 path 是文件、其它是 database）由方言描述符负责
    return dialectSpec(explicit ?? fromUrl).connectionFromUrl(url);
  }

  return dialectSpec(explicit ?? 'pgsql').connectionFromFields(input);
}

/** 只用于日志/错误：**永远不含密码**。 */
export function describeConnection(connection: NormalizedConnection): string {
  return dialectSpec(connection.dialect).describe(connection);
}

/** `createDatabase({ dialect })` 的默认值：dsn 有就按 dsn，否则默认 pgsql。 */
export function dialectFor(options: { dialect?: Dialect; connection?: { url?: string } }): Dialect {
  if (options.dialect !== undefined) return assertDialect(options.dialect);
  const url = options.connection?.url;
  if (typeof url === 'string' && url !== '') return dialectFromUrl(url);
  return 'pgsql';
}
