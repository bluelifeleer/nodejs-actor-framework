/**
 * `@actor/db` 的公开类型声明（手写，与 `src/index.ts` 的运行时导出一一对应）。
 *
 * 约定与内核一致：声明面是**使用者看到的**类型，运行时才是真相；两者漂移要有门禁盯着。
 * 设计见 `docs/design/m6-db-package.md`。
 */

// --- 方言 -------------------------------------------------------------------

export type Dialect = 'pgsql' | 'mysql' | 'sqlite';

export type LogicalType =
  | 'uuid'
  | 'string'
  | 'text'
  | 'integer'
  | 'bigint'
  | 'real'
  | 'boolean'
  | 'timestamp'
  | 'json'
  | 'blob';

export declare const DIALECTS: readonly Dialect[];
export declare const DEFAULT_PORTS: Record<Dialect, number | null>;
/** 各方言默认懒加载的驱动包名（sqlite 是内置模块，不需要安装）。 */
export declare const DRIVER_PACKAGES: Record<Dialect, string>;

/** 占位符风格：pg 用 `$n`，mysql/sqlite 用 `?`。 */
export declare function placeholderFor(dialect: Dialect): (index: number) => string;
/** 标识符引号 + 转义（pg/sqlite 双引号，mysql 反引号）。 */
export declare function quoteIdentifier(dialect: Dialect, name: string): string;
export declare function quoteTable(dialect: Dialect, schemaOrTable: string, table?: string): string;
/** 逻辑类型 → 真实列类型。 */
export declare function columnTypeFor(
  dialect: Dialect,
  logical: LogicalType,
  options?: { length?: number },
): string;

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

/** 解析连接配置（DSN 或字段式）；`dialect` 与 DSN 冲突时报错。 */
export declare function parseConnection(
  input: { url?: string; dialect?: Dialect } & Record<string, unknown>,
): NormalizedConnection;
/** 只用于日志/错误：**不含密码**。 */
export declare function describeConnection(connection: NormalizedConnection): string;
/** 从 DSN 猜方言。 */
export declare function dialectFromUrl(url: string): Dialect;
/** 不写 dialect 时的默认值：DSN 有就按 DSN，否则 `pgsql`。 */
export declare function dialectFor(options: { dialect?: Dialect; connection?: { url?: string } }): Dialect;

// --- 错误 -------------------------------------------------------------------

export declare class DbError extends Error {
  readonly code: string;
}
export declare class DbDriverMissingError extends DbError {
  readonly dialect: string;
  readonly driverPackage: string;
}
export declare class DbConfigError extends DbError {}
export declare class DbConnectionError extends DbError {}
export declare class DbNotConnectedError extends DbError {}

// --- 驱动 -------------------------------------------------------------------

export type Row = Record<string, unknown>;

/** 事务范围内的 runner；与 `@actor/data` 的 `SqlRunner` **结构兼容**（不互相 import）。 */
export interface Runner {
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  run(sql: string, params?: readonly unknown[]): Promise<number>;
  transaction?<R>(fn: (scoped: Runner) => Promise<R>): Promise<R>;
}

export interface PoolOptions {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export interface DriverPool extends Runner {
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  stats?(): Record<string, unknown> | null;
}

export interface DriverFactory {
  readonly name: string;
  create(connection: NormalizedConnection, pool: PoolOptions, dialect: Dialect): Promise<DriverPool>;
}

/** 从**应用根**解析模块（驱动装在用户项目里，不在本包的 node_modules 里）。 */
export interface DriverResolver {
  (specifier: string): unknown;
}
export declare function createAppRequire(root?: string): DriverResolver;
export declare function loadDriverModule<T>(
  specifier: string,
  dialect: string,
  packageName: string,
  resolve?: DriverResolver,
): T;

export declare function createSqliteDriver(loadModule?: () => unknown): DriverFactory;
export declare function createPgDriver(loadModule?: (resolve?: DriverResolver) => Promise<unknown>): DriverFactory;
export declare function createMysqlDriver(loadModule?: (resolve?: DriverResolver) => Promise<unknown>): DriverFactory;

// --- 数据库句柄 -------------------------------------------------------------

export interface DatabaseOptions {
  dialect?: Dialect;
  connection: ({ url: string } | Record<string, unknown>) & { dialect?: Dialect };
  pool?: PoolOptions;
  driver?: DriverFactory;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

export declare const DEFAULT_POOL: Required<PoolOptions>;

export interface HealthReport {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /** 目标连接（**不含密码**）。 */
  target: string;
}

export interface Database {
  readonly dialect: Dialect;
  readonly connection: NormalizedConnection;
  readonly driverName: string;
  /** 建池 + 一次健康检查；失败即抛。幂等。 */
  connect(): Promise<void>;
  /** 优雅关闭；幂等。关闭后 `healthCheck()` 返回 ok:false。 */
  close(): Promise<void>;
  healthCheck(): Promise<HealthReport>;
  /** 与 `@actor/data` 的 `SqlRunner` 结构兼容。 */
  runner(): Runner;
  /** 逃生通道：手写 SQL，仍然参数化。 */
  raw<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  rawRun(sql: string, params?: readonly unknown[]): Promise<number>;
  stats(): Record<string, unknown> | null;
}

/** 建一个数据库句柄（此刻还不连接）。 */
export declare function createDatabase(options: DatabaseOptions): Database;
export declare function defaultPortFor(dialect: Dialect): number | null;
