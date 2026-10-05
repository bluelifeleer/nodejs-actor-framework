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
 * 后续步骤：Repository（第 3 步）、迁移框架（第 4 步）、
 * Outbox（第 5 步）、投影（第 6 步）。
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
