'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const msgStore = require('./message-store');
const DLQ = require('./dead-letter-queue');
const TokenBucket = require('./token-bucket');
const { Counters } = require('./metrics');
const config = require('./config');

const PRIORITY = { HIGH: 0, NORMAL: 1, LOW: 2 };
const VALID_PRIORITIES = new Set([PRIORITY.HIGH, PRIORITY.NORMAL, PRIORITY.LOW]);

function normalizePriority(value) {
  return VALID_PRIORITIES.has(value) ? value : PRIORITY.NORMAL;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Priority mailbox with a hard size bound and room for retries at the front.
 * Order within a priority level is FIFO; invalid priorities are normalised so
 * a malformed message can never crash the actor.
 */
class PriorityMailbox {
  constructor(maxSize = config.actor.maxMailboxSize) {
    this.queues = [[], [], []];
    this.maxSize = maxSize;
  }

  get length() {
    return this.queues[0].length + this.queues[1].length + this.queues[2].length;
  }

  get isFull() {
    return this.length >= this.maxSize;
  }

  push(msg) {
    if (this.isFull) return false;
    this.queues[normalizePriority(msg.priority)].push(msg);
    return true;
  }

  /** Re-queue a message ahead of its peers (used for retries). */
  pushFront(msg) {
    this.queues[normalizePriority(msg.priority)].unshift(msg);
    return true;
  }

  peek() {
    for (let i = 0; i < 3; i += 1) {
      if (this.queues[i].length > 0) return this.queues[i][0];
    }
    return null;
  }

  shift() {
    for (let i = 0; i < 3; i += 1) {
      if (this.queues[i].length > 0) return this.queues[i].shift();
    }
    return null;
  }

  remove(msgId) {
    for (let i = 0; i < 3; i += 1) {
      const idx = this.queues[i].findIndex((m) => m.__msgId === msgId);
      if (idx >= 0) return this.queues[i].splice(idx, 1)[0];
    }
    return null;
  }

  clear() {
    this.queues = [[], [], []];
  }

  toArray() {
    return [...this.queues[0], ...this.queues[1], ...this.queues[2]];
  }
}

class Actor {
  constructor(options = {}) {
    this.actorId = null;
    this.state = {};
    this.mailbox = new PriorityMailbox(options.maxMailboxSize);
    this.monitors = new Set();
    this.processing = false;
    this.stopped = false;

    this.bucket = new TokenBucket(options.tokenBucketCapacity, options.tokenBucketRate);
    this.maxRetry = options.maxRetry;
    this.retryBackoffMs = options.retryBackoffMs;
    this.maxRetryBackoffMs = options.maxRetryBackoffMs;
    this.batchMaxSize = options.batchMaxSize;
    this.batchTimeoutMs = options.batchTimeoutMs;
    this.metricsFlushMs = options.metricsFlushMs;
    this.maxRecovered = options.maxRecovered;

    // Injectable so the class can be unit-tested outside a worker thread.
    this.port = options.port || parentPort;

    this.counters = new Counters();
    this._waiters = [];
    this._metricsTimer = null;

    // Default business handler; replaceable via hot reload.
    this.onMessage = async function defaultHandler(msg) {
      switch (msg.type) {
        case 'hurt': {
          const damage = Number(msg.damage);
          if (!Number.isFinite(damage)) throw new Error(`hurt: damage must be a finite number, got ${msg.damage}`);
          this.state.hp = (Number.isFinite(this.state.hp) ? this.state.hp : 100) - damage;
          return this.state.hp;
        }
        case 'debug:getState':
          return this.state;
        default:
          return { ok: true, type: msg.type };
      }
    };
  }

  // --- mailbox / lifecycle -------------------------------------------------

  push(msg) {
    const ok = this.mailbox.push(msg);
    if (ok) this._wake();
    return ok;
  }

  _wake() {
    const waiter = this._waiters.shift();
    if (waiter) waiter();
  }

  _waitForMessage(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, remaining);
      const waiter = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      this._waiters.push(waiter);
    });
  }

  /** Validate + persist + enqueue. Never throws for a bad message. */
  async send(msg) {
    if (!msg || typeof msg !== 'object') return false;
    msg.priority = normalizePriority(msg.priority);
    if (!msg.__msgId) msg.__msgId = crypto.randomUUID();

    if (this.mailbox.isFull || this.mailbox.length >= this.mailbox.maxSize) {
      this.counters.inc('dropped');
      this.port.postMessage({
        type: 'mailbox_full',
        replyId: msg.__replyId,
        error: `mailbox full (limit ${this.mailbox.maxSize})`,
      });
      logger.logMessage('mailbox_full', this.actorId, msg);
      return false;
    }

    await msgStore.append(this.actorId, msg);
    this.mailbox.push(msg);
    logger.logMessage('enqueue', this.actorId, msg);
    this.schedule();
    return true;
  }

  schedule() {
    if (this.processing || this.stopped) return;
    this.processing = true;
    this._startMetricsTimer();
    this._runLoop()
      .catch((err) => logger.logSystem('loop_error', { actorId: this.actorId, err: err.message }))
      .finally(() => {
        this.processing = false;
        if (this.mailbox.length > 0 && !this.stopped) this.schedule();
      });
  }

  async _runLoop() {
    while (this.mailbox.length > 0 && !this.stopped) {
      const batch = await this._collectBatch();
      if (batch.length === 0) continue;
      await this._processBatch(batch);
      this.counters.inc('batches');
      this._flushMetrics();
    }
  }

  /**
   * Dual-trigger batch collection: flush on `batchMaxSize` messages, or after
   * `batchTimeoutMs` if fewer arrived — but the timeout can never turn a
   * handler error into a process crash, because processing is always wrapped.
   */
  async _collectBatch() {
    const batch = [];
    const deadline = Date.now() + this.batchTimeoutMs;

    while (batch.length < this.batchMaxSize) {
      if (this.mailbox.length === 0) {
        if (batch.length === 0) break;
        if (Date.now() >= deadline) break;
        const got = await this._waitForMessage(deadline);
        if (!got) break;
        continue;
      }

      const wait = this.bucket.msUntil(1);
      if (wait > 0) {
        // Throttle without re-ordering the mailbox.
        this.counters.inc('throttled');
        await sleep(Math.min(wait, 100));
        continue;
      }
      this.bucket.tryConsume(1);
      batch.push(this.mailbox.shift());
    }
    return batch;
  }

  async _processBatch(batch) {
    const acked = [];

    if (typeof this.onBatch === 'function') {
      const started = Date.now();
      try {
        await this.onBatch.call(this, batch);
        for (const msg of batch) {
          this.counters.inc('received');
          this.counters.inc('handled');
          acked.push(msg.__msgId);
        }
      } catch (err) {
        // Batch contract failed: fall back to per-message isolation so one bad
        // message cannot take its neighbours down with it.
        logger.logSystem('batch_error', { actorId: this.actorId, err: err.message, size: batch.length });
        for (const msg of batch) {
          const outcome = await this._processMessage(msg);
          if (outcome !== 'retry') acked.push(msg.__msgId);
        }
      }
      this.counters.addLatency(Date.now() - started);
    } else {
      for (const msg of batch) {
        const outcome = await this._processMessage(msg);
        if (outcome !== 'retry') acked.push(msg.__msgId);
      }
    }

    if (acked.length > 0) {
      try {
        await msgStore.ack(this.actorId, acked);
      } catch (err) {
        logger.logSystem('ack_error', { actorId: this.actorId, err: err.message });
      }
    }
  }

  /**
   * Handle exactly one message. Returns 'handled' | 'retry' and NEVER throws,
   * so a failure is always attributed to the message that actually failed.
   */
  async _processMessage(msg) {
    const started = Date.now();
    this.counters.inc('received');
    try {
      const res = await this.onMessage.call(this, msg);
      this.counters.inc('handled');
      this.counters.addLatency(Date.now() - started);
      logger.logMessage('handle', this.actorId, msg);
      this._reply(msg, res);
      return 'handled';
    } catch (err) {
      logger.logSystem('msg_error', {
        actorId: this.actorId,
        msgId: msg.__msgId,
        type: msg.type,
        err: err.message,
      });

      if ((msg.retryCount || 0) < this.maxRetry) {
        msg.retryCount = (msg.retryCount || 0) + 1;
        this.counters.inc('retries');
        logger.logMessage('retry', this.actorId, msg);
        const backoff = Math.min(this.retryBackoffMs * 2 ** (msg.retryCount - 1), this.maxRetryBackoffMs);
        if (backoff > 0) await sleep(backoff);
        this.mailbox.pushFront(msg); // stays durable: it was never acked
        return 'retry';
      }

      // Retries exhausted -> dead letter, then ack so it is not replayed.
      this.counters.inc('failed');
      this.counters.inc('dlq');
      try {
        await DLQ.enqueue({
          actorId: this.actorId,
          msg,
          reason: err.message,
          retryCount: msg.retryCount || 0,
        });
      } catch (dlqErr) {
        logger.logSystem('dlq_error', { actorId: this.actorId, err: dlqErr.message });
      }
      this.counters.addLatency(Date.now() - started);
      if (msg.__replyId) {
        this.port.postMessage({
          type: 'error',
          replyId: msg.__replyId,
          err: `max retry reached, moved to DLQ: ${err.message}`,
        });
      }
      return 'dlq';
    }
  }

  _reply(msg, data) {
    if (!msg.__replyId) return;
    this.port.postMessage({ type: 'reply', replyId: msg.__replyId, data: data === undefined ? null : data });
  }

  // --- metrics -------------------------------------------------------------

  _startMetricsTimer() {
    if (this._metricsTimer || !this.metricsFlushMs) return;
    this._metricsTimer = setInterval(() => this._flushMetrics(), this.metricsFlushMs);
    if (typeof this._metricsTimer.unref === 'function') this._metricsTimer.unref();
  }

  _stopMetricsTimer() {
    if (this._metricsTimer) clearInterval(this._metricsTimer);
    this._metricsTimer = null;
  }

  /** Post accumulated counters to the main process (workers do not share state). */
  _flushMetrics() {
    if (this.counters.isEmpty) return;
    const delta = this.counters.take();
    this.port.postMessage({ type: 'metrics', actorId: this.actorId, delta });
  }

  // --- monitors ------------------------------------------------------------

  watch(watcherActorId) {
    this.monitors.add(String(watcherActorId));
    return this.monitors.size;
  }

  unwatch(watcherActorId) {
    this.monitors.delete(String(watcherActorId));
    return this.monitors.size;
  }

  // --- recovery ------------------------------------------------------------

  async loadPersistMessages() {
    let msgs = [];
    try {
      msgs = await msgStore.load(this.actorId);
    } catch (err) {
      logger.logSystem('recover_error', { actorId: this.actorId, err: err.message });
      return 0;
    }
    const capped = msgs.slice(0, this.maxRecovered);
    let recovered = 0;
    for (const raw of capped) {
      const msg = { ...raw };
      msg.priority = normalizePriority(msg.priority);
      msg.retryCount = msg.retryCount || 0;
      if (!msg.__msgId) msg.__msgId = crypto.randomUUID();
      if (this.mailbox.push(msg)) recovered += 1;
    }
    if (recovered > 0) {
      this.counters.inc('recovered', recovered);
      logger.logSystem('actor_recover', { actorId: this.actorId, count: recovered });
      this.schedule();
    }
    return recovered;
  }

  stats() {
    return {
      actorId: this.actorId,
      mailbox: this.mailbox.length,
      mailboxMax: this.mailbox.maxSize,
      processing: this.processing,
      stopped: this.stopped,
      monitors: [...this.monitors],
      tokens: Math.round(this.bucket.available() * 100) / 100,
      state: this.state,
      hasCustomHandler: this.onMessage.name !== 'defaultHandler',
    };
  }

  async shutdown(timeoutMs = config.actor.shutdownTimeoutMs) {
    this.stopped = true;
    const deadline = Date.now() + timeoutMs;
    while (this.processing && Date.now() < deadline) await sleep(20);
    this._flushMetrics();
    this._stopMetricsTimer();
    return { drained: this.mailbox.length === 0, pending: this.mailbox.length };
  }
}

