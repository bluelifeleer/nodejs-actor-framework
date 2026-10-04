'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');
const { ActorDefinition } = require('../actor/actor');
const { DefinitionError, ActorStoppedError } = require('../actor/errors');

/**
 * Main-thread side of worker isolation.
 *
 * `isolation: 'worker'` runs the actor's code in its own thread, so a CPU-heavy
 * or native-crashing actor cannot block or corrupt the rest of the node. The
 * price is that:
 *
 *  - the definition must be a **module path** (code cannot be shipped to a
 *    worker without an eval, which this framework deliberately keeps opt-in);
 *  - messages, replies and state must be structured-cloneable;
 *  - persistence is limited to 'none' and 'snapshot' (state transfer).
 *
 * Everything else — mailbox, backpressure, supervision, restart, dead letters —
 * stays on the owning ActorCell, so the two isolation modes share one model.
 */

const HOST_PATH = path.join(__dirname, 'worker-host.js');

/** Resolve an actor module path, refusing anything outside the project root. */
function resolveActorModule(requested) {
  const root = config.root;
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DefinitionError(`actor module must live inside ${root} (got "${requested}")`);
  }
  return resolved;
}

/** Build a Definition for an actor that will run in a worker thread. */
function defineWorkerActor(modulePath, options = {}) {
  if (typeof modulePath !== 'string' || modulePath.trim() === '') {
    throw new DefinitionError(
      "isolation: 'worker' requires the actor definition to be a module path string, " +
        "e.g. spawn('./actors/player.js', { isolation: 'worker' })",
    );
  }
  const resolved = resolveActorModule(modulePath);
  const exportName = options.exportName || 'default';
  const name = path.basename(resolved).replace(/\.(js|cjs|mjs)$/, '');
  return new ActorDefinition({
    name,
    kind: 'worker',
    create() {
      throw new DefinitionError(`worker-isolated actor "${name}" runs in its own thread`);
    },
    options: options.actorOptions || {},
    modulePath: resolved,
    exportName,
  });
}

class WorkerDelegate {
  constructor({ cell, modulePath, exportName }) {
    this.cell = cell;
    this.modulePath = modulePath;
    this.exportName = exportName;
    this.worker = null;
    /** @type {Map<number, {resolve:Function, reject:Function}>} */
    this.invokePending = new Map();
    this.controlPending = new Map();
    this.seq = 0;
    this.stopped = false;
    this.pid = null;
  }

