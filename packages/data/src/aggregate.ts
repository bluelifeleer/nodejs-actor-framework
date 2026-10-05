/**
 * 事件溯源聚合（M3 第 2 步）。
 *
 * 一句话：**状态只能由事件推导**。命令（`commands`）只做"校验 + 产出事件"，
 * 真正的状态变化全部经过纯函数 `applyEvent(state, event)`——于是同一个函数既能用于
 * 实时处理，也能用于重启后的重放（doc 04 §3）。
 *
 * 形态选择：返回**内核认识的 handler bag**（`receive`/`applyEvent`/`state`），而不是 class。
 * 两个原因：
 *   1. 内核的 handler bag 路径把 `this` 绑到 cell 的实例上，`this.state` 就是 cell 的状态；
 *      class 路径目前不行（见 docs/design/m3-data-evolution.md §5 的已知缺陷）；
 *   2. 元数据得以放在**不可枚举**属性上（`evolution`/`registry`/…），
 *      内核的 `unknown-keys` 拼写检查因此不会被误触发。
 */

import {
  createEventEnvelope,
  createEventRegistry,
  isEventEnvelope,
  type EventRegistry,
  type EventSchema,
  type LegacyReader,
} from './events.ts';
import { defineEvolution, type PersistenceEvolution } from './evolution.ts';

/** 事件体：必须自带 `type` 判别字段（信封的 type 只用于查表，不注入事件体）。 */
export interface AggregateEvent {
  type: string;
  [field: string]: unknown;
}

export type AggregateCommandResult =
  | AggregateEvent
  | readonly AggregateEvent[]
  | void
  | null
  | undefined;

/** 命令处理器：**读状态 + 产出事件**，不得直接改状态（`state` 是顶层冻结的副本）。 */
export type AggregateCommand<S> = (command: unknown, state: S) => AggregateCommandResult;

/** 内核交给 Actor 的最小上下文（结构类型，不 import 内核）。 */
export interface AggregateContext {
  persist(event: unknown): Promise<unknown>;
  log?(message: string, meta?: unknown): void;
}

export interface AggregateSpec<S = unknown> {
  /** 聚合名（诊断与错误信息用；默认 `Aggregate`）。 */
  name?: string;
  /** 初始状态工厂：**每个 Actor 实例调用一次**（返回新对象，绝不要共享）。 */
  initialState: () => S;
  /** 纯函数：`(state, event) => newState`。实时处理与重放走同一份代码。 */
  applyEvent: (state: S, event: AggregateEvent) => S;
  /** 命令表：消息 → 命令名（默认取 `msg.command`，其次 `msg.type`）。 */
  commands: Record<string, AggregateCommand<S>>;
  /** 本聚合产出的事件 schema（交给 M3 第 1 步的注册表做结构升级）。 */
  events?: readonly EventSchema[];
  /** 旧格式（无信封）事件怎么解读，见 `createEventRegistry`。 */
  legacy?: LegacyReader;
  /** 自定义"从消息取命令名"的方式。 */
  commandOf?: (msg: unknown) => string | null | undefined;
  /** 可选生命周期钩子（原样转交内核）。 */
  preStart?: (ctx: unknown) => unknown;
  postRecover?: (ctx: unknown) => unknown;
  postStop?: (ctx: unknown) => unknown;
  preRestart?: (reason: unknown, msg: unknown, ctx: unknown) => unknown;
}

export interface AggregateDefinition<S = unknown> {
  /** 内核 handler：每个实例一份全新的初始状态。 */
  state(): S;
  receive(this: { state: S }, msg: unknown, ctx: AggregateContext): Promise<S>;
  applyEvent(this: { state: S }, event: AggregateEvent): void;
  preStart?(ctx: unknown): unknown;
  postRecover?(ctx: unknown): unknown;
  postStop?(ctx: unknown): unknown;
  preRestart?(reason: unknown, msg: unknown, ctx: unknown): unknown;

  // --- 元数据（不可枚举：不进内核的 unknown-keys 扫描） ---
  readonly name: string;
  readonly events: readonly EventSchema[];
  readonly registry: EventRegistry;
  /** 交给 `persistence: { mode: 'events', evolution: aggregate.evolution }`；没声明 events 时为 null。 */
  readonly evolution: PersistenceEvolution | null;
}

/** 聚合定义写错（构造期就报，不留到运行期）。 */
export class AggregateDefinitionError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`聚合定义有问题（${issues.length} 项）：\n` + issues.map((i) => `  - ${i}`).join('\n'));
    this.name = 'AggregateDefinitionError';
    this.issues = issues;
  }
}