// --- hot reload compilation ------------------------------------------------

/**
 * Compile user-supplied handler code.
 *
 * `new Function(...)` bodies are sloppy-mode, so calling the factory with
 * `.call(actor)` makes arrow functions capture `this === actor`. That is what
 * makes the documented `async (msg) => { this.state.hp ... }` form work — with
 * plain `.call()` on the result it could never work.
 */
function compileHandler(code, actor) {
  let expressionError;
  try {
    const factory = new Function(`return (${code});`);
    const fn = factory.call(actor); // sloppy-mode body: arrows capture `this`
    if (typeof fn === 'function') return fn;
    // The expression parsed but is not a function (e.g. a quoted string):
    // do NOT fall back to the statement form, which would silently install a
    // handler that ignores the message.
    throw new Error('expression did not evaluate to a function');
  } catch (err) {
    expressionError = err;
  }

  // Only a parse failure justifies trying the statement-body form.
  if (!(expressionError instanceof SyntaxError)) {
    throw new Error(`hot reload failed: ${expressionError.message}`);
  }

  try {
    return new Function('msg', code);
  } catch (err) {
    throw new Error(`hot reload failed: ${expressionError.message} | ${err.message}`);
  }
}

function resolveModulePath(requested) {
  const root = config.root;
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`hot reload module must live inside ${root}`);
  }
  return resolved;
}

