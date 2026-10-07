/**
 * `@actor/resource` 的手写声明面（与 src/index.ts 的运行时导出一一对应，由门禁测试盯着）。
 * 设计见 docs/design/m8-web-plugins.md §4。
 */

// --- 错误 ------------------------------------------------------------------
export declare class ResourceError extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}
export declare class DriverMissingError extends ResourceError {
  readonly dialect: string;
  readonly driverPackage: string;
  constructor(dialect: string, driverPackage: string, cause?: unknown);
}
export declare class ResourceConfigError extends ResourceError {
  constructor(message: string);
}
export declare class ResourceConnectionError extends ResourceError {
  constructor(message: string, cause?: unknown);
}
export declare class ResourceNotConnectedError extends ResourceError {
  constructor(what?: string);
}
export declare class ResourceUnavailableError extends ResourceError {
  readonly state: string;
  constructor(kind: string, state: string, detail?: string);
}
/** 兼容别名：同一个类对象（`instanceof` 不变）。 */
export declare const DbError: typeof ResourceError;
export declare const DbConfigError: typeof ResourceConfigError;
export declare const DbConnectionError: typeof ResourceConnectionError;
export declare const DbNotConnectedError: typeof ResourceNotConnectedError;
export declare const DbUnavailableError: typeof ResourceUnavailableError;
export declare const DbDriverMissingError: typeof DriverMissingError;

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

// --- 池与连接 --------------------------------------------------------------
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
export interface ResourceAdapter<C = unknown, Conn extends BaseConnection = BaseConnection> {
  readonly kind: string;
  readonly driverPackage: string;
  readonly connectionKind: 'host' | 'file' | 'url';
  readonly config?: Record<string, unknown>;
  connectionFromUrl?(url: string): Conn;
  describe?(connection: Conn): string;
  connect(input: AdapterConnectInput<Conn>): Promise<ManagedConnection<C>>;
}
/** 兼容别名。 */
export type DatabaseAdapter<C = unknown, Conn extends BaseConnection = BaseConnection> = ResourceAdapter<C, Conn>;
export declare function defineResourceAdapter<C = unknown, Conn extends BaseConnection = BaseConnection>(
  spec: ResourceAdapter<C, Conn>,
): ResourceAdapter<C, Conn>;
export declare const defineDatabaseAdapter: typeof defineResourceAdapter;
export declare function defineManagedResource<C = unknown, Conn extends BaseConnection = BaseConnection>(
  spec: ResourceAdapter<C, Conn>,
): ResourceAdapter<C, Conn>;

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
  adapter: ResourceAdapter<C, Conn>,
  options: SupervisionOptions<Conn>,
): ManagedResource<C>;

// --- 接进应用 --------------------------------------------------------------
export interface AdapterPluginApp {
  config: { get<T>(key: string): T };
  provide?(name: string, value: unknown): void;
  get?<T>(name: string): T;
}
export interface AdapterPluginSpec {
  name: string;
  config: Record<string, unknown>;
  onReady(app: AdapterPluginApp): Promise<void>;
  onStopping(app: AdapterPluginApp): Promise<void>;
}
export interface AdapterPluginOptions<Conn extends BaseConnection = BaseConnection> {
  name?: string;
  connection?: Conn;
  pool?: SupervisionOptions<Conn>['pool'];
  requireHealthy?: boolean;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
  onEvent?: (event: SupervisionEvent) => void;
  supervision?: Omit<SupervisionOptions<Conn>, 'connection' | 'pool' | 'logger' | 'onEvent'>;
}
export declare function resourceAdapter<C = unknown, Conn extends BaseConnection = BaseConnection>(
  adapter: ResourceAdapter<C, Conn>,
  options?: AdapterPluginOptions<Conn>,
): AdapterPluginSpec;
/** 兼容别名。 */
export declare const databaseAdapter: typeof resourceAdapter;

// --- 契约套件（测试工具）---------------------------------------------------
export interface ContractResourceInput {
  onEvent: (event: SupervisionEvent) => void;
  drainTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  keepAliveIntervalMs?: number;
}
export type ContractResourceFactory = (input: ContractResourceInput) => ManagedResource<unknown>;
export interface ManagedResourceContractOptions {
  name: string;
  make: ContractResourceFactory;
  makeFailing?: ContractResourceFactory;
  supportsKeepAlive?: boolean;
  supportsDrain?: boolean;
  counters?: { healthChecks: () => number; keepAlives?: () => number };
  setHealthy?: (healthy: boolean) => void;
}
export declare function runManagedResourceContract(options: ManagedResourceContractOptions): void;
/** 兼容别名。 */
export declare const runManagedConnectionContract: typeof runManagedResourceContract;
export type ManagedConnectionContractOptions = ManagedResourceContractOptions;
export declare function realResourceUrl(envVar: string): string | undefined;
export declare function testWithResource(envVar: string, name: string, fn: () => void | Promise<void>): void;
/** 兼容别名。 */
export declare const realDatabaseUrl: typeof realResourceUrl;
export declare const testWithDatabase: typeof testWithResource;

/** T1 短名：与 `defineManagedResource` **同一个对象**（恒等断言见 test/unit-sugar-aliases.test.js）。 */
export declare const managedResource: typeof defineManagedResource;
