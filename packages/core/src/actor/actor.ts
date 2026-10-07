// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const { DefinitionError } = require('./errors.ts');

/**
 * Base class for user actors.
 *
 * Lifecycle (see ActorCell for the exact ordering):
 *
 *   new -> preStart(ctx) -> [recover state] -> postRecover(ctx)
 *            -> receive(msg, ctx)* -> postStop(ctx)
 *                   ^                      |
 *                   +---- restart on failure+
 *
 * `preStart` runs *before* recovery, so it is the place to establish initial
 * state (`this.state = { balance: 0 }`); a snapshot or replayed events are
 * applied on top of it, in `postRecover`.
 *
 * `receive` runs one message at a time per actor, so `this.state` never needs
 * a lock. Throwing from `receive` is the idiomatic way to signal failure: the
 * actor crashes and its supervisor decides what happens next.
 */
/** Actor 里的状态：用户自己定义形状，框架不解释它。 */
type ActorState = Record<string, unknown>;

/** Actor 收到的消息（约定有 `type`，但框架不强制）。 */
type ActorMessage = unknown;

/** 传给生命周期钩子与 receive 的上下文（ActorContext 的结构视图）。 */
interface ActorContextLike {
  readonly id: string;
  readonly path: string;
  readonly restored: boolean;
  readonly clock: { now(): number };
  readonly sender: unknown;
  readonly self: unknown;
  log(message: string, meta?: Record<string, unknown>): void;
  [key: string]: unknown;
}

/** 用普通函数/对象描述 Actor 时支持的钩子集合。 */
interface ActorHandlers {
  state?: ActorState | (() => ActorState);
  preStart?(ctx: ActorContextLike): void | Promise<void>;
  postRecover?(ctx: ActorContextLike): void | Promise<void>;
  receive(this: unknown, msg: ActorMessage, ctx: ActorContextLike): unknown;
  postStop?(ctx: ActorContextLike): void | Promise<void>;
  preRestart?(this: unknown, reason: unknown, msg: ActorMessage, ctx: ActorContextLike): void | Promise<void>;
  applyEvent?(this: unknown, event: unknown): unknown;
}

class Actor {
  /** Actor 私有状态；永不跨 Actor 共享。 */
  state: ActorState;
  /** Actor id（挂载后由 cell 写入）。 */
  id: string | null;
  /** 完整路径，例如 "player_001/pet-1"。 */
  path: string | null;

  constructor() {
    this.state = {};
    this.id = null;
    this.path = null;
  }

  /** Called once before the first message (and again after every restart). */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  preStart(ctx: ActorContextLike): void | Promise<void> {}

  /**
   * Called after a snapshot or replayed events were applied. `ctx.restored`
   * tells whether anything was recovered, so this is the place to log or
   * validate a recovery.
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  postRecover(ctx: ActorContextLike): void | Promise<void> {}

  /** Handle one message. Return a value to answer an `ask()`. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async receive(msg: ActorMessage, ctx: ActorContextLike): Promise<unknown> {
    throw new DefinitionError('actor does not implement receive(msg, ctx)');
  }

  /** Called on graceful stop, and before a restart. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  postStop(ctx: ActorContextLike): void | Promise<void> {}

  /**
   * Called when this actor failed and is about to restart. Runs before
   * postStop(). The message that caused the failure is passed in.
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  preRestart(reason: unknown, msg: ActorMessage, ctx: ActorContextLike): void | Promise<void> {}

  /** Apply a persisted event to `this.state` (events persistence). */
  applyEvent(event: unknown): void {
    if (event && typeof event === 'object') {
      /**
       * 审计 S14：事件来自磁盘事件日志的 `JSON.parse`，而 `JSON.parse` 会把 `"__proto__"`
       * 变成**自有属性**；`Object.assign` 走 `[[Set]]` → 触发 `Object.prototype.__proto__` setter →
       * 改写该 state 实例的原型（`state.polluted` 会"凭空出现"，且不是自有属性）。
       * 只影响这一个 state，不是全局污染，但没有理由让磁盘内容决定原型。
       */
      for (const [key, value] of Object.entries(event)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        (this.state as Record<string, unknown>)[key] = value;
      }
    }
  }
}

/** Adapts plain handler functions to the Actor interface. */
class HandlerActor extends Actor {
  readonly handlers: ActorHandlers;

  constructor(handlers: ActorHandlers) {
    super();
    this.handlers = handlers;
    if (handlers.state !== undefined) {
      const initial = handlers.state;
      this.state = typeof initial === 'function' ? initial() : { ...initial };
    }
  }

  override preStart(ctx: ActorContextLike): void | Promise<void> {
    if (this.handlers.preStart) return this.handlers.preStart.call(this, ctx);
    return undefined;
  }

  override postRecover(ctx: ActorContextLike): void | Promise<void> {
    if (this.handlers.postRecover) return this.handlers.postRecover.call(this, ctx);
    return undefined;
  }

  override receive(msg: ActorMessage, ctx: ActorContextLike): Promise<unknown> {
    return Promise.resolve(this.handlers.receive.call(this, msg, ctx));
  }

  override postStop(ctx: ActorContextLike): void | Promise<void> {
    if (this.handlers.postStop) return this.handlers.postStop.call(this, ctx);
    return undefined;
  }

  override preRestart(reason: unknown, msg: ActorMessage, ctx: ActorContextLike): void | Promise<void> {
    if (this.handlers.preRestart) return this.handlers.preRestart.call(this, reason, msg, ctx);
    return undefined;
  }

