'use strict';

const Mailbox = require('./mailbox');
const TokenBucket = require('./token-bucket.ts');
const ChildSupervisor = require('./guardian');
const ActorContext = require('./actor-context');
const { ActorRef } = require('./actor-ref');
const { defineActor } = require('./actor');
const { resolvePersistence } = require('../store/persistence');
const { AskTimeoutError, MailboxFullError, ActorStoppedError, EscalationError, DefinitionError, PersistenceError } = require('./errors');
const RestartStrategy = require('./restart-strategy.ts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One actor instance plus its runtime.
 *
 * Guarantees:
 *  - one message is processed at a time, so actor state needs no locking;
 *  - the mailbox is bounded (backpressure policy is configurable);
 *  - a failure either crashes the actor (default, OTP style) or is retried
 *    inside the actor (opt-in durable mailbox) — never silently swallowed;
 *  - an actor that is stopped, or dies while a message is queued, always
 *    settles every pending `ask` instead of leaving it hanging.
 */
class ActorCell {
  constructor({ system, definition, id, parent = null, options = {} }) {
    this.system = system;
    this.definition = definition;
    this.id = String(id);
    this.parent = parent;
    this.path = parent ? `${parent.path}/${this.id}` : this.id;

    // A handler bag with stray keys is almost always a typo (`_helper()` instead
    // of `receive()`), and the framework only forwards known handler names —
    // so say something instead of silently dropping the method.
    if (definition.unknownKeys && definition.unknownKeys.length > 0) {
      system._log('actor_definition_unknown_keys', {
        actor: this.path,
        definition: definition.name,
        keys: definition.unknownKeys,
        hint: 'only receive/onMessage, preStart/onStart, postStop/onStop, postRecover, preRestart, applyEvent and state are forwarded',
      });
    }

    this.options = {
      ...system.actorDefaults,
      ...options,
      mailbox: { ...system.actorDefaults.mailbox, ...(options.mailbox || {}) },
      supervision: { ...system.actorDefaults.supervision, ...(options.supervision || {}) },
    };

    this.mailbox = new Mailbox(this.options.mailbox);
    this.children = new Map();
    this.childSupervisor = new ChildSupervisor({
      id: this.path,
      strategy: this.options.supervision.strategy || RestartStrategy.ONE_FOR_ONE,
      maxRestarts: this.options.supervision.maxRestarts,
      withinSeconds: this.options.supervision.withinSeconds,
    });

    this.persistence = resolvePersistence(this.options.persistence, system.persistenceStore);
    // A durable mailbox is a system-level capability; fall back to it, and fail
    // loudly if the strategy cannot actually persist anything.
    if (!this.persistence.mailboxStore) this.persistence.mailboxStore = system.mailboxStore || null;
    if (this.persistence.mode === 'mailbox' && !this.persistence.mailboxStore) {
      throw new PersistenceError(
        `actor "${this.path}" uses persistence mode "mailbox" but no mailboxStore was configured ` +
          '(pass createSystem({ mailboxStore }))',
      );
    }
    if ((this.persistence.mode === 'snapshot' || this.persistence.mode === 'events') && !this.persistence.store) {
      throw new PersistenceError(
        `actor "${this.path}" uses persistence mode "${this.persistence.mode}" but no store was configured ` +
          '(pass createSystem({ persistenceDir }) or persistence: adapter)',
      );
    }

    // --- isolation ---------------------------------------------------------
    this.isolation = this.options.isolation || 'inline';
    if (!['inline', 'worker'].includes(this.isolation)) {
      throw new DefinitionError(`unknown isolation "${this.isolation}" (expected inline|worker)`);
    }
    if (this.isolation === 'worker') {
      if (definition.kind !== 'worker') {
        throw new DefinitionError(
          `actor "${this.path}" uses isolation: 'worker' but was defined inline; ` +
            "pass a module path, e.g. spawn('./actors/player.js', { isolation: 'worker' })",
        );
      }
      if (!['none', 'snapshot'].includes(this.persistence.mode)) {
        throw new PersistenceError(
          `isolation: 'worker' supports persistence 'none' or 'snapshot', got "${this.persistence.mode}"`,
        );
      }
    }
    /** @type {import('./worker-delegate').WorkerDelegate|null} */
    this.delegate = null;

    // Optional per-actor rate limit (rateLimit plugin / { rateLimit } option).
    const limit = this.options.rateLimit || system.rateLimitPolicy || null;
    this.bucket = limit ? new TokenBucket(limit.capacity, limit.rate) : null;
    /** Trace context of the message being handled (tracing plugin). */
    this.currentTrace = null;
    /**
     * 崩溃/重启窗口内既没有 `instance` 也没有 `delegate`。此时若有外部调用
     * 读取状态（`ref.state()`、`saveSnapshot()`），旧行为是静默返回
     * `undefined`——调用方会以为"这个 Actor 没有状态"，甚至把空状态写进快照。
     * 这里改成等新 incarnation 就位（有界），而不是装作没有状态。
     */
    this._incarnationWaiters = [];
    this.context = new ActorContext(this);
    this.instance = null;
    this.started = false;
    this.stopped = false;
    this.crashing = false;
    this.handling = false;
    /** True while a turn is executing; guards against concurrent re-entry. */
    this.running = false;
    this.currentSender = null;
    this.restarts = 0;
    this.counters = {
      received: 0,
      handled: 0,
      failed: 0,
      retries: 0,
      deadLettered: 0,
      crashed: 0,
      restarted: 0,
      recovered: 0,
      throttled: 0,
      batches: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
    };

    this.ref = new ActorRef({
      id: this.id,
      path: this.path,
      // Forward every argument: the sender and trace must survive the ref
      // boundary so the callee can see who sent the message.
      tell: (msg, sender, trace) => this.tell(msg, sender, trace),
      ask: (msg, timeoutMs, sender, trace) => this.ask(msg, timeoutMs, sender, trace),
      stop: () => this.stop(),
      inspect: () => this.inspect(),
      state: () => this.fetchState(),
    });
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Create the instance, run preStart, then recover persisted state.
   *
   * preStart runs first so it can establish initial state unconditionally;
   * a snapshot or replayed events are applied on top of it (see postRecover).
   */
  async _init() {
    this.stopped = false;
    this.context.restored = false;
    if (this.isolation === 'worker') return this._initWorker();

    this.instance = this.definition.create();
    if (!this.instance || typeof this.instance.receive !== 'function') {
      throw new DefinitionError(`definition "${this.definition.name}" did not produce an actor with receive()`);
    }
    this.instance.id = this.id;
    this.instance.path = this.path;
    await this.instance.preStart(this.context);
    await this._restore();
    if (typeof this.instance.postRecover === 'function') {
      await this.instance.postRecover(this.context);
    }
    this.started = true;
    this._markIncarnation();
  }

  /**
   * Worker isolation: the actor's code lives in its own thread. The cell keeps
   * the mailbox, supervision and persistence; only execution is delegated.
   */
  async _initWorker() {
    const { WorkerDelegate } = require('../worker/worker-delegate');
    let snapshot;
    if (this.persistence.mode === 'snapshot' && this.persistence.store) {
      snapshot = await this.persistence.store.loadSnapshot(this.path);
      if (snapshot !== undefined) this.context.restored = true;
    }
    const delegate = new WorkerDelegate({
      cell: this,
      modulePath: this.definition.modulePath,
      exportName: this.definition.exportName,
    });
    await delegate.start({ snapshot });
    this.delegate = delegate;
    this.started = true;
    this._markIncarnation();
  }

  async _restore() {
    const { mode, store, mailboxStore } = this.persistence;
    if (mode === 'snapshot' && store) {
      const snapshot = await store.loadSnapshot(this.path);
      if (snapshot !== undefined) {
        const restoredState = typeof snapshot === 'object' && snapshot !== null ? { ...snapshot } : snapshot;
        this.instance.state = restoredState;
        this.context.restored = true;
      }
    } else if (mode === 'events' && store) {
      const events = await store.loadEvents(this.path);
      for (const event of events) this.instance.applyEvent(event);
      this.context.restored = events.length > 0;
      this.counters.recovered += events.length;
    } else if (mode === 'mailbox' && mailboxStore) {
      const records = await mailboxStore.load(this.path);
      for (const record of records) {
        const payload = record && Object.prototype.hasOwnProperty.call(record, 'payload') ? record.payload : record;
        const envelope = this._envelope(payload, null);
        envelope.__msgId = record.__msgId;
        this.mailbox.push(envelope);
      }
      this.counters.recovered += records.length;
      if (records.length > 0) this.system.scheduler.schedule(this);
    }
  }

  /** 是否有可用的 incarnation（内联实例或 worker 代理）。 */
  get _hasIncarnation() {
    return Boolean(this.instance || this.delegate);
  }

  _markIncarnation() {
    const waiters = this._incarnationWaiters.splice(0);
    for (const w of waiters) w();
  }

  /** 等新 incarnation 就位；已就位或已停止则立即返回。有界，避免永久挂起。 */
  _awaitIncarnation(timeoutMs = this.system.shutdownTimeoutMs || 5000) {
    if (this._hasIncarnation || this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this._incarnationWaiters.indexOf(waiter);
        if (idx >= 0) this._incarnationWaiters.splice(idx, 1);
        resolve(); // 超时后由调用方按"当前确实没有状态"处理
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      this._incarnationWaiters.push(waiter);
    });
  }

  /** preRestart + postStop for the current incarnation (idempotent). */
  async _teardown(reason, msg) {
    // Worker-isolated actors run their hooks inside the worker.
    if (this.delegate) {
      const delegate = this.delegate;
      this.delegate = null;
      this.started = false;
      try {
        await delegate.stop();
      } catch (err) {
        this.system._log('worker_stop_error', { path: this.path, err: err.message });
      }
      return;
    }
    if (!this.instance) return;
    const instance = this.instance;
    this.instance = null;
    this.started = false;
    try {
      if (reason && typeof instance.preRestart === 'function') {
        await instance.preRestart(reason, msg, this.context);
      }
    } catch (err) {
      this.system._log('actor_hook_error', { path: this.path, hook: 'preRestart', err: err.message });
    }
    try {
      if (typeof instance.postStop === 'function') await instance.postStop(this.context);
    } catch (err) {
      this.system._log('actor_hook_error', { path: this.path, hook: 'postStop', err: err.message });
    }
  }

  /**
   * Stop every child of this actor.
   *
   * `graceful` runs each child's own stop path, which means it executes
   * `postStop` **and persists its snapshot** — hard-terminating instead would
   * silently drop a child's state whenever a parent stops. Each child stop is
   * bounded so one stuck child cannot hang the parent's shutdown.
   */
  async _stopChildren(graceful = true) {
    const children = [...this.children.values()];
    this.children.clear();
    for (const child of children) {
      this.childSupervisor.remove(child.id);
      try {
        if (graceful) await child.stop(this.system.shutdownTimeoutMs);
        else await child._terminate('parent');
      } catch (err) {
        this.system._log('child_stop_error', { path: child.path, err: err.message });
        await child._terminate('parent').catch(() => {});
      }
    }
  }

  // --- messaging -----------------------------------------------------------

  _envelope(payload, reply, sender = null, parentTrace = null) {
    const trace = this.system.tracer && this.system.tracer.buildContext
      ? this.system.tracer.buildContext(parentTrace)
      : null;
    return { payload, reply, sender, retryCount: 0, ts: Date.now(), trace };
  }

  /** Fire and forget. Returns false when the mailbox refused the message. */
  tell(payload, sender = null, parentTrace = null) {
    if (this.stopped) return false;
    if (payload === undefined) throw new TypeError('tell(payload): payload is required');
    const envelope = this._envelope(payload, null, sender, parentTrace);
    return this._enqueue(envelope);
  }

  /** Send and wait for the value returned by `receive`. */
  ask(payload, timeoutMs, sender = null, parentTrace = null) {
    if (this.stopped) return Promise.reject(new ActorStoppedError(`actor ${this.path} is stopped`));
    if (payload === undefined) return Promise.reject(new TypeError('ask(payload): payload is required'));
    const timeout = timeoutMs === undefined ? this.options.askTimeoutMs : timeoutMs;

    return new Promise((resolve, reject) => {
      let timer = null;
      const reply = {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };
      if (Number.isFinite(timeout) && timeout > 0) {
        timer = setTimeout(() => {
          reply.reject(new AskTimeoutError(`ask to ${this.path} timed out after ${timeout}ms`, { actorId: this.path }));
        }, timeout);
        if (typeof timer.unref === 'function') timer.unref();
      }
      const envelope = this._envelope(payload, reply, sender, parentTrace);
      if (!this._enqueue(envelope)) {
        reply.reject(new MailboxFullError(`mailbox of ${this.path} is full (${this.mailbox.maxSize})`, { actorId: this.path }));
      }
    });
  }

  _enqueue(envelope) {
    const accepted = this.mailbox.push(envelope);
    if (!accepted) {
      this.counters.failed += 0; // backpressure is reported through the return value / rejection
      this.system._onMailboxRejected(this, envelope);
      return false;
    }
    if (this.persistence.mode === 'mailbox' && this.persistence.mailboxStore) {
      // Durability is best-effort at enqueue time: a failure here surfaces as
      // a rejection rather than losing the message silently.
      this.persistence.mailboxStore
        .append(this.path, { payload: envelope.payload })
        .then((record) => {
          envelope.__msgId = record.__msgId;
        })
        .catch((err) => this.system._log('durable_enqueue_failed', { path: this.path, err: err.message }));
    }
    this.system.scheduler.schedule(this);
    return true;
  }

  /** Process at most `max` messages, then yield to the scheduler. */
  async _runTurn(max) {
    // An actor must never process two messages at once. Without this guard a
    // message arriving while receive() is awaiting would start a second turn
    // and re-enter receive() concurrently — a data race on actor state.
    if (this.running) return;
    this.running = true;
    let processed = 0;
    try {
      while (processed < max && !this.stopped) {
        // Per-actor token bucket: wait for a token without reordering the
        // mailbox (the message stays at the head until it is admitted).
        if (this.bucket) {
          const wait = this.bucket.msUntil(1);
          if (wait > 0) {
            this.counters.throttled += 1;
            await sleep(Math.min(wait, 100));
            continue;
          }
          this.bucket.tryConsume(1);
        }
        const envelope = this.mailbox.shift();
        if (!envelope) break;
        processed += 1;
        if (envelope.kind === 'stop') {
          await this._handleStop(envelope);
          break;
        }
        await this._handleMessage(envelope);
      }
    } finally {
      // One turn = one batch of messages drained in this slice of the loop.
      if (processed > 0) this.counters.batches += 1;
      this.running = false;
      if (!this.stopped && this.mailbox.size > 0) this.system.scheduler.schedule(this);
    }
  }

  async _handleMessage(envelope) {
    this.counters.received += 1;
    this.currentSender = envelope.sender || null;
    this.currentTrace = envelope.trace || null;
    this.handling = true;
    const startedAt = Date.now();
    try {
      const result = this.delegate
        ? await this.delegate.invoke(envelope.payload, envelope.sender ? envelope.sender.path : null, envelope.trace)
        : await this.instance.receive(envelope.payload, this.context);
      this.counters.handled += 1;
      await this._acknowledge(envelope);
      if (envelope.reply) envelope.reply.resolve(result);
    } catch (err) {
      await this._onFailure(err, envelope);
    } finally {
      const elapsed = Date.now() - startedAt;
      this.counters.totalLatencyMs += elapsed;
      if (elapsed > this.counters.maxLatencyMs) this.counters.maxLatencyMs = elapsed;
      this.handling = false;
      this.currentSender = null;
      this.currentTrace = null;
    }
  }

  async _acknowledge(envelope) {
    if (this.persistence.mode !== 'mailbox' || !this.persistence.mailboxStore) return;
    if (!envelope.__msgId) return;
    try {
      await this.persistence.mailboxStore.ack(this.path, envelope.__msgId);
    } catch (err) {
      this.system._log('durable_ack_failed', { path: this.path, err: err.message });
    }
  }

  /**
   * Failure semantics, chosen per actor:
   *  - 'crash' (default): the actor fails, the supervisor decides; the message
   *    is dropped and any pending ask is rejected with the real error.
   *  - 'retry': the message is retried with backoff and finally dead-lettered
   *    while the actor keeps running (durable mailbox / queue semantics).
   */
  async _onFailure(err, envelope) {
    this.counters.failed += 1;
    const { failure, maxRetry, retryBackoffMs, maxRetryBackoffMs } = this.options;

    if (failure === 'retry' && (envelope.retryCount || 0) < maxRetry) {
      envelope.retryCount = (envelope.retryCount || 0) + 1;
      this.counters.retries += 1;
      const backoff = Math.min(retryBackoffMs * 2 ** (envelope.retryCount - 1), maxRetryBackoffMs);
      this.system._log('actor_message_retry', { path: this.path, attempt: envelope.retryCount, err: err.message });
      if (backoff > 0) await sleep(backoff);
      this.mailbox.pushFront(envelope);
      return;
    }

    if (failure === 'retry') {
      this.counters.deadLettered += 1;
      await this._acknowledge(envelope);
      this.system._deadLetter(this, envelope, err);
      if (envelope.reply) envelope.reply.reject(err);
      return;
    }

    // Crash semantics: settle the caller, then fail the actor.
    if (envelope.reply) envelope.reply.reject(err);
    await this._acknowledge(envelope);
    await this._crash(err, envelope.payload);
  }

  // --- failure / restart ---------------------------------------------------

  async _crash(reason, msg) {
    if (this.crashing || this.stopped) return;
    this.crashing = true;
    this.counters.crashed += 1;
    this.system._log('actor_crash', { path: this.path, err: reason && reason.message });
    try {
      await this._teardown(reason, msg);
      await this._stopChildren();
    } finally {
      this.crashing = false;
    }
    if (this.parent) await this.parent._onChildCrash(this, reason);
    else await this.system._onRootCrash(this, reason);
  }

  /** Bring a crashed (or whole-group-restarted) actor back up. */
  async _restart(reason) {
    this.restarts += 1;
    this.counters.restarted += 1;
    await this._teardown(reason === undefined ? null : reason, undefined);
    await this._stopChildren();
    await this._init();
    this.system._log('actor_restart', { path: this.path, restarts: this.restarts });
    if (this.mailbox.size > 0) this.system.scheduler.schedule(this);
  }

  async _onChildCrash(child, reason) {
    const decision = this.childSupervisor.decide(child.id);
    if (decision.action === 'escalate') {
      this.system._log('supervisor_escalate', {
        path: this.path,
        child: child.path,
        reason: decision.reason,
      });
      await this._crash(
        new EscalationError(`child ${child.path} exceeded its restart intensity (${decision.reason})`),
        null,
      );
      return;
    }
    if (decision.action !== 'restart') return;

    for (const id of decision.targets) {
      const target = this.children.get(id);
      if (!target) continue;
      try {
        await target._restart(reason);
      } catch (err) {
        // A restart that fails is itself a failure of that child.
        await this._onChildCrash(target, err);
      }
    }
  }

  // --- stopping ------------------------------------------------------------

  /**
   * Stop this actor and its children after the current message.
   *
   * Bounded by `shutdownTimeoutMs`: an actor stuck in an endless `await`
   * cannot pick up its stop envelope, and without the bound a single stuck
   * actor would hang `system.stop()` (i.e. the whole process shutdown).
   */
  stop(timeoutMs = this.system.shutdownTimeoutMs) {
    if (this._stopPromise) return this._stopPromise;

    let resolveStop;
    this._stopPromise = new Promise((resolve) => {
      resolveStop = resolve;
      this.mailbox.push({ kind: 'stop', resolve }, { system: true });
      this.system.scheduler.schedule(this);
    });

    const bounded = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    if (bounded === 0) return this._stopPromise;

    const timer = setTimeout(async () => {
      if (this.stopped) return;
      this.system._log('actor_stop_timeout', {
        path: this.path,
        timeoutMs: bounded,
        hint: 'the actor was busy; forcing termination',
      });
      try {
        await this._terminate('stop_timeout');
      } catch (err) {
        this.system._log('actor_terminate_failed', { path: this.path, err: err.message });
      }
      resolveStop();
    }, bounded);
    if (typeof timer.unref === 'function') timer.unref();

    return this._stopPromise.finally(() => clearTimeout(timer));
  }

  /** Stop without running the graceful path (parent already gone, or forced). */
  async _terminate(reasonTag = 'forced') {
    if (this.stopped) return;
    this.system._log('actor_terminate', { path: this.path, reason: reasonTag });
    this._rejectPending();
    await this._teardown(null, undefined);
    await this._stopChildren(false); // forced path: do not wait for graceful child stops
    this._finishStop();
  }

  async _handleStop(envelope) {
    // Persist ourselves before taking the children down: a parent's snapshot is
    // usually what makes its children reconstructable at all.
    // `instance` is null for worker-isolated actors (the actor lives in the
    // worker), so check for either incarnation owner — otherwise an isolated
    // actor with snapshot persistence would silently lose its state on stop.
    if (this.persistence.mode === 'snapshot' && this.persistence.onStop && (this.instance || this.delegate)) {
      try {
        await this.saveSnapshot();
      } catch (err) {
        this.system._log('snapshot_on_stop_failed', { path: this.path, err: err.message });
      }
    }
    // Graceful: children run postStop and persist their own snapshots.
    if (this.options.stopChildrenOnStop !== false) await this._stopChildren(true);
    await this._teardown(null, undefined);
    this._finishStop();
    if (envelope.resolve) envelope.resolve();
  }

  _finishStop() {
    const wasStopped = this.stopped;
    this.stopped = true;
    this.started = false;
    this._markIncarnation(); // 叫醒等待者：已停止，别等下去了
    // _rejectPending() drains the mailbox: clearing it first would silently
    // drop queued messages whose callers are still awaiting a reply.
    this._rejectPending();
    if (!wasStopped) {
      this.system._unregister(this);
      if (this.parent) {
        this.parent.children.delete(this.id);
        this.parent.childSupervisor.remove(this.id);
      }
    }
  }

  /** Never leave an `ask` hanging because the actor went away. */
  _rejectPending() {
    const leftover = this.mailbox.drain();
    for (const envelope of leftover) {
      if (envelope.reply) envelope.reply.reject(new ActorStoppedError(`actor ${this.path} stopped before replying`));
    }
  }

  // --- children ------------------------------------------------------------

  async spawnChild(definition, options = {}) {
    if (this.stopped) throw new ActorStoppedError(`cannot spawn from stopped actor ${this.path}`);
    const defn = options.isolation === 'worker'
      ? require('../worker/worker-delegate').defineWorkerActor(definition, options)
      : defineActor(definition);
    const id = options.id ? String(options.id) : `${defn.name}-${this.system._nextChildSeq()}`;
    if (this.children.has(id)) throw new DefinitionError(`child "${id}" already exists under ${this.path}`);

    const child = new ActorCell({
      system: this.system,
      definition: defn,
      id,
      parent: this,
      options: { ...defn.options, ...options },
    });
    this.children.set(id, child);
    this.childSupervisor.add(id);
    this.system._register(child);

    try {
      await child._init();
    } catch (err) {
      this.system._log('actor_init_failed', { path: child.path, err: err.message });
      const decision = this.childSupervisor.decide(id);
      if (decision.action === 'escalate') {
        this.system._log('supervisor_escalate', { path: this.path, child: child.path, reason: decision.reason });
        throw err;
      }
      for (const targetId of decision.targets) {
        const target = this.children.get(targetId);
        if (!target) continue;
        try {
          await target._restart(err);
        } catch (retryErr) {
          this.system._log('actor_init_retry_failed', { path: target.path, err: retryErr.message });
        }
      }
      if (!child.started) throw err;
    }
    return child.ref;
  }

  // --- persistence hooks ---------------------------------------------------

  async persistEvent(event) {
    const { mode, store } = this.persistence;
    if (mode === 'events' && store) await store.appendEvent(this.path, event);
    if (mode === 'snapshot') this._snapshotDirty = true;
    if (this.instance) this.instance.applyEvent(event);
    return event;
  }

  async saveSnapshot() {
    const { store } = this.persistence;
    if (!store) return undefined;
    const state = await this.fetchState();
    if (state === undefined) return undefined;
    await store.saveSnapshot(this.path, state);
    this._snapshotDirty = false;
    return state;
  }

  /**
   * The actor's current state: local for inline actors, fetched over the worker
   * protocol for isolated ones. Always a clone, never the live object.
   */
  async fetchState() {
    // 重启窗口内先等新 incarnation，别把"暂时没有"当成"没有状态"。
    if (!this._hasIncarnation && !this.stopped) await this._awaitIncarnation();
    if (this.delegate) return this.delegate.getState();
    if (!this.instance) return undefined;
    const state = this.instance.state;
    if (state === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(state));
    } catch {
      return state;
    }
  }

  /** Synchronous best-effort view for inspect(); worker state is not fetched. */
  _statePreview() {
    if (this.delegate) return { stateLocation: 'worker', state: '[isolated]' };
    const state = this.instance ? this.instance.state : undefined;
    try {
      return { state: state === undefined ? undefined : JSON.parse(JSON.stringify(state)) };
    } catch {
      return { state: '[unserialisable]' };
    }
  }

  // --- introspection -------------------------------------------------------

  inspect() {
    const preview = this._statePreview();
    return {
      id: this.id,
      path: this.path,
      definition: this.definition.name,
      isolation: this.isolation,
      worker: this.delegate ? { pid: this.delegate.pid } : null,
      started: this.started,
      stopped: this.stopped,
      restarts: this.restarts,
      mailbox: {
        size: this.mailbox.size,
        maxSize: this.mailbox.maxSize,
        overflow: this.mailbox.overflow,
        dropped: this.mailbox.dropped,
        rejected: this.mailbox.rejected,
      },
      counters: { ...this.counters },
      ...preview,
      children: [...this.children.keys()],
      supervision: this.childSupervisor.info(),
      persistence: { mode: this.persistence.mode, restored: this.context.restored },
    };
  }
}

module.exports = ActorCell;
