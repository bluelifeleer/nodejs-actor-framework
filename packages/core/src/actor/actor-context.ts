// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const { ActorStoppedError } = require('./errors.ts');

/** 一个可发送/停止/询问的目标（ActorRef、RemoteRef 都满足）。 */
interface TellableTarget<M = unknown, R = unknown> {
  tell(msg: M, sender?: unknown, trace?: unknown): boolean;
  ask(msg: M, timeoutMs?: number, sender?: unknown, trace?: unknown): Promise<R>;
  stop(): Promise<void>;
}

/** `ctx` 背后的 cell（ActorCell 满足这个结构；只声明 ctx 真正用到的部分）。 */
interface ContextCell {
  readonly ref: unknown;
  readonly id: string;
  readonly path: string;
  readonly system: ContextSystem;
  readonly children: Map<string, unknown>;
  readonly currentSender: unknown;
  readonly currentTrace: unknown;
  readonly handling: boolean;
  readonly options: { askTimeoutMs?: number };
  spawnChild(definition: unknown, options?: unknown): Promise<unknown>;
  stop(): Promise<void>;
  persistEvent(event: unknown): Promise<unknown> | unknown;
  persistEvents(events: unknown[]): Promise<unknown> | unknown;
  saveSnapshot(): Promise<unknown> | unknown;
}

/** `ctx.system` 的最小视图（只列 ctx 用到的）。 */
interface ContextSystem {
  readonly clock: { now(): number; setTimeout(cb: () => void, ms: number): unknown };
  readonly tracer: { child(parent: unknown): unknown } | null;
  readonly peers: Map<string, unknown>;
  resolve(target: string): TellableTarget | null | undefined;
  remote(target: string): TellableTarget;
  _log(event: string, meta?: Record<string, unknown>): void;
}

/**
 * The `ctx` object passed to every actor hook and to `receive`.
 *
 * It is the actor's view of the world: who it is, who sent the current
 * message, how to create children, and how to persist. It deliberately does
 * not expose the cell's internals.
 */
class ActorContext {
  readonly cell: ContextCell;
  /** 是否由快照恢复（persistence: 'snapshot'）。 */
  restored: boolean;

  constructor(cell: ContextCell) {
    this.cell = cell;
    this.restored = false;
  }

  get self(): unknown {
    return this.cell.ref;
  }

  /** The sender of the message currently being handled, or null if outside. */
  get sender(): unknown {
    return this.cell.currentSender;
  }

  get system(): ContextSystem {
    return this.cell.system;
  }

  get id(): string {
    return this.cell.id;
  }

  get path(): string {
    return this.cell.path;
  }

  /** Child actor ids, in spawn order. */
  get children(): string[] {
    return [...this.cell.children.keys()];
  }

  /** True when the actor is inside `receive` (used to guard misuse). */
  get handling(): boolean {
    return this.cell.handling;
  }

  /** Trace context of the message being handled (tracing plugin installed). */
  get trace(): unknown {
    return this.cell.currentTrace || null;
  }

  /** Create a child span of the current one (for spans the actor starts). */
  span(): unknown {
    if (!this.cell.system.tracer) return null;
    return this.cell.system.tracer.child(this.cell.currentTrace);
  }

  /** Create a child actor supervised by this one. */
  spawn(definition: unknown, options?: unknown): Promise<unknown> {
    return this.cell.spawnChild(definition, options);
  }

  /** Send to another actor (accepts an ActorRef, or an id/path string). */
  tell(target: unknown, msg: unknown): boolean {
    return resolveTarget(this.cell, target).tell(msg, this.cell.ref, this.cell.currentTrace);
  }

  ask(target: unknown, msg: unknown, timeoutMs?: number): Promise<unknown> {
    return resolveTarget(this.cell, target).ask(
      msg,
      timeoutMs ?? this.cell.options.askTimeoutMs,
      this.cell.ref,
      this.cell.currentTrace,
    );
  }

  /** Stop a child (or any known actor) gracefully. */
  stop(target?: unknown): Promise<void> {
    if (target === undefined) return this.cell.stop();
    return resolveTarget(this.cell, target).stop();
  }

  stopSelf(): Promise<void> {
    return this.cell.stop();
  }

  /** Append a domain event (persistence: 'events'). */
  persist(event: unknown): Promise<unknown> | unknown {
    return this.cell.persistEvent(event);
  }

  /**
   * 一次写入多条事件：**版本检查覆盖整批**（一条命令产出多个事件时用它，别循环 `persist`）。
   */
  persistAll(events: unknown[]): Promise<unknown> | unknown {
    return this.cell.persistEvents(events);
  }

  /**
   * 系统的时钟：`ctx.clock.now()` 读"现在"（**别用 `Date.now()`**，否则注入虚拟时钟后
   * 你的时间判断会和框架的定时器走在两条时间线上）。
   */
  get clock(): ContextSystem['clock'] {
    return this.cell.system.clock;
  }

  /**
   * 在当前 Actor 里等待一段时间（走系统的可注入时钟）。
   *
   * 语义：await 期间这个 Actor **不处理新消息**（邮箱继续排队），所以别用它做"让出执行权"。
   * 测试里注入虚拟时钟后，`clock.advance(ms)` 能让它瞬间返回（这是它存在的理由）。
   */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.cell.system.clock.setTimeout(resolve, Math.max(0, ms)));
  }

  /** Store the current state (persistence: 'snapshot'). */
  saveSnapshot(): Promise<unknown> | unknown {
    return this.cell.saveSnapshot();
  }

  /** Structured log line, tagged with this actor's path. */
  log(message: string, meta?: Record<string, unknown>): void {
    this.cell.system._log('actor', { path: this.cell.path, message, ...(meta || {}) });
  }
}

function resolveTarget(cell: ContextCell, target: unknown): TellableTarget {
  if (target === null || target === undefined) throw new ActorStoppedError('target actor is required');
  const candidate = target as Partial<TellableTarget>;
  if (typeof candidate.tell === 'function' && typeof candidate.ask === 'function') return candidate as TellableTarget;

  const local = cell.system.resolve(String(target));
  if (local) return local;

  // Location transparency: "path@host:port" (or a bare path once a peer is
  // connected) routes to the peer node. With no peers this is skipped, so the
  // local-only behaviour is unchanged.
  if (typeof target === 'string' && (target.includes('@') || cell.system.peers.size > 0)) {
    try {
      return cell.system.remote(target);
    } catch {
      /* fall through to the clearer error below */
    }
  }
  throw new ActorStoppedError(`no actor registered as "${String(target)}"`);
}

module.exports = ActorContext;
module.exports.resolveTarget = resolveTarget;
