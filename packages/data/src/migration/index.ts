/**
 * 迁移框架（M3 第 4 步）：版本表 + 幂等 up/down + **默认拒绝启动**。
 */

export {
  MigrationError,
  MigrationInterruptedError,
  MigrationPendingError,
  MigrationVersionError,
  type Migration,
  type MigrationContext,
  type MigrationRecord,
  type MigrationStore,
} from './types.ts';

export {
  createFileMigrationStore,
  createMemoryMigrationStore,
  createSqlMigrationStore,
  type FileMigrationStoreOptions,
  type MigrationSqlRunner,
  type SqlMigrationStoreOptions,
} from './stores.ts';

export {
  createMigrationRunner,
  type MigrationRunnerOptions,
  type MigrationStatus,
} from './runner.ts';