  override applyEvent(event: unknown): void {
    if (this.handlers.applyEvent) {
      this.handlers.applyEvent.call(this, event);
      return;
    }
    super.applyEvent(event);
  }
}

const HANDLER_ALIASES = {
  preStart: ['preStart', 'onStart', 'start'],
  postRecover: ['postRecover', 'onRecover', 'afterRecover'],
  receive: ['receive', 'onMessage', 'onReceive', 'handle'],
  postStop: ['postStop', 'onStop', 'stop'],
  preRestart: ['preRestart', 'onRestart', 'onFailure'],
  applyEvent: ['applyEvent', 'onEvent', 'reduce'],
};

function pickHandlers(source: Record<string, unknown>): { handlers: ActorHandlers; unknown: string[] } {
  const handlers: Record<string, unknown> = {};
  const unknown: string[] = [];
  const known = new Set<string>(Object.values(HANDLER_ALIASES).flat().concat(['state']));
  for (const [canonical, aliases] of Object.entries(HANDLER_ALIASES)) {
    for (const alias of aliases) {
      const candidate = source[alias];
      if (typeof candidate === 'function') {
        handlers[canonical] = candidate;
        break;
      }
    }
  }
  if (source.state !== undefined) handlers.state = source.state;
  for (const key of Object.keys(source)) {
    if (!known.has(key)) unknown.push(key);
  }
  if (handlers.receive === undefined) {
    throw new DefinitionError(
      `actor definition needs a message handler (receive/onMessage); ` +
        `found keys: ${Object.keys(source).join(', ') || '(none)'}`,
    );
  }
  return { handlers: handlers as unknown as ActorHandlers, unknown };
}

/**
 * Normalise every supported way of describing an actor into one Definition.
 *
 * Supported inputs:
 *   defineActor(class Player extends Actor { ... })
 *   defineActor(async (msg, ctx) => { ... })
 *   defineActor({ state, preStart, receive, postStop })
 *   defineActor({ onStart, onMessage, onStop })      // alias form
 *   defineActor(instanceOfActorSubclass)
 *
 * @param {Function|object} input
 * @param {object} [defaults] per-type defaults (supervision, mailbox, persistence, ...)
 */
function defineActor(input: unknown, defaults: Record<string, unknown> = {}): ActorDefinition {
  if (input === null || input === undefined) {
    throw new DefinitionError('defineActor(input): input is required');
  }

  // Already normalised.
  if (input instanceof ActorDefinition) {
    return input.options === defaults ? input : input.withDefaults(defaults);
  }

  // A live actor instance.
  if (input instanceof Actor) {
    const name = input.constructor.name || 'Actor';
    return new ActorDefinition({ name, kind: 'instance', create: () => input, options: defaults });
  }

  // A class (optionally extending Actor).
  const ctor = input as { name?: string; prototype?: { receive?: unknown } };
  if (typeof input === 'function' && ctor.prototype !== undefined && typeof ctor.prototype.receive === 'function') {
    const ActorClass = input as new () => Actor;
    const name = ctor.name ?? 'AnonymousActor';
    if (ctor.prototype.receive === Actor.prototype.receive) {
      // Subclassing Actor but not overriding receive() is a definition bug:
      // catch it here instead of failing on the first message.
      throw new DefinitionError(`actor class "${name}" does not implement receive(msg, ctx)`);
    }
    return new ActorDefinition({ name, kind: 'class', create: () => new ActorClass(), options: defaults });
  }

  // A bare message handler.
  if (typeof input === 'function') {
    const name = input.name && input.name !== 'anonymous' ? input.name : 'HandlerActor';
    return new ActorDefinition({
      name,
      kind: 'handler',
      create: () => new HandlerActor({ receive: input as ActorHandlers['receive'] }),
      options: defaults,
    });
  }

  // A handler/state bag.
  if (typeof input === 'object') {
    const { handlers, unknown } = pickHandlers(input as Record<string, unknown>);
    const receiveName = handlers.receive.name;
    const name = receiveName !== '' && receiveName !== 'anonymous' ? receiveName : 'HandlerActor';
    return new ActorDefinition({
      name,
      kind: 'handler',
      create: () => new HandlerActor(handlers),
      options: defaults,
      unknownKeys: unknown,
    });
  }

  throw new DefinitionError(`defineActor(input): unsupported definition of type ${typeof input}`);
}

/** 一条归一化后的 Actor 定义。 */
interface ActorDefinitionInit {
  name: string;
  kind: string;
  create: () => Actor;
  options?: Record<string, unknown>;
  unknownKeys?: string[];
  modulePath?: string | null;
  exportName?: string;
}

class ActorDefinition {
  readonly name: string;
  readonly kind: string;
  create: () => Actor;
  readonly options: Record<string, unknown>;
  readonly unknownKeys: string[];
  /** `kind: 'worker'` 时存在：Actor 代码所在的模块。 */
  readonly modulePath: string | null;
  readonly exportName: string;

  constructor({ name, kind, create, options = {}, unknownKeys = [], modulePath = null, exportName = 'default' }: ActorDefinitionInit) {
    this.name = name;
    this.kind = kind;
    this.create = create;
    this.options = options;
    this.unknownKeys = unknownKeys;
    this.modulePath = modulePath;
    this.exportName = exportName;
  }

  withDefaults(defaults: Record<string, unknown>): ActorDefinition {
    return new ActorDefinition({
      name: this.name,
      kind: this.kind,
      create: this.create,
      options: { ...defaults, ...this.options },
      unknownKeys: this.unknownKeys,
      modulePath: this.modulePath,
      exportName: this.exportName,
    });
  }
}

module.exports = { Actor, ActorDefinition, defineActor, HandlerActor };
