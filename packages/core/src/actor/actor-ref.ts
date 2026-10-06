// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const { ActorStoppedError } = require('./errors.ts');

/** Actor 引用背后的目标（本地 cell、worker 代理或远端连接都满足这个结构）。 */
interface RefTarget<M = unknown, R = unknown> {
  readonly id: string;
  readonly path: string;
  tell(msg: M, sender?: ActorRef | null, trace?: unknown): boolean;
  ask(msg: M, timeoutMs?: number, sender?: ActorRef | null, trace?: unknown): Promise<R>;
  stop(): Promise<void>;
  inspect(): Record<string, unknown>;
  state?(): unknown;
}

/** 追踪上下文（结构型：内核是 CJS，不 import type）。 */
interface RefTrace {
  traceId?: string;
}

/**
 * A handle to an actor.
 *
 * This is the only thing user code should hold on to: it is location
 * transparent, so the same `tell`/`ask`/`stop` calls work for an actor in this
 * process (today) or on another node (once the cluster transport is wired to
 * the same interface).
 */
class ActorRef<M = unknown, R = unknown> {
  /** 目标（隐藏字段，不进 JSON/枚举）。 */
  declare _target: RefTarget<M, R>;

  /** @param target 本地 cell / worker 代理 / 远端连接（同一个结构）。 */
  constructor(target: RefTarget<M, R>) {
    Object.defineProperty(this, '_target', { value: target, enumerable: false });
  }

  get id(): string {
    return this._target.id;
  }

  get path(): string {
    return this._target.path;
  }

  get isLocal(): boolean {
    return true;
  }

  /**
   * Fire and forget. Returns false when the mailbox refused the message.
   * The optional `sender`/`trace` are used internally by ActorContext so the
   * callee sees who sent the message and the trace chain stays intact.
   */
  tell(msg: M, sender?: ActorRef | null, trace?: RefTrace | null): boolean {
    return this._target.tell(msg, sender, trace);
  }

  /** Send and wait for the reply returned by `receive`. */
  ask(msg: M, timeoutMs?: number, sender?: ActorRef | null, trace?: RefTrace | null): Promise<R> {
    return this._target.ask(msg, timeoutMs, sender, trace);
  }

  /** Graceful stop (runs postStop); the ref becomes unusable afterwards. */
  stop(): Promise<void> {
    return this._target.stop();
  }

  /** Introspection snapshot (mailbox depth, state, children, counters). */
  inspect(): Record<string, unknown> {
    return this._target.inspect();
  }

  /**
   * The actor's current state: a clone for local actors, fetched over the
   * worker protocol for isolated ones.
   */
  state(): unknown {
    return typeof this._target.state === 'function' ? this._target.state() : undefined;
  }

  toString(): string {
    return `ActorRef(${this._target.path || this._target.id})`;
  }
}

/** Placeholder for "this message has no sender" (an `ask` always has one). */
class DeadLetterRef {
  // 公开声明里就是 `null`（见 index.d.ts 的 DeadLetterRef）：没有 id、没有路径，只有"不可回复"
  get id(): null {
    return null;
  }

  get path(): null {
    return null;
  }

  get isLocal(): boolean {
    return true;
  }

  tell() {
    return false;
  }

  ask() {
    return Promise.reject(new ActorStoppedError('the sender is not replyable'));
  }

  stop() {
    return Promise.resolve();
  }

  inspect() {
    return { dead: true };
  }

  state(): unknown {
    return undefined;
  }

  toString(): string {
    return 'DeadLetterRef';
  }
}

module.exports = { ActorRef, DeadLetterRef };
