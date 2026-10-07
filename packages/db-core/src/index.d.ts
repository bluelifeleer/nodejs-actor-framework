/**
 * `@actor/db-core` 的手写声明面（与 src/index.ts 的运行时导出一一对应，由门禁测试盯着）。
 * 设计见 docs/design/m7-multi-database.md。
 */

// --- 错误 ------------------------------------------------------------------
export declare class DbError extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}
export declare class DbDriverMissingError extends DbError {
  readonly dialect: string;
  readonly driverPackage: string;
  constructor(dialect: string, driverPackage: string, cause?: unknown);
}
export declare class DbConfigError extends DbError {
  constructor(message: string);
}
export declare class DbConnectionError extends DbError {
  constructor(message: string, cause?: unknown);
}
export declare class DbNotConnectedError extends DbError {
  constructor(what?: string);
}
export declare class DbUnavailableError extends DbError {
  readonly state: string;
  constructor(kind: string, state: string, detail?: string);
}
export declare class DbConflictError extends DbError {
  readonly id: string;
  readonly expectedVersion: number | null;
  constructor(id: string, expectedVersion?: number | null);
}
export declare class DbNotFoundError extends DbError {
  readonly id: string;
  constructor(id: string);
}

// --- 驱动解析 --------------------------------------------------------------
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

// --- 池与运行契约 ----------------------------------------------------------
export type Row = Record<string, unknown>;
export interface Runner {
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  run(sql: string, params?: readonly unknown[]): Promise<number>;
  transaction?<R>(fn: (scoped: Runner) => Promise<R>): Promise<R>;
  insertReturning?(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}
export interface PoolOptions {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}
export declare function mapPoolOptions(
  options: PoolOptions,
  mapping: Partial<Record<keyof PoolOptions, string>>,
): Record<string, unknown>;
export interface BaseConnection {
  readonly kind?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  filename?: string;
  url?: string;
}
export interface DriverPool<C extends BaseConnection = BaseConnection> extends Runner {
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  stats?(): Record<string, unknown> | null;
  readonly connection?: C;
}
export interface DriverFactory<C extends BaseConnection = BaseConnection> {
  readonly name: string;
  create(connection: C, pool: PoolOptions, kind: string): Promise<DriverPool<C>>;
}

// --- 适配器 ----------------------------------------------------------------
export interface ManagedConnection<C = unknown> {
  readonly client: C;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  stats?(): Record<string, unknown> | null;
  keepAlive?(): Promise<void>;
}
export interface AdapterConnectInput<Conn extends BaseConnection = BaseConnection> {
  readonly connection: Conn;
  readonly pool: PoolOptions;
  readonly logger?: (event: string, meta?: Record<string, unknown>) => void;
  readonly load: <T>(specifier: string, packageName?: string) => T;
  readonly emitDriverEvent?: (event: string, detail?: unknown) => void;
}
export interface DatabaseAdapter<C = unknown, Conn extends BaseConnection = BaseConnection> {
  readonly kind: string;
  readonly driverPackage: string;
  readonly connectionKind: 'host' | 'file' | 'url';
  readonly config?: Record<string, unknown>;
  connectionFromUrl?(url: string): Conn;
  describe?(connection: Conn): string;
  connect(input: AdapterConnectInput<Conn>): Promise<ManagedConnection<C>>;
}
export declare function defineDatabaseAdapter<C = unknown, Conn extends BaseConnection = BaseConnection>(
  spec: DatabaseAdapter<C, Conn>,
): DatabaseAdapter<C, Conn>;
export declare function defineManagedResource<C = unknown, Conn extends BaseConnection = BaseConnection>(
  spec: DatabaseAdapter<C, Conn>,
): DatabaseAdapter<C, Conn>;

// --- 连接管控 --------------------------------------------------------------
export type SupervisorState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'draining' | 'closed';
export type SupervisionEvent =
  | { type: 'connecting'; kind: string }
  | { type: 'connected'; kind: string; durationMs: number }
  | { type: 'health_failed'; kind: string; error: string }
  | { type: 'driver_event'; kind: string; event: string; detail?: unknown }
  | { type: 'unavailable'; kind: string; reason: string }
  | { type: 'draining'; kind: string; inFlight: number }
  | { type: 'closed'; kind: string };
export interface SupervisionOptions<Conn extends BaseConnection = BaseConnection> {
  readonly connection: Conn;
  readonly pool?: PoolOptions;
  readonly logger?: (event: string, meta?: Record<string, unknown>) => void;
  readonly onEvent?: (event: SupervisionEvent) => void;
  readonly healthCheckIntervalMs?: number;
  readonly keepAliveIntervalMs?: number;
  readonly drainTimeoutMs?: number;
  readonly resolve?: DriverResolver;
}
export interface ManagedResourceStats {
  readonly state: SupervisorState;
  readonly inFlight: number;
  readonly driver: Record<string, unknown> | null;
  readonly lastHealthError: string | null;
}
export interface ManagedResource<C = unknown> {
  readonly kind: string;
  readonly state: SupervisorState;
  connect(): Promise<void>;
  acquire(): Promise<C>;
  keepAlive(): Promise<void>;
  checkHealth(): Promise<void>;
  track<R>(work: Promise<R>): Promise<R>;
  stats(): ManagedResourceStats;
  close(): Promise<void>;
}
export declare function supervise<C = unknown, Conn extends BaseConnection = BaseConnection>(
  adapter: DatabaseAdapter<C, Conn>,
  options: SupervisionOptions<Conn>,
): ManagedResource<C>;

// --- 契约套件（测试工具）---------------------------------------------------
export interface ContractResourceInput {
  onEvent: (event: SupervisionEvent) => void;
  drainTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  keepAliveIntervalMs?: number;
}
export type ContractResourceFactory = (input: ContractResourceInput) => ManagedResource<unknown>;
export interface ManagedConnectionContractOptions {
  name: string;
  make: ContractResourceFactory;
  makeFailing?: ContractResourceFactory;
  supportsKeepAlive?: boolean;
  supportsDrain?: boolean;
  counters?: { healthChecks: () => number; keepAlives?: () => number };
  setHealthy?: (healthy: boolean) => void;
}
/** 跑一遍连接管理契约（用例注册在调用方的测试文件里）。 */
export declare function runManagedConnectionContract(options: ManagedConnectionContractOptions): void;
/** 读真库测试变量；没设（或空串）返回 undefined。 */
export declare function realDatabaseUrl(envVar: string): string | undefined;
/** 注册一个"有真库才跑"的用例；没配就注册**显式跳过**（输出里能看到 skipped）。 */
export declare function testWithDatabase(envVar: string, name: string, fn: () => void | Promise<void>): void;
