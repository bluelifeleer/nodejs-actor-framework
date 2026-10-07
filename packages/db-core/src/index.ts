/**
 * `@actor/db-core`：数据库适配器契约与连接管控（与具体数据库无关，零运行时依赖）。
 *
 * 分层：core（本包）→ 各适配器包（`@actor/db` 是 SQL 适配器、`@actor/redis`、`@actor/mongodb`、
 * 用户自装的 `@actor/db-xxx`）。设计见 docs/design/m7-multi-database.md。
 */
export {
  DbConfigError,
  DbConnectionError,
  DbConflictError,
  DbDriverMissingError,
  DbError,
  DbNotFoundError,
  DbNotConnectedError,
  DbUnavailableError,
} from './errors.ts';

export { createAppRequire, loadDriverModule, type DriverResolver } from './resolve.ts';

export {
  mapPoolOptions,
  type BaseConnection,
  type DriverFactory,
  type DriverPool,
  type PoolOptions,
  type Row,
  type Runner,
} from './pool.ts';

export {
  defineDatabaseAdapter,
  defineManagedResource,
  type AdapterConnectInput,
  type DatabaseAdapter,
  type ManagedConnection,
} from './adapter.ts';

// 契约套件（测试工具）：适配器包与**用户自装适配器**都用它自证合规
export {
  realDatabaseUrl,
  runManagedConnectionContract,
  testWithDatabase,
  type ContractResourceFactory,
  type ContractResourceInput,
  type ManagedConnectionContractOptions,
} from './testing.ts';

export {
  supervise,
  type ManagedResource,
  type ManagedResourceStats,
  type SupervisionEvent,
  type SupervisionOptions,
  type SupervisorState,
} from './managed.ts';
