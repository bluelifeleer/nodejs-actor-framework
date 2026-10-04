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
const { defineActor } = require('../actor/actor');

let instance = null;
let currentSender = null;
const pendingCalls = new Map();
let callSeq = 0;

const send = (msg) => parentPort.postMessage(msg);
const errorMessage = (err) => (err && err.message ? err.message : String(err));

function callMain(op, args, timeoutMs = 60000) {
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
function toSpec(target) {
  if (target === null || target === undefined) return null;
  if (typeof target === 'string') return target;
  if (typeof target.path === 'string') return target.path;
  return String(target);
}

/** Post a message that may fail structured cloning, without killing the actor. */
function safeSend(msg, onCloneFailure) {
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
  trace: null,

  get self() {
    return { id: instance ? instance.id : null, path: instance ? instance.path : null, isLocal: true };
  },

  get sender() {
    return currentSender;
  },

  get id() {
    return instance ? instance.id : null;
  },

  get path() {
    return instance ? instance.path : null;
  },

  get handling() {
    return currentSender !== undefined;
  },

  get children() {
    return []; // children live on the main thread (supervised by the owner)
  },

  spawn(definition, options) {
    return callMain('spawn', { definition: toSpec(definition), options });
  },

  tell(target, msg) {
    return callMain('tell', { target: toSpec(target), msg, trace: ctx.trace });
  },

  ask(target, msg, timeoutMs) {
    return callMain('ask', { target: toSpec(target), msg, timeoutMs, trace: ctx.trace });
  },

  span() {
    return callMain('span', { trace: ctx.trace });
  },

  stop(target) {
    return callMain('stop', { target: target === undefined ? null : toSpec(target) });
  },

  stopSelf() {
    return callMain('stop', { target: null });
  },

  saveSnapshot() {
    return callMain('saveSnapshot', {});
  },

  persist() {
    throw new Error("persistence mode 'events' is not supported together with isolation: 'worker'");
  },

  log(message, meta) {
    safeSend({ kind: 'log', event: 'actor', meta: { path: ctx.path, message, ...(meta || {}) } });
  },
};

async function handleStart(msg) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(msg.modulePath);
    const candidate = msg.exportName && msg.exportName !== 'default'
      ? mod[msg.exportName]
      : (mod.default !== undefined ? mod.default : mod);
    if (candidate === undefined) {
      throw new Error(`module ${msg.modulePath} does not export "${msg.exportName || 'default'}"`);
    }
    const definition = defineActor(candidate);
    instance = definition.create();
    if (!instance || typeof instance.receive !== 'function') {
      throw new Error(`module ${msg.modulePath} does not define an actor with receive()`);
    }
    instance.id = msg.id;
    instance.path = msg.path;

    // Same ordering as inline actors: preStart establishes initial state, then
    // the snapshot is applied on top of it.
    await instance.preStart(ctx);

    if (msg.snapshot !== undefined && msg.snapshot !== null) {
      instance.state = msg.snapshot;
      ctx.restored = true;
    } else {
      ctx.restored = false;
    }

    if (typeof instance.postRecover === 'function') await instance.postRecover(ctx);

    send({ kind: 'started', path: msg.path, pid: process.pid });
  } catch (err) {
    send({ kind: 'start_failed', error: errorMessage(err) });
  }
}

async function handleInvoke(msg) {
  currentSender = msg.senderPath ? { id: msg.senderPath.split('/').pop(), path: msg.senderPath, isLocal: true } : null;
  ctx.trace = msg.trace || null;
  try {
    const data = await instance.receive(msg.payload, ctx);
    const ok = safeSend(
      { kind: 'result', seq: msg.seq, ok: true, data },
      (err) => send({ kind: 'result', seq: msg.seq, ok: false, error: `reply cannot be cloned: ${errorMessage(err)}` }),
    );
    if (!ok) return;
  } catch (err) {
    send({ kind: 'result', seq: msg.seq, ok: false, error: errorMessage(err) });
  } finally {
    currentSender = null;
    ctx.trace = null;
  }
}

function handleSnapshot(msg) {
  try {
    safeSend(
      { kind: 'snapshot_data', seq: msg.seq, state: instance ? instance.state : undefined },
      (err) => send({ kind: 'snapshot_data', seq: msg.seq, error: `state cannot be cloned: ${errorMessage(err)}` }),
    );
  } catch (err) {
    send({ kind: 'snapshot_data', seq: msg.seq, error: errorMessage(err) });
  }
}

async function handleStop(msg) {
  try {
    if (instance && typeof instance.postStop === 'function') await instance.postStop(ctx);
  } catch (err) {
    send({ kind: 'log', event: 'actor_hook_error', meta: { hook: 'postStop', err: errorMessage(err) } });
  } finally {
    instance = null;
    send({ kind: 'stopped', seq: msg && msg.seq });
  }
}

function handleCtxResult(msg) {
  const entry = pendingCalls.get(msg.callId);
  if (!entry) return;
  pendingCalls.delete(msg.callId);
  clearTimeout(entry.timer);
  if (msg.ok) entry.resolve(msg.data);
  else entry.reject(new Error(msg.error || 'context call failed'));
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
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
