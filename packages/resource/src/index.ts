/**
 * `@actor/resource`：受管资源契约与连接管控（与具体中间件无关，零运行时依赖）。
 *
 * 分层：本包（通用）→ 各能力包（`@actor/db-core` 是 SQL 契约、`@actor/redis`、`@actor/mongodb`、
 * 以及用户自装的适配器）。设计见 docs/design/m8-web-plugins.md §4。
 *
 * 用法（任何"需要被管住"的东西：数据库、缓存、邮件、消息队列、etcd…）：
 *
 * ```ts
 * const resource = supervise(myAdapter, { connection, pool, onEvent });
 * await resource.connect();
 * const client = await resource.acquire();
 * await resource.close();   // 幂等 + drain
 * ```
 */
export {
  DriverMissingError,
  ResourceConfigError,
  ResourceConnectionError,
  ResourceError,
  ResourceNotConnectedError,
  ResourceUnavailableError,
  // 兼容别名（同一类对象）
  DbConfigError,
  DbConnectionError,
  DbDriverMissingError,
  DbError,
  DbNotConnectedError,
  DbUnavailableError,
} from './errors.ts';

export { createAppRequire, loadDriverModule, type DriverResolver } from './resolve.ts';

export { mapPoolOptions, type BaseConnection, type PoolOptions } from './pool.ts';

export {
  defineManagedResource,
  defineManagedResource as managedResource,
  defineResourceAdapter,
  type AdapterConnectInput,
  type ManagedConnection,
  type ResourceAdapter,
  // 兼容别名
  type DatabaseAdapter,
  defineDatabaseAdapter,
} from './adapter.ts';

export {
  supervise,
  type ManagedResource,
  type ManagedResourceStats,
  type SupervisionEvent,
  type SupervisionOptions,
  type SupervisorState,
} from './managed.ts';

export {
  realDatabaseUrl,
  realResourceUrl,
  runManagedResourceContract,
  testWithDatabase,
  testWithResource,
  // 兼容别名
  runManagedConnectionContract,
  type ContractResourceFactory,
  type ContractResourceInput,
  type ManagedResourceContractOptions,
  // 兼容别名（类型）
  type ManagedConnectionContractOptions,
} from './testing.ts';

export {
  resourceAdapter,
  // 兼容别名
  databaseAdapter,
  type AdapterPluginApp,
  type AdapterPluginOptions,
  type AdapterPluginSpec,
} from './plugin.ts';
