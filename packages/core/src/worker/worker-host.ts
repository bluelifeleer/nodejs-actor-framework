// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * Worker-side counterpart of WorkerDelegate.
 *
 * Runs one actor inside a worker thread: it loads the actor module, runs the
 * lifecycle hooks and `receive`, and bridges `ctx` back to the main thread so
 * that spawning children, messaging other actors and snapshots keep working
 * from inside an isolated actor.
 *
 * Only structured-cloneable values cross the boundary — that is the price (and
 * the point) of real isolation.
 */

const { parentPort } = require('worker_threads');
const { defineActor } = require('../actor/actor.ts');
const Trace = require('../obs/trace.ts');

/** 主线程侧发来的调用（spawn/tell/ask/…）的等待表。 */
interface PendingCall {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** worker 里跑着的 Actor 实例（形态由定义决定，这里只约束框架用到的部分）。 */
interface WorkerInstance {
  postStop?(ctx: unknown): void | Promise<void>;
  id?: string;
  path?: string;
  state?: unknown;
  receive(msg: unknown, ctx: unknown): unknown;
  preStart?(ctx: unknown): void | Promise<void>;
  postRecover?(ctx: unknown): void | Promise<void>;
  [key: string]: unknown;
}

interface WorkerMessage {
  kind: string;
  [key: string]: unknown;
}

let instance: WorkerInstance | null = null;
let currentSender: { id: string | undefined; path: string; isLocal: boolean } | null = null;
let handling = false;
const pendingCalls = new Map<number, PendingCall>();
let callSeq = 0;

const send = (msg: WorkerMessage): void => parentPort.postMessage(msg);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function callMain(op: string, args: unknown, timeoutMs = 60000): Promise<unknown> {
  const id = ++callSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`ctx.${op} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingCalls.set(id, { resolve, reject, timer });
    send({ kind: 'ctx_call', callId: id, op, args });
  });
}

/** Accept an ActorRef-like object, a path string, or a bare id. */
function toSpec(target: unknown): string | null {
  if (target === null || target === undefined) return null;
  if (typeof target === 'string') return target;
  if (typeof (target as { path?: unknown }).path === 'string') return (target as { path: string }).path;
  return String(target);
}

/** Post a message that may fail structured cloning, without killing the actor. */
function safeSend(msg: WorkerMessage, onCloneFailure?: (err: unknown) => void): boolean {
  try {
    send(msg);
    return true;
  } catch (err) {
    if (onCloneFailure) onCloneFailure(err);
    return false;
  }
}

const ctx = {
  restored: false,
  /** Trace context of the message being handled (tracing plugin). */
  trace: null as unknown,

  get self(): { id: string | null; path: string | null; isLocal: boolean } {
    return { id: instance?.id ?? null, path: instance?.path ?? null, isLocal: true };
  },

  get sender(): { id: string | undefined; path: string; isLocal: boolean } | null {
    return currentSender;
  },

  get id(): string | null {
    return instance?.id ?? null;
  },

  get path(): string | null {
    return instance?.path ?? null;
  },

  get handling(): boolean {
    return handling;
  },

  get children(): never[] {
    return []; // children live on the main thread (supervised by the owner)
  },

  spawn(definition: unknown, options?: unknown): Promise<unknown> {
    return callMain('spawn', { definition: toSpec(definition), options });
  },

  tell(target: unknown, msg: unknown): boolean {
    // 与内联 ctx.tell 同签名：返回“是否已交给传输层”；失败经 ctx.log 可见
    void callMain('tell', { target: toSpec(target), msg, trace: ctx.trace }).catch((err: unknown) => {
      ctx.log('tell_failed', { err: errorMessage(err) });
    });
    return true;
  },

  ask(target: unknown, msg: unknown, timeoutMs?: number): Promise<unknown> {
    return callMain('ask', { target: toSpec(target), msg, timeoutMs, trace: ctx.trace });
  },

  span(): unknown {
    // span 是纯本地计算（traceId/spanId），不需要回主线程；有 trace 上下文才创建
    return ctx.trace ? Trace.child(ctx.trace) : null;
  },

  stop(target?: unknown): Promise<unknown> {
    return callMain('stop', { target: target === undefined ? null : toSpec(target) });
  },

  stopSelf(): Promise<unknown> {
    return callMain('stop', { target: null });
  },

  saveSnapshot(): Promise<unknown> {
    return callMain('saveSnapshot', {});
  },

  persist(): never {
    throw new Error("persistence mode 'events' is not supported together with isolation: 'worker'");
  },

  log(message: string, meta?: Record<string, unknown>): void {
    safeSend({ kind: 'log', event: 'actor', meta: { path: ctx.path, message, ...(meta || {}) } });
  },
};

async function handleStart(msg: WorkerMessage): Promise<void> {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(String(msg.modulePath));
    const candidate = msg.exportName && msg.exportName !== 'default'
      ? mod[msg.exportName as string]
      : (mod.default !== undefined ? mod.default : mod);
    if (candidate === undefined) {
      throw new Error(`module ${String(msg.modulePath)} does not export "${String(msg.exportName ?? 'default')}"`);
    }
    const definition = defineActor(candidate);
    instance = (definition as { create(): WorkerInstance }).create();
    if (!instance || typeof instance.receive !== 'function') {
      throw new Error(`module ${String(msg.modulePath)} does not define an actor with receive()`);
    }
    instance.id = String(msg.id);
    instance.path = String(msg.path);

    // Same ordering as inline actors: preStart establishes initial state, then
    // the snapshot is applied on top of it.
    if (typeof instance.preStart === 'function') await instance.preStart.call(instance, ctx);

    if (msg.snapshot !== undefined && msg.snapshot !== null) {
      instance.state = msg.snapshot;
      ctx.restored = true;
    } else {
      ctx.restored = false;
    }

    const postRecover = instance.postRecover;
    if (typeof postRecover === 'function') await postRecover.call(instance, ctx);

    send({ kind: 'started', path: msg.path, pid: process.pid });
  } catch (err) {
    send({ kind: 'start_failed', error: errorMessage(err) });
  }
}

async function handleInvoke(msg: WorkerMessage): Promise<void> {
  handling = true;
  currentSender = msg.senderPath
    ? { id: String(msg.senderPath).split('/').pop(), path: String(msg.senderPath), isLocal: true }
    : null;
  ctx.trace = msg.trace || null;
  try {
    const data = await (instance as WorkerInstance).receive(msg.payload, ctx);
    const ok = safeSend(
      { kind: 'result', seq: msg.seq, ok: true, data },
      (err) => send({ kind: 'result', seq: msg.seq, ok: false, error: `reply cannot be cloned: ${errorMessage(err)}` }),
    );
    if (!ok) return;
  } catch (err) {
    send({ kind: 'result', seq: msg.seq, ok: false, error: errorMessage(err) });
  } finally {
    handling = false;
    currentSender = null;
    ctx.trace = null;
  }
}

function handleSnapshot(msg: WorkerMessage): void {
  try {
    safeSend(
      { kind: 'snapshot_data', seq: msg.seq, state: instance ? instance.state : undefined },
      (err) => send({ kind: 'snapshot_data', seq: msg.seq, error: `state cannot be cloned: ${errorMessage(err)}` }),
    );
  } catch (err) {
    send({ kind: 'snapshot_data', seq: msg.seq, error: errorMessage(err) });
  }
}

async function handleStop(msg: WorkerMessage): Promise<void> {
  try {
    const postStop = instance?.postStop;
    if (instance !== null && typeof postStop === 'function') await postStop.call(instance, ctx);
  } catch (err) {
    send({ kind: 'log', event: 'actor_hook_error', meta: { hook: 'postStop', err: errorMessage(err) } });
  } finally {
    instance = null;
    send({ kind: 'stopped', seq: msg.seq });
  }
}

function handleCtxResult(msg: WorkerMessage): void {
  const entry = pendingCalls.get(Number(msg.callId));
  if (entry === undefined) return;
  pendingCalls.delete(Number(msg.callId));
  clearTimeout(entry.timer);
  if (msg.ok) entry.resolve(msg.data);
  else entry.reject(new Error(typeof msg.error === 'string' ? msg.error : 'context call failed'));
}

parentPort.on('message', (msg: WorkerMessage) => {
  if (msg === null || typeof msg !== 'object') return;
  switch (msg.kind) {
    case 'start':
      handleStart(msg);
      break;
    case 'invoke':
      handleInvoke(msg);
      break;
    case 'snapshot':
      handleSnapshot(msg);
      break;
    case 'stop':
      handleStop(msg);
      break;
    case 'ctx_result':
      handleCtxResult(msg);
      break;
    default:
      break;
  }
});

/** A stray failure must kill this worker so the owner can restart the actor. */
process.on('uncaughtException', (err) => {
  send({ kind: 'log', event: 'worker_uncaught', meta: { err: errorMessage(err) } });
  setTimeout(() => process.exit(1), 20);
});

process.on('unhandledRejection', (err) => {
  send({ kind: 'log', event: 'worker_unhandled_rejection', meta: { err: errorMessage(err) } });
  setTimeout(() => process.exit(1), 20);
});
