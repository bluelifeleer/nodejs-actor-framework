/**
 * 事件信封 + upcast 注册表（M3 第 1 步）。
 *
 * 这一层的全部职责是：**让"改数据结构"不再是破坏性变更**。
 * 做法是把结构版本写进盘上的数据，把升级做成**读取期的纯函数链**——
 * 原始日志只存不删、永不重写，所以升级可回滚、重放可重现。
 *
 * 边界（刻意为之）：本文件不 import 内核，也不 import app 层。
 * 内核只通过 `persistence.evolution.upcast` 这个**结构类型**调用它（见 packages/core/src/store/persistence.ts）。
 */

/** 盘上的事件信封：M3 起新写入的格式。 */
export interface EventEnvelope<P = unknown> {
  /** 全局唯一 id（第 5 步的 outbox 去重、第 6 步的投影幂等都要它）。 */
  eventId: string;
  /** 事件类型：upcast 链按它查找。 */
  type: string;
  /** 事件体的**结构版本**，从 1 开始。 */
  version: number;
  /** 写入时间（诊断/审计用，不参与状态推导）。 */
  at: number;
  /** 事件体；只有它参与状态推导。 */
  payload: P;
}

/** 一级升级：把 `from` 版本的事件体变成 `to` 版本。必须是**同步纯函数**。 */
export interface Upcast {
  from: number;
  to: number;
  up: (event: Record<string, unknown>) => Record<string, unknown>;
}

/** 一种事件类型的当前版本与升级链。 */
export interface EventSchema {
  type: string;
  /** 当前代码期望的版本；`1` 表示这是初版结构。 */
  version: number;
  /** 各段升级；允许一跳（`{ from: 1, to: 3 }`），但必须能覆盖 `1 → version`。 */
  upcasts?: readonly Upcast[];
}

/** 旧格式（M3 之前写入的原始 JSON）的解读结果。 */
export interface LegacyEvent {
  type: string;
  version: number;
  payload: unknown;
}

/**
 * 旧格式读取器：把一条没有信封的原始记录解读成 `{type, version, payload}`。
 * 返回 `null` 表示"认不出来"——此时**原样透传**（= M3 之前的行为，零破坏）。
 */
export type LegacyReader = (raw: unknown) => LegacyEvent | null;

/** 默认读取器：原始对象自带字符串 `type` ⇒ 视为该类型的 v1；否则透传。 */
export const defaultLegacyReader: LegacyReader = (raw) => {
  if (raw !== null && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string') {
    return { type: (raw as { type: string }).type, version: 1, payload: raw };
  }
  return null;
};

/** 事件结构演进失败（注册表配置错误 / 升级链缺口）。构造期或读取期抛出。 */
export class EventSchemaError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(
      `事件结构 schema 有问题（${issues.length} 项）：\n` + issues.map((i) => `  - ${i}`).join('\n'),
    );
    this.name = 'EventSchemaError';
    this.issues = issues;
  }
}

/** 只接受普通对象的事件体；数组/标量本身没有"字段"可升级。 */
function isPlainEvent(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 顶层冻结的一份浅拷贝。
 *
 * 这是对"upcast 不得改写输入"的**机械保证**：严格模式下写入冻结对象会抛 `TypeError`，
 * 而不是悄悄污染原始日志（深层结构不受保护，见文档）。
 */
function freezeTop(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze([...value]);
  if (isPlainEvent(value)) return Object.freeze({ ...value });
  return value;
}

/** 校验一种事件的 schema，返回问题列表（空 = 没问题）。 */
export function validateEventSchema(schema: EventSchema): string[] {
  const issues: string[] = [];
  const type = schema?.type;
  if (typeof type !== 'string' || type.length === 0) {
    issues.push('事件类型 type 必须是非空字符串');
    return issues;
  }
  if (!Number.isInteger(schema.version) || schema.version < 1) {
    issues.push(`"${type}" 的 version 必须是 >= 1 的整数（当前 ${String(schema.version)}）`);
    return issues;
  }

  const seenFrom = new Set<number>();
  const steps = [...(schema.upcasts ?? [])].sort((a, b) => a.from - b.from);
  for (const step of steps) {
    if (!Number.isInteger(step.from) || step.from < 1) {
      issues.push(`"${type}" 的升级步骤 from 必须是 >= 1 的整数（当前 ${String(step.from)}）`);
      continue;
    }
    if (!Number.isInteger(step.to) || step.to <= step.from) {
      issues.push(`"${type}" 的升级步骤 ${step.from} → ${String(step.to)} 不合法：to 必须大于 from`);
      continue;
    }
    if (step.to > schema.version) {
      issues.push(
        `"${type}" 的升级步骤 ${step.from} → ${step.to} 超过了 schema.version=${schema.version}（升级链不应指向未来版本）`,
      );
      continue;
    }
    if (typeof step.up !== 'function') {
      issues.push(`"${type}" 的升级步骤 ${step.from} → ${step.to} 缺少 up 函数`);
      continue;
    }
    if (seenFrom.has(step.from)) {
      issues.push(`"${type}" 有两条 from=${step.from} 的升级步骤（无法决定用哪条）`);
      continue;
    }
    seenFrom.add(step.from);
  }
  if (issues.length > 0) return issues;

  // 链必须能从 1 走到 version（允许跳跃，但不允许缺口）
  let cursor = 1;
  let guard = 0;
  while (cursor < schema.version) {
    const step = steps.find((s) => s.from === cursor);
    if (!step) {
      issues.push(
        `"${type}" 的升级链有缺口：v${cursor} 没有升级步骤，无法从 v1 升到 v${schema.version}`,
      );
      break;
    }
    cursor = step.to;
    if ((guard += 1) > steps.length + 1) {
      issues.push(`"${type}" 的升级链成环（从 v1 走不到 v${schema.version}）`);
      break;
    }
  }
  return issues;
}

/** 校验并冻结一种事件的 schema（模块加载期就能发现写错）。 */
export function defineEventSchema(schema: EventSchema): EventSchema {
  const issues = validateEventSchema(schema);
  if (issues.length > 0) throw new EventSchemaError(issues);
  return Object.freeze({ ...schema, upcasts: Object.freeze([...(schema.upcasts ?? [])]) });
}

export interface EventRegistry {
  /** 单条：信封 / 旧格式 → **当前形状**的事件体（不含信封）。 */
  upcast(raw: unknown): unknown;
  /** 批量（重放用）：语义与逐条调用完全一致。 */
  upcastAll(raw: readonly unknown[]): unknown[];
  /** 某个类型的当前版本；未注册则 `null`。 */
  currentVersion(type: string): number | null;
  /** 已注册的事件类型。 */
  types(): string[];
}

export interface EventRegistryOptions {
  /** 旧格式读取器（默认见 `defaultLegacyReader`）。 */
  legacy?: LegacyReader;
}

/** 是否是一条带信封的事件记录。 */
export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<EventEnvelope>;
  return (
    typeof candidate.type === 'string' &&
    Number.isInteger(candidate.version) &&
    (candidate.version as number) >= 1 &&
    'payload' in candidate
  );
}