  async start({ snapshot } = {}) {
    const worker = new Worker(HOST_PATH, {});
    this.worker = worker;

    const failure = new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg && msg.kind === 'started') {
          this.pid = msg.pid;
          worker.off('message', onMessage);
          resolve(msg);
        } else if (msg && msg.kind === 'start_failed') {
          worker.off('message', onMessage);
          reject(new Error(msg.error));
        }
      };
      worker.on('message', onMessage);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`actor worker exited with code ${code} before starting`)));
    });

    worker.on('message', (msg) => this._onMessage(msg));
    worker.on('error', (err) => this._onWorkerLost(err));
    worker.on('exit', (code) => this._onWorkerLost(new Error(`actor worker exited (code ${code})`)));

    worker.postMessage({
      kind: 'start',
      modulePath: this.modulePath,
      exportName: this.exportName,
      id: this.cell.id,
      path: this.cell.path,
      snapshot,
    });

    try {
      await failure;
    } catch (err) {
      // A failed start must not leak the thread: it would keep the process
      // alive forever and burn a slot per failed spawn.
      worker.__dead = true;
      this._onWorkerLost(err);
      await worker.terminate().catch(() => {});
      throw err;
    }
    return this;
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'result') {
      const entry = this.invokePending.get(msg.seq);
      if (!entry) return;
      this.invokePending.delete(msg.seq);
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(new Error(msg.error));
      return;
    }

    if (msg.kind === 'snapshot_data' || msg.kind === 'stopped' || msg.kind === 'ctx_result') {
      this._settleControl(msg);
      return;
    }

    if (msg.kind === 'log') {
      this.cell.system._log(msg.event, msg.meta);
      return;
    }

    if (msg.kind === 'ctx_call') {
      this._handleCtxCall(msg);
    }
  }

  _settleControl(msg) {
    const key = msg.seq !== undefined ? `seq:${msg.seq}` : `ctx:${msg.callId}`;
    const entry = this.controlPending.get(key);
    if (!entry) return;
    this.controlPending.delete(key);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg);
  }

  /**
   * Run a `ctx.*` call that the worker cannot do itself (it lives on the main
   * thread: spawning children, reaching other actors, persisting).
   */
  async _handleCtxCall(msg) {
    const { callId, op, args } = msg;
    const reply = (ok, payload) => {
      if (this.worker && !this.worker.__dead) {
        this.worker.postMessage({ kind: 'ctx_result', callId, ok, ...payload });
      }
    };

    try {
      switch (op) {
        case 'spawn': {
          const ref = await this.cell.spawnChild(args.definition, {
            ...(args.options || {}),
            isolation: 'worker',
          });
          return reply(true, { data: { id: ref.id, path: ref.path } });
        }
        case 'tell': {
          const target = this._resolve(args.target);
          return reply(true, { data: target.tell(args.msg, this.cell.ref, args.trace) });
        }
        case 'ask': {
          const target = this._resolve(args.target);
          const data = await target.ask(args.msg, args.timeoutMs, this.cell.ref, args.trace);
          return reply(true, { data });
        }
        case 'stop': {
          if (args.target === null) {
            setImmediate(() => this.cell.stop().catch(() => {}));
            return reply(true, { data: true });
          }
          return reply(true, { data: await this._resolve(args.target).stop() });
        }
        case 'saveSnapshot': {
          await this.cell.saveSnapshot();
          return reply(true, { data: true });
        }
        default:
          return reply(false, { error: `unsupported worker ctx operation: ${op}` });
      }
    } catch (err) {
      return reply(false, { error: err && err.message ? err.message : String(err) });
    }
  }

  _resolve(target) {
    if (!target) throw new ActorStoppedError('ctx: target actor is required');
    const ref = this.cell.system.resolve(target);
    if (!ref) throw new ActorStoppedError(`no actor registered as "${target}"`);
    return ref;
  }

  /** Everything that was in flight when the worker died. */
  _onWorkerLost(err) {
    if (this.worker) this.worker.__dead = true;
    for (const entry of this.invokePending.values()) entry.reject(err);
    this.invokePending.clear();
    for (const entry of this.controlPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.controlPending.clear();
  }

  /** Run one message inside the worker. */
  invoke(payload, senderPath, trace = null) {
    if (this.stopped || !this.worker || this.worker.__dead) {
      return Promise.reject(new ActorStoppedError(`worker for ${this.cell.path} is gone`));
    }
    const seq = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.invokePending.set(seq, { resolve, reject });
      try {
        this.worker.postMessage({ kind: 'invoke', seq, payload, senderPath: senderPath || null, trace });
      } catch (err) {
        this.invokePending.delete(seq);
        reject(new Error(`message cannot be cloned to the worker: ${err.message}`));
      }
    });
  }

  /** Ask the worker for its actor state (used by snapshots and introspection). */
  getState(timeoutMs = 5000) {
    if (!this.worker || this.worker.__dead) return Promise.resolve(undefined);
    const seq = (this.seq += 1);
    return this._control(`seq:${seq}`, { kind: 'snapshot', seq }, timeoutMs).then((msg) => msg.state);
  }

  _control(key, message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlPending.delete(key);
        reject(new Error(`worker control call "${message.kind}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.controlPending.set(key, { resolve, reject, timer });
      try {
        this.worker.postMessage(message);
      } catch (err) {
        this.controlPending.delete(key);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Graceful stop: postStop runs inside the worker, then the thread exits. */
  async stop(timeoutMs = 5000) {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    if (!worker) return;

    if (!worker.__dead) {
      const seq = (this.seq += 1);
      try {
        await this._control(`seq:${seq}`, { kind: 'stop', seq }, timeoutMs);
      } catch {
        /* the worker may already be gone; terminate below either way */
      }
    }
    this._onWorkerLost(new ActorStoppedError(`worker for ${this.cell.path} stopped`));
    worker.__dead = true;
    try {
      await worker.terminate();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { WorkerDelegate, defineWorkerActor, resolveActorModule, HOST_PATH };
