/**
 * `@actor/data` —— 数据层（M3）。
 *
 * 边界规则（与 `@actor/app`、`@actor/web` 一致，见 docs/design/m3-data-evolution.md §2.6）：
 *   - 本包**不 import 内核**：内核只通过 `persistence.evolution` 的结构类型与本包对接；
 *   - 第 1 步（schema 演进）**零依赖**：全是纯函数 + 结构类型；
 *   - 依赖方向 data → app → core 不会出现环。
 *
 * 已实现（第 1 步）：事件信封 + upcast 注册表、快照信封 + 版本策略、
 * `defineEvolution()`（编译成内核 hook）。
 * 已实现（第 2 步）：事件溯源聚合 `defineAggregate()`（命令 → 事件、纯 applyEvent、信封接入）。
 * 已实现（第 3 步）：仓储契约 + memory / file / SQL 适配器（游标分页 / 等值过滤 / version 乐观锁）。
 * 已实现（第 4 步）：迁移框架（版本表 + 幂等 up/down + 默认拒绝启动）。
 * 已实现（第 5 步）：Outbox（事件日志即 outbox + 投递游标 + 至少一次 + 消费幂等去重）。
 * 已实现（第 6 步）：投影 / 读模型（断点续跑 + 去重 + 从 0 重建 / 影子重建）。
 *
 * M3（数据层与 schema 演进）的六步到此齐全，见 docs/design/m3-data-evolution.md。
 */
export {
  createEventEnvelope,
  createEventRegistry,
  defaultLegacyReader,
  defineEventSchema,
  EventSchemaError,
  isEventEnvelope,
  validateEventSchema,
  type EventEnvelope,
  type EventRegistry,
  type EventRegistryOptions,
  type EventSchema,
  type LegacyEvent,
  type LegacyReader,
  type Upcast,
} from './events.ts';

export {
  createSnapshotEnvelope,
  decodeSnapshot,
  isSnapshotEnvelope,
  SNAPSHOT_FORMAT_VERSION,
  StateEvolutionError,
  type SnapshotEnvelope,
  type SnapshotSchema,
} from './snapshot.ts';

export {
  defineEvolution,
  type EvolutionSpec,
  type PersistenceEvolution,
} from './evolution.ts';

export { createDataClock, type DataClock, type TimerHandle } from './clock/index.ts';

export {
  clearRepository,
  createProjectionRunner,
  ProjectionError,
  ProjectionHandleError,
  type ProjectionCatchUpResult,
  type ProjectionContext,
  type ProjectionRunner,
  type ProjectionRunnerOptions,
  type ProjectionSpec,
  type ProjectionStatus,
} from './projection/index.ts';

export {
  createDedupeSet,
  createFileOutboxCursor,
  createIdempotentConsumer,
  createMemoryOutboxCursor,
  createOutboxDispatcher,
  createOutboxLogReader,
  createSqlOutboxCursor,
  OutboxDeliveryError,
  OutboxError,
  type DedupeSet,
  type FileOutboxCursorOptions,
  type IdempotentConsumerOptions,
  type OutboxCursorStore,
  type OutboxDispatcher,
  type OutboxDispatcherOptions,
  type OutboxDrainResult,
  type OutboxEntry,
  type OutboxLogReader,
  type OutboxLogReaderOptions,
  type OutboxSqlRunner,
  type OutboxStats,
  type SqlOutboxCursorOptions,
} from './outbox/index.ts';

export {
  createFileMigrationStore,
  createMemoryMigrationStore,
  createMigrationRunner,
  createSqlMigrationStore,
  MigrationError,
  MigrationInterruptedError,
  MigrationPendingError,
  MigrationVersionError,
  type FileMigrationStoreOptions,
  type Migration,
  type MigrationContext,
  type MigrationRecord,
  type MigrationRunnerOptions,
  type MigrationSqlRunner,
  type MigrationStatus,
  type MigrationStore,
  type SqlMigrationStoreOptions,
} from './migration/index.ts';

export {
  compareRows,
  compareValues,
  createFileRepository,
  createMemoryRepository,
  createSqlRepository,
  decodeCursor,
  encodeCursor,
  normalizeQuery,
  RepositoryConflictError,
  RepositoryDuplicateError,
  RepositoryNotFoundError,
  RepositoryQueryError,
  resolveRepositoryOptions,
  type FileRepository,
  type FileRepositoryOptions,
  type SqlRepositoryOptions,
  type SqlRunner,
  type MemoryRepositoryOptions,
  type Repository,
  type RepositoryCapabilities,
  type RepositoryOptions,
  type RepositoryPage,
  type RepositoryQuery,
} from './repository/index.ts';

export {
  AggregateDefinitionError,
  AggregateEvolutionError,
  defaultCommandOf,
  defineAggregate,
  UnknownCommandError,
  type AggregateCommand,
  type AggregateCommandResult,
  type AggregateContext,
  type AggregateDefinition,
  type AggregateEvent,
  type AggregateSpec,
} from './aggregate.ts';

/** 数据层版本，便于诊断。 */
export const DATA_LAYER_VERSION = '0.1.0';