/** 构造事件信封（`eventId`/`at` 可注入，便于测试与确定性重放）。 */
export function createEventEnvelope<P>(input: {
  type: string;
  version: number;
  payload: P;
  eventId?: string;
  at?: number;
}): EventEnvelope<P> {
  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw new EventSchemaError(['createEventEnvelope: type 必须是非空字符串']);
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new EventSchemaError([`createEventEnvelope: version 必须是 >= 1 的整数（当前 ${String(input.version)}）`]);
  }
  return {
    eventId: input.eventId ?? randomEventId(),
    type: input.type,
    version: input.version,
    at: input.at ?? Date.now(),
    payload: input.payload,
  };
}

function randomEventId(): string {
  // 内核零依赖的取向同样适用于数据层：用 node 内置随机源，不引 npm 包。
  return `evt-${globalThis.crypto.randomUUID()}`;
}

/**
 * 建注册表：**构造期**把 schema 写错、类型重复、升级链缺口全部报出来，
 * 而不是等到线上读到某条老数据才发现。
 */
export function createEventRegistry(
  schemas: readonly EventSchema[],
  options: EventRegistryOptions = {},
): EventRegistry {
  const issues: string[] = [];
  const byType = new Map<string, EventSchema>();
  for (const schema of schemas) {
    const schemaIssues = validateEventSchema(schema);
    if (schemaIssues.length > 0) {
      issues.push(...schemaIssues);
      continue;
    }
    if (byType.has(schema.type)) {
      issues.push(`事件类型 "${schema.type}" 被重复注册（一种类型只能有一条升级链）`);
      continue;
    }
    byType.set(schema.type, schema);
  }
  if (issues.length > 0) throw new EventSchemaError(issues);

  const legacy = options.legacy ?? defaultLegacyReader;

  /** 信封 / 旧格式 → `{type, version, payload}`；认不出来则 `null`（原样透传）。 */
  const interpret = (raw: unknown): LegacyEvent | null => {
    if (isEventEnvelope(raw)) {
      return { type: raw.type, version: raw.version, payload: raw.payload };
    }
    return legacy(raw) ?? null;
  };

  const upcast = (raw: unknown): unknown => {
    const interpreted = interpret(raw);
    if (interpreted === null) return raw; // 旧格式认不出 ⇒ 与 M3 之前完全一致
    const schema = byType.get(interpreted.type);
    if (!schema) return interpreted.payload; // 未知类型 ⇒ 放行（滚动升级不能因"不认识"就崩）

    let version = interpreted.version;
    let event = interpreted.payload;
    let guard = 0;
    while (version < schema.version) {
      const step = (schema.upcasts ?? []).find((candidate) => candidate.from === version);
      if (!step) {
        // 单条数据读不到对应步骤时的兜底（注册表构造期已挡住大部分情况）
        throw new EventSchemaError([
          `"${interpreted.type}" 读到 v${version} 数据，但没有对应的升级步骤（当前 v${schema.version}）`,
        ]);
      }
      event = step.up(freezeTop(event) as Record<string, unknown>);
      version = step.to;
      if ((guard += 1) > (schema.upcasts?.length ?? 0) + 1) {
        throw new EventSchemaError([`"${interpreted.type}" 的升级链成环（v${interpreted.version} → v${schema.version}）`]);
      }
    }
    return event;
  };

  return {
    upcast,
    upcastAll: (raw) => raw.map(upcast),
    currentVersion: (type) => byType.get(type)?.version ?? null,
    types: () => [...byType.keys()].sort(),
  };
}