/**
 * 聚合收到的事件版本落后于当前代码，但升级链**没有接上**（没把 `evolution` 传给持久化）。
 *
 * 之所以要报错而不是"凑合用"：那会用旧结构套新代码，属于静默数据错误。
 * 当前版本的事件不受影响（聚合会自己拆信封），所以只声明 schema、不接 evolution 的
 * 简单场景仍然可用。
 */
export class AggregateEvolutionError extends Error {
  readonly aggregate: string;
  readonly eventType: string;
  readonly found: number;
  readonly expected: number;
  constructor(aggregate: string, eventType: string, found: number, expected: number) {
    super(
      `聚合 '${aggregate}' 读到 ${eventType} v${found}，但当前代码是 v${expected}：升级链没有执行。` +
        '请把 evolution 接到持久化上（persistence: { mode: "events", evolution: aggregate.evolution }）',
    );
    this.name = 'AggregateEvolutionError';
    this.aggregate = aggregate;
    this.eventType = eventType;
    this.found = found;
    this.expected = expected;
  }
}

/** 收到本聚合没有声明的命令。 */
export class UnknownCommandError extends Error {  readonly aggregate: string;
  readonly command: string | null;
  readonly known: readonly string[];
  constructor(aggregate: string, command: string | null, known: readonly string[]) {
    super(
      `聚合 '${aggregate}' 没有命令 ${command === null ? '(无法从消息里取出命令名)' : `'${command}'`}` +
        `（已声明：${known.length > 0 ? known.join(', ') : '无'}）`,
    );
    this.name = 'UnknownCommandError';
    this.aggregate = aggregate;
    this.command = command;
    this.known = known;
  }
}

/** 默认取命令名：`msg.command` 优先，其次 `msg.type`。 */
export function defaultCommandOf(msg: unknown): string | null {
  if (msg === null || typeof msg !== 'object') return null;
  const candidate = msg as { command?: unknown; type?: unknown };
  if (typeof candidate.command === 'string' && candidate.command.length > 0) return candidate.command;
  if (typeof candidate.type === 'string' && candidate.type.length > 0) return candidate.type;
  return null;
}

/** 顶层冻结的浅拷贝：拦住"命令直接改状态"（严格模式下赋值会 TypeError）。 */
function freezeTop(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze([...value]);
  if (value !== null && typeof value === 'object') return Object.freeze({ ...value });
  return value;
}

/** 浅拷贝：不要把活状态交给调用方（嵌套结构仍然共享，见文档）。 */
function shallowCopy<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as unknown as T;
  if (value !== null && typeof value === 'object') return { ...(value as object) } as T;
  return value;
}

/**
 * `applyEvent` 收到的东西可能是三种之一：
 *   1. 当前版本的信封（用户忘了把 evolution 接上）→ 拆出 payload，**安全**；
 *   2. 旧版本的信封（同理，但升级链没跑）→ **报错**（否则会用旧结构套新代码）；
 *   3. 已经升级好的事件体（正常路径：内核的 evolution.upcast 产出）→ 原样使用。
 */
function resolveIncoming(event: unknown, registry: EventRegistry, aggregate: string): AggregateEvent {
  if (!isEventEnvelope(event)) return event as AggregateEvent;
  const current = registry.currentVersion(event.type);
  if (current !== null && event.version < current) {
    throw new AggregateEvolutionError(aggregate, event.type, event.version, current);
  }
  return event.payload as AggregateEvent;
}

function toEventList(produced: AggregateCommandResult, aggregate: string, command: string): AggregateEvent[] {
  if (produced === undefined || produced === null) return [];
  const list = Array.isArray(produced) ? produced : [produced];
  return list.map((event, index) => {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new AggregateDefinitionError([
        `聚合 '${aggregate}' 的命令 '${command}' 产出的第 ${index + 1} 个事件不是对象（实际 ${JSON.stringify(event)}）`,
      ]);
    }
    const type = (event as { type?: unknown }).type;
    if (typeof type !== 'string' || type.length === 0) {
      throw new AggregateDefinitionError([
        `聚合 '${aggregate}' 的命令 '${command}' 产出的第 ${index + 1} 个事件缺少字符串 type 字段` +
          '（信封的 type 只用于查表，事件体也要自带判别字段）',
      ]);
    }
    return event as AggregateEvent;
  });
}

