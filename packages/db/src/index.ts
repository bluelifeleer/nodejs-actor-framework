/**
 * `@actor/db` —— 应用层数据库能力：方言（pgsql/mysql/sqlite）、连接与连接池管理、model 声明、ORM 行映射。
 *
 * 设计见 `docs/design/m6-db-package.md`。两条硬约束：
 *   1. **零运行时依赖**：驱动从用户项目懒加载（sqlite 用 Node 24 内置 `node:sqlite`）；
 *   2. **SQL 全参数化**：标识符走引号转义，值只走占位符。
 */
export {
  assertDialect,
  columnTypeFor,
  DIALECTS,
  DEFAULT_PORTS,
  DRIVER_PACKAGES,
  describeConnection,
  dialectFor,
  dialectFromUrl,
  parseConnection,
  placeholderFor,
  quoteIdentifier,
  quoteTable,
  type Dialect,
  type LogicalType,
  type NormalizedConnection,
} from './dialect.ts';

export {
  DbConfigError,
  DbConnectionError,
  DbDriverMissingError,
  DbError,
  DbNotConnectedError,
} from './errors.ts';

export { createAppRequire, loadDriverModule, type DriverResolver } from './drivers/resolve.ts';
export { createSqliteDriver } from './drivers/sqlite.ts';
export { createPgDriver } from './drivers/pg.ts';
export { createMysqlDriver } from './drivers/mysql.ts';
export type { DriverFactory, DriverPool, PoolOptions, Row, Runner } from './drivers/types.ts';

export { createDatabase, defaultPortFor, DEFAULT_POOL, type Database, type DatabaseOptions, type HealthReport } from './database.ts';

// --- model 层（用户写声明，框架生成 DDL / 做漂移检测）-------------------------
export { defineModel, type Field, type FieldHooks, type FieldSpec, type Index, type IndexSpec, type Model, type ModelSpec } from './model.ts';

// --- schema 层 ---------------------------------------------------------------
export {
  checkDrift,
  columnsSql,
  DbSchemaDriftError,
  inspectTable,
  normalizeDbType,
  syncModels,
  tableExistsSql,
  type ColumnInfo,
  type DriftReport,
  type SyncOptions,
  type SyncReport,
  type TableInfo,
} from './schema.ts';
