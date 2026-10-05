/**
 * 把"事件/快照的演进规则"编译成内核对得上的 **`persistence.evolution` hook 对象**。
 *
 * 内核不认识信封，只认三个可选的同步纯函数（见 packages/core/src/store/persistence.ts）：
 *
 *   upcast(raw)           events 模式：每条事件在 applyEvent 之前调用
 *   decodeSnapshot(raw)   snapshot 模式：读取时校验版本 / 迁移；抛错 = 拒绝启动
 *   encodeSnapshot(state) snapshot 模式：写入时套信封
 *
 * 于是"数据格式"这件事完全留在数据层，内核保持零依赖、零格式知识。
 */

import {
  createEventRegistry,
  type EventRegistry,
  type EventSchema,
  type LegacyReader,
} from './events.ts';
import {
  createSnapshotEnvelope,
  decodeSnapshot,
  type SnapshotSchema,
} from './snapshot.ts';

export interface EvolutionSpec {
  /** 事件类型的升级链；可直接给 schema 数组，也可给已建好的注册表。 */
  events?: readonly EventSchema[] | EventRegistry;
  /** 快照的版本与迁移。 */
  snapshot?: SnapshotSchema;
  /** 旧格式事件的读取器（配合 `events` 使用）。 */
  legacy?: LegacyReader;
}

/** 内核 `persistence.evolution` 期望的形状（结构类型，不 import 内核）。 */
export interface PersistenceEvolution {
  upcast?(raw: unknown): unknown;
  decodeSnapshot?(raw: unknown): unknown;
  encodeSnapshot?(state: unknown): unknown;
}

function isEventRegistry(value: readonly EventSchema[] | EventRegistry): value is EventRegistry {
  const candidate = value as Partial<EventRegistry>;
  return (
    typeof candidate.upcast === 'function' &&
    typeof candidate.upcastAll === 'function' &&
    typeof candidate.types === 'function'
  );
}

/**
 * 声明一套演进规则，得到可以交给 `spawn(..., { persistence: { evolution } })` 的对象。
 *
 * ```ts
 * const evolution = defineEvolution({
 *   events: [defineEventSchema({ type: 'ItemAdded', version: 3, upcasts: [...] })],
 *   snapshot: { version: 3, migrate: (state, { from }) => upgrade(state, from) },
 * });
 * ```
 *
 * 什么都不声明会**报错**（而不是返回一个空对象）：拼错 `event:`/`snapshots:` 这类
 * 静默失效最难排查。
 */
export function defineEvolution(spec: EvolutionSpec): PersistenceEvolution {
  const { events, snapshot, legacy } = spec ?? {};
  const evolution: PersistenceEvolution = {};

  if (events !== undefined) {
    const registry = isEventRegistry(events)
      ? events
      : createEventRegistry(events, legacy === undefined ? {} : { legacy });
    evolution.upcast = (raw: unknown) => registry.upcast(raw);
  } else if (legacy !== undefined) {
    throw new Error('defineEvolution: 只给 legacy 而没有给 events —— 旧格式读取器需要配合升级链才有意义');
  }

  if (snapshot !== undefined) {
    evolution.decodeSnapshot = (raw: unknown) => decodeSnapshot(raw, snapshot);
    evolution.encodeSnapshot = (state: unknown) =>
      createSnapshotEnvelope(state, { stateVersion: snapshot.version });
  }

  if (evolution.upcast === undefined && evolution.decodeSnapshot === undefined) {
    throw new Error('defineEvolution: 至少要声明 events 或 snapshot 其中之一（检查是否写错了字段名）');
  }

  return evolution;
}