/**
 * 声明一个事件溯源聚合。用法（内核与应用层两条路径都适用）：
 *
 * ```ts
 * const Order = defineAggregate({
 *   name: 'Order',
 *   initialState: () => ({ status: 'created', totalCents: 0 }),
 *   events: [defineEventSchema({ type: 'ItemAdded', version: 2, upcasts: [...] })],
 *   applyEvent: (state, event) => (event.type === 'ItemAdded' ? { ...state, totalCents: state.totalCents + event.price } : state),
 *   commands: {
 *     addItem: (cmd, state) => {
 *       if (state.status !== 'created') throw new Error('order already confirmed');
 *       return { type: 'ItemAdded', price: cmd.price };      // 只产出事件，不改状态
 *     },
 *   },
 * });
 *
 * await system.spawn(Order, { id: 'order-1', persistence: { mode: 'events', evolution: Order.evolution } });
 * ```
 *
 * `receive` 的返回值是**命令执行后的状态浅拷贝**（事件已经应用完），所以
 * `await actor.ask({ type: 'addItem', price: 100 })` 直接拿到新状态。
 */
export function defineAggregate<S>(spec: AggregateSpec<S>): AggregateDefinition<S> {
  const issues: string[] = [];
  if (typeof spec?.initialState !== 'function') issues.push('initialState 必须是函数（返回新状态）');
  if (typeof spec?.applyEvent !== 'function') issues.push('applyEvent 必须是纯函数 (state, event) => newState');
  if (spec?.commands === null || typeof spec?.commands !== 'object') {
    issues.push('commands 必须是一个「命令名 → 处理器」的对象');
  } else {
    const names = Object.keys(spec.commands);
    if (names.length === 0) issues.push('commands 不能为空（至少声明一个命令）');
    for (const name of names) {
      if (typeof spec.commands[name] !== 'function') issues.push(`命令 '${name}' 的处理器必须是函数`);
    }
  }
  if (spec?.commandOf !== undefined && typeof spec.commandOf !== 'function') {
    issues.push('commandOf 必须是函数');
  }
  if (issues.length > 0) throw new AggregateDefinitionError(issues);

  const name = spec.name ?? 'Aggregate';
  const registry = createEventRegistry(spec.events ?? [], spec.legacy === undefined ? {} : { legacy: spec.legacy });
  const evolution = (spec.events?.length ?? 0) > 0 ? defineEvolution({ events: registry }) : null;

  const definition = {
    state: () => spec.initialState(),

    async receive(this: { state: S }, msg: unknown, ctx: AggregateContext): Promise<S> {
      const commandOf = spec.commandOf ?? defaultCommandOf;
      const command = commandOf(msg) ?? null;
      const handler = command === null ? undefined : spec.commands[command];
      if (typeof handler !== 'function') throw new UnknownCommandError(name, command, Object.keys(spec.commands));

      // 命令只能"读状态 + 产出事件"：给一份顶层冻结的副本
      const produced = handler(msg, freezeTop(this.state) as S);
      for (const event of toEventList(produced, name, command as string)) {
        const version = registry.currentVersion(event.type) ?? 1;
        await ctx.persist(createEventEnvelope({ type: event.type, version, payload: event }));
      }
      return shallowCopy(this.state);
    },

    applyEvent(this: { state: S }, event: AggregateEvent): void {
      this.state = spec.applyEvent(this.state, resolveIncoming(event, registry, name));
    },
  } as unknown as AggregateDefinition<S>;

  if (spec.preStart) definition.preStart = (ctx: unknown) => spec.preStart?.(ctx);
  if (spec.postRecover) definition.postRecover = (ctx: unknown) => spec.postRecover?.(ctx);
  if (spec.postStop) definition.postStop = (ctx: unknown) => spec.postStop?.(ctx);
  if (spec.preRestart) {
    definition.preRestart = (reason: unknown, msg: unknown, ctx: unknown) => spec.preRestart?.(reason, msg, ctx);
  }

  // 元数据放不可枚举属性：`Object.keys(definition)` 只会有内核认识的 handler 名，
  // 于是内核的 unknown-keys 拼写检查不会被误触发（见文件头注释）。
  Object.defineProperties(definition, {
    name: { value: name, enumerable: false },
    events: { value: Object.freeze([...(spec.events ?? [])]), enumerable: false },
    registry: { value: registry, enumerable: false },
    evolution: { value: evolution, enumerable: false },
  });
  return definition;
}