function loadHandlerFromModule(actor, requested, exportName = 'default') {
  const resolved = resolveModulePath(requested);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(resolved);
  const candidate = exportName === 'default' ? mod.default ?? mod : mod[exportName];
  if (typeof candidate !== 'function') {
    throw new Error(`module ${requested} export "${exportName}" is not a function`);
  }
  return candidate;
}

// --- bootstrap (only inside a real worker thread) --------------------------

if (parentPort) {
  const actor = new Actor(config.actor);

  const handleControl = async (msg) => {
    const ctlId = msg.__ctlId;
    const reply = (ok, payload) => parentPort.postMessage({ type: 'ctl_reply', ctlId, ok, ...payload });

    try {
      switch (msg.type) {
        case 'hot_reload': {
          if (!config.hotReload.enabled) throw new Error('hot reload is disabled on this node (set ENABLE_HOT_RELOAD=1)');
          if (typeof msg.fnCode !== 'string' || !msg.fnCode.trim()) {
            throw new TypeError('fnCode must be a non-empty string');
          }
          const fn = compileHandler(msg.fnCode, actor);
          actor.onMessage = fn;
          logger.logSystem('hot_reload', { actorId: actor.actorId, bytes: msg.fnCode.length });
          return reply(true, { data: { installed: true, name: fn.name || 'anonymous' } });
        }
        case 'hot_reload_module': {
          const fn = loadHandlerFromModule(actor, msg.modulePath, msg.exportName);
          actor.onMessage = fn;
          logger.logSystem('hot_reload_module', { actorId: actor.actorId, module: msg.modulePath });
          return reply(true, { data: { installed: true, name: fn.name || 'module' } });
        }
        case 'monitor:watch':
          return reply(true, { data: { watchers: actor.watch(msg.watcherActorId) } });
        case 'monitor:unwatch':
          return reply(true, { data: { watchers: actor.unwatch(msg.watcherActorId) } });
        case 'debug:ping':
          return reply(true, { data: { actorId: actor.actorId, pid: process.pid } });
        case 'debug:stats':
          return reply(true, { data: actor.stats() });
        case 'actor:shutdown': {
          const data = await actor.shutdown(msg.timeoutMs);
          reply(true, { data });
          setTimeout(() => process.exit(0), 20);
          return undefined;
        }
        default:
          throw new Error(`unknown control message: ${msg.type}`);
      }
    } catch (err) {
      return reply(false, { error: err.message });
    }
  };

  const handleIncoming = async (msg) => {
    if (msg && msg.__ctl) return handleControl(msg);
    if (msg && msg.type === 'init') {
      actor.actorId = msg.actorId;
      actor.state = { hp: 100 };
      await actor.loadPersistMessages();
      return undefined;
    }
    if (msg && msg.type === 'shutdown_graceful') {
      await actor.shutdown();
      return undefined;
    }
    return actor.send(msg);
  };

  parentPort.on('message', (msg) => {
    Promise.resolve()
      .then(() => handleIncoming(msg))
      .catch((err) => logger.logSystem('inbound_error', { actorId: actor.actorId, err: err.message }));
  });

  const fatal = (kind, err) => {
    logger.logSystem(kind, { actorId: actor.actorId, err: err && err.message, stack: err && err.stack });
    // Monitor notifications are owned by the main process, which observes
    // every exit (crash, terminate or error) and can therefore be relied on.
    setTimeout(() => process.exit(1), 20);
  };

  process.on('uncaughtException', (err) => fatal('actor_crash', err));
  process.on('unhandledRejection', (err) =>
    fatal('actor_unhandled_rejection', err instanceof Error ? err : new Error(String(err))));
}

module.exports = { Actor, PriorityMailbox, compileHandler, normalizePriority, loadHandlerFromModule };

