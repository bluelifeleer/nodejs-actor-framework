'use strict';

const EventEmitter = require('events');
const config = require('../config.ts');
const { InlineScheduler } = require('./scheduler.mts');
const ActorCell = require('./actor-cell.ts');
const ChildSupervisor = require('./guardian.ts');
const { defineActor } = require('./actor.ts');
const { FilePersistence, MemoryPersistence } = require('../store/persistence.ts');
const { Peer, createServerGateway, RemoteRef } = require('../cluster/remote.ts');
const { ActorNotFoundError, ActorStoppedError, EscalationError } = require('./errors.mts');
const RestartStrategy = require('./restart-strategy.mts');

const DEFAULT_ACTOR_OPTIONS = {
  mailbox: { maxSize: 1000, overflow: 'reject' },
  supervision: { strategy: RestartStrategy.ONE_FOR_ONE, maxRestarts: 3, withinSeconds: 5 },
  failure: 'crash',
  maxRetry: 3,
  retryBackoffMs: 50,
  maxRetryBackoffMs: 1000,
  persistence: 'none',
  askTimeoutMs: 5000,
};

/**
 * The actor system: root supervisor, registry, scheduler and defaults.
 *
 * A system is a self-contained world — nothing here is process-global, so two
 * systems can coexist in one process (which the previous env-driven singletons
 * made impossible).
 */
class ActorSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    if (options.logger === false) this.logger = null;
    else this.logger = options.logger || null;

    this.name = options.name || 'actor-system';
    this.startedAt = Date.now();
    this.stopped = false;

    this.actorDefaults = {
      ...DEFAULT_ACTOR_OPTIONS,
      ...(options.defaults || {}),
      mailbox: { ...DEFAULT_ACTOR_OPTIONS.mailbox, ...((options.defaults || {}).mailbox || {}) },
      supervision: { ...DEFAULT_ACTOR_OPTIONS.supervision, ...((options.defaults || {}).supervision || {}) },
    };

    this.scheduler = new InlineScheduler({
      messagesPerTurn: options.messagesPerTurn,
      cellsPerTurn: options.cellsPerTurn,
      onError: (err, cell) => this._log('scheduler_error', { path: cell && cell.path, err: err.message }),
    });

    const persistenceSpec = options.persistence;
    if (persistenceSpec && typeof persistenceSpec === 'object' && typeof persistenceSpec.loadSnapshot === 'function') {
      this.persistenceStore = persistenceSpec; // an adapter instance
    } else if (persistenceSpec && typeof persistenceSpec === 'object' && persistenceSpec.backend === 'memory') {
      this.persistenceStore = new MemoryPersistence();
    } else {
      const baseDir = (persistenceSpec && persistenceSpec.dir) || options.persistenceDir;
      this.persistenceStore = baseDir ? new FilePersistence({ baseDir }) : null;
    }
    this.mailboxStore = options.mailboxStore || null;

    this.rootSupervisor = new ChildSupervisor({
      id: this.name,
      strategy: this.actorDefaults.supervision.strategy,
      maxRestarts: this.actorDefaults.supervision.maxRestarts,
      withinSeconds: this.actorDefaults.supervision.withinSeconds,
    });

    /** @type {Map<string, ActorCell>} path (and unambiguous id) -> cell */
    this.cells = new Map();
    this.deadLetters = [];
    this.maxDeadLetters = options.maxDeadLetters || 1000;
    this._seq = 0;
    /** Optional server gateway (system.listen) and connected peers. */
    this.server = null;
    /** @type {Map<string, import('./remote').Peer>} */
    this.peers = new Map();

    // --- plugin services ---------------------------------------------------
    /** @type {Array<object>} */
    this._plugins = [...(options.plugins || [])].filter(Boolean);
    /** @type {Map<string, object>} installed plugins by name */
    this.installed = new Map();
    this._initPromise = null;
    /**
     * Hooks that plugins may fill in. Keeping them as plain fields means the
     * actor hot path stays branch-light when no plugin is installed.
     */
    this.tracer = null; // tracing plugin: Trace-like { buildContext, child }
    this.rateLimitPolicy = null; // rateLimit plugin: { capacity, ratePerSec }
    this.deadLetterStore = null; // deadLetters plugin: a DeadLetterQueue-like store
    this.deadLetterSink = null; // cluster/pubsub style async sink

    // Services attached by plugins. Declared so an absent service is a
    // documented `null` rather than `undefined`.
    this.cluster = null;
    this.pubsub = null;
    this.metrics = null;
    this.metricsExporter = null;

    /** How long a graceful actor stop may take before it is forced. */
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? config.actor.shutdownTimeoutMs;
  }

  /**
   * Install plugins. Idempotent, and called automatically by spawn()/listen()
   * so plugins work without an explicit bootstrap step.
   */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      for (const plugin of this._plugins) {
        if (typeof plugin.setup === 'function') await plugin.setup(this);
        this.installed.set(plugin.name || `plugin-${this.installed.size}`, plugin);
        this._log('plugin_installed', { plugin: plugin.name });
      }
    })();
    return this._initPromise;
  }

  /** The installed plugin with that name, or null. */
  plugin(name) {
    return this.installed.get(name) || null;
  }

  // --- spawning ------------------------------------------------------------

  /**
   * Spawn a top-level actor.
   * @param {Function|object} definition class, handler, or handler bag
   * @param {{id?:string}} [options]
   * @returns {Promise<import('./actor-ref').ActorRef>}
   */
  async spawn(definition, options = {}) {
    if (this.stopped) throw new ActorStoppedError('actor system is stopped');
    await this.init();
    const defn = options.isolation === 'worker'
      ? require('../worker/worker-delegate.ts').defineWorkerActor(definition, options)
      : defineActor(definition);
    const id = options.id ? String(options.id) : `${defn.name}-${(this._seq += 1)}`;
    if (this.cells.has(id)) throw new ActorStoppedError(`actor "${id}" already exists`);

    const cell = new ActorCell({
      system: this,
      definition: defn,
      id,
      parent: null,
      options: { ...defn.options, ...options },
    });
    this.rootSupervisor.add(id);
    this._register(cell);

    try {
      await cell._init();
    } catch (err) {
      this._log('actor_init_failed', { path: cell.path, err: err.message });
      const decision = this.rootSupervisor.decide(id);
      if (decision.action === 'escalate') {
        await this._onEscalation(cell, err);
        throw err;
      }
      let recovered = false;
      for (const targetId of decision.targets) {
        const target = this.cells.get(targetId);
        if (!target) continue;
        try {
          await target._restart(err);
          recovered = target.started;
        } catch (retryErr) {
          this._log('actor_init_retry_failed', { path: target.path, err: retryErr.message });
        }
      }
      if (!recovered) throw err;
    }

    this.emit('actor_started', cell.ref);
    return cell.ref;
  }

  /** Spawn and await readiness in one call (alias with a friendlier name). */
  async start(definition, options) {
    return this.spawn(definition, options);
  }

  // --- lookup --------------------------------------------------------------

  /** @returns {import('./actor-ref').ActorRef|null} */
  resolve(idOrPath) {
    const key = String(idOrPath);
    const direct = this.cells.get(key);
    if (direct && !direct.stopped) return direct.ref;
    // Convenience fallback for a bare id, but only when it is unambiguous:
    // "alice" may exist under several parents, and guessing would be wrong.
    let match = null;
    for (const cell of this.cells.values()) {
      if (cell.stopped || cell.id !== key) continue;
      if (match) return null; // ambiguous
      match = cell;
    }
    if (match) return match.ref;

    // Cluster plugin: a path that is not local may live on a known peer.
    if (this.cluster && typeof this.cluster.resolveRemote === 'function') {
      return this.cluster.resolveRemote(key);
    }
    return null;
  }

  /** Like resolve(), but throws when the actor is unknown. */
  ref(idOrPath) {
    const found = this.resolve(idOrPath);
    if (!found) throw new ActorNotFoundError(`no actor registered as "${idOrPath}"`);
    return found;
  }

  /** Introspection for one actor (works for stopped-but-remembered ids too). */
  inspect(idOrPath) {
    const key = String(idOrPath);
    const cell = this.cells.get(key);
    if (cell) return cell.inspect();
    const found = this.resolve(key);
    if (found) {
      for (const candidate of this.cells.values()) {
        if (candidate.ref === found) return candidate.inspect();
      }
    }
    throw new ActorNotFoundError(`no actor registered as "${idOrPath}"`);
  }

  /** Every live actor path, depth-first. */
  listActors() {
    return [...this.cells.keys()].sort();
  }

  get size() {
    return this.cells.size;
  }

  // --- clustering (location transparency) ----------------------------------

  /**
   * Serve this node's actors to peers. Returns the bound port, so passing
   * `port: 0` is a convenient way to get an ephemeral port in tests.
   */
  async listen(options = {}) {
    if (this.stopped) throw new ActorStoppedError('actor system is stopped');
    if (this.server) return this.server.boundPort;
    const server = createServerGateway(this, options);
    server.on('tell_error', (err, target) => this._log('remote_tell_failed', { target, err: err.message }));
    try {
      await server.listen();
    } catch (err) {
      this.server = null;
      throw err;
    }
    this.server = server;
    this.emit('listening', server.boundPort);
    return server.boundPort;
  }

  get port() {
    return this.server ? this.server.boundPort : null;
  }

  /** Connect to a peer node and get a handle that hands out remote ActorRefs. */
  async connect(options = {}) {
    if (!options.host || options.port === undefined) {
      throw new TypeError('connect({ host, port }) is required');
    }
    const key = `${options.host}:${options.port}`;
    const existing = this.peers.get(key);
    if (existing) return existing;

    const peer = new Peer({
      system: this,
      host: options.host,
      port: options.port,
      nodeId: options.nodeId,
      tls: options.tls || config.tls,
    });
    // Learning the peer's id is best effort: a node may not answer yet.
    await peer.handshake(options.timeoutMs || 3000).catch(() => null);
    this.peers.set(key, peer);
    this.emit('peer_connected', key, peer.nodeId);
    return peer;
  }

  /**
   * Shortcut for `"actorPath@host:port"` (or a bare path when exactly one peer
   * is connected), so call sites stay close to local code.
   * @returns {import('./remote').RemoteRef}
   */
  remote(spec) {
    const text = String(spec);
    const at = text.lastIndexOf('@');
    if (at < 0) {
      if (this.peers.size === 1) return [...this.peers.values()][0].ref(text);
      throw new ActorNotFoundError(
        `remote("${spec}") needs "path@host:port" when ${this.peers.size} peers are connected`,
      );
    }
    const path = text.slice(0, at);
    const target = text.slice(at + 1);
    const peer = this.peers.get(target) || [...this.peers.values()].find((p) => p.nodeId === target);
    if (!peer) throw new ActorNotFoundError(`no peer "${target}" is connected; call connect() first`);
    return peer.ref(path);
  }

  /** Connected peers, for introspection. */
  listPeers() {
    return [...this.peers.values()].map((peer) => ({ key: `${peer.host}:${peer.port}`, nodeId: peer.nodeId }));
  }

  // --- system-level supervision -------------------------------------------

  async _onRootCrash(cell, reason) {
    const decision = this.rootSupervisor.decide(cell.id);
    if (decision.action === 'escalate') {
      await this._onEscalation(cell, reason);
      return;
    }
    if (decision.action !== 'restart') return;
    for (const id of decision.targets) {
      const target = this.cells.get(id);
      if (!target) continue;
      try {
        await target._restart(reason);
      } catch (err) {
        await this._onRootCrash(target, err);
      }
    }
  }

  /**
   * A top-level actor (or its subtree) exhausted its restart intensity. There
   * is no parent left to escalate to, so the system reports the failure, stops
   * everything and emits `system_failure` — a silent give-up would hide a
   * permanent fault.
   */
  async _onEscalation(cell, reason) {    const error = reason instanceof EscalationError
      ? reason
      : new EscalationError(`actor ${cell ? cell.path : '(unknown)'} failed and could not be restarted`, {
        cause: reason,
      });
    this._log('system_failure', { path: cell && cell.path, err: error.message });
    this.emit('system_failure', error, cell && cell.ref);
    // Shut down asynchronously: this runs inside the failing actor's turn, and
    // awaiting its own stop here would deadlock (the stop envelope can only be
    // processed once the current turn returns).
    setImmediate(() => {
      this.stop().catch((err) => this._log('system_stop_failed', { err: err.message }));
    });
  }

  // --- bookkeeping ---------------------------------------------------------

  _register(cell) {
    // Paths are the unique address; a parent's local id is not globally unique,
    // so only paths are indexed (resolve() still accepts an unambiguous id).
    this.cells.set(cell.path, cell);
    this.emit('actor_registered', cell.ref);
  }

  _unregister(cell) {
    if (this.cells.get(cell.path) === cell) this.cells.delete(cell.path);
    this.emit('actor_stopped', cell.path);
  }

  _onMailboxRejected(cell, envelope) {
    this.emit('mailbox_full', cell.ref, envelope.payload);
  }

  _deadLetter(cell, envelope, err) {
    const entry = {
      ts: Date.now(),
      path: cell.path,
      payload: envelope.payload,
      retryCount: envelope.retryCount || 0,
      error: err && err.message,
    };
    this.deadLetters.push(entry);
    if (this.deadLetters.length > this.maxDeadLetters) this.deadLetters.shift();

    // Durable dead letters (deadLetters plugin): the in-memory ring stays a
    // fast view, the store is the durable record.
    if (this.deadLetterStore) {
      Promise.resolve(
        this.deadLetterStore.enqueue({ actorId: cell.path, msg: envelope.payload, reason: entry.error, retryCount: entry.retryCount }),
      ).catch((storeErr) => this._log('dead_letter_persist_failed', { err: storeErr.message }));
    }
    this._log('dead_letter', entry);
    this.emit('dead_letter', entry);
  }

  /** Dead letters: from the durable store when one is installed, else memory. */
  async readDeadLetters() {
    if (this.deadLetterStore && typeof this.deadLetterStore.readAll === 'function') {
      return this.deadLetterStore.readAll();
    }
    return [...this.deadLetters];
  }

  async clearDeadLetters() {
    this.deadLetters.length = 0;
    if (this.deadLetterStore && typeof this.deadLetterStore.clear === 'function') {
      await this.deadLetterStore.clear();
    }
  }

  _nextChildSeq() {
    this._seq += 1;
    return this._seq;
  }

  _log(event, meta) {
    if (this.logger) {
      try {
        this.logger(event, meta);
      } catch {
        /* a broken logger must never break an actor */
      }
    }
    this.emit('log', event, meta);
  }

  // --- shutdown ------------------------------------------------------------

  /** Stop every actor gracefully and wait for the scheduler to settle. */
  async stop() {
    if (this.stopped) {
      await this.scheduler.drain();
      return;
    }
    this.stopped = true;
    // Snapshot who is mid-handler *before* stopping: a forced termination
    // unregisters the cell, so it would be invisible afterwards.
    const wasBusy = [...this.cells.values()].filter((cell) => cell.running).map((cell) => cell.path);
    const cells = [...this.cells.values()].filter((cell) => !cell.parent);
    await Promise.all(cells.map((cell) => cell.stop().catch(() => {})));

    // Bounded: a handler that never resolves must not make shutdown hang.
    const drainResult = await this.scheduler.drain(this.shutdownTimeoutMs);
    if (drainResult.timedOut || wasBusy.length > 0) {
      this._log('system_stop_timeout', {
        timeoutMs: this.shutdownTimeoutMs,
        timedOut: drainResult.timedOut,
        busyActors: wasBusy,
        hint: 'these actors were still inside a handler; shutdown continued anyway',
      });
    }
    this.scheduler.stop();

    // Close the transports last: actors may still have been exchanging
    // messages while they drained.
    if (this.server) {
      await this.server.close().catch(() => {});
      this.server = null;
    }
    for (const peer of this.peers.values()) await peer.close().catch(() => {});
    this.peers.clear();

    // Plugins tear down in reverse install order.
    const installed = [...this.installed.values()].reverse();
    for (const plugin of installed) {
      if (typeof plugin.teardown !== 'function') continue;
      try {
        // `await` also covers synchronous teardown functions.
        await plugin.teardown(this);
      } catch (err) {
        this._log('plugin_teardown_failed', { plugin: plugin.name, err: err.message });
      }
    }
    this.installed.clear();
    this.emit('stopped');
  }

  /** Statistics for dashboards/metrics. */
  stats() {    let mailboxDepth = 0;
    let deadLettered = 0;
    for (const cell of this.cells.values()) {
      mailboxDepth += cell.mailbox.size;
      deadLettered += cell.counters.deadLettered;
    }
    return {
      name: this.name,
      actors: this.cells.size,
      mailboxDepth,
      deadLettered,
      deadLetters: this.deadLetters.length,
      scheduled: this.scheduler.pending,
      ticks: this.scheduler.ticks,
      uptimeMs: Date.now() - this.startedAt,
      rootSupervisor: this.rootSupervisor.info(),
      plugins: [...this.installed.keys()],
      peers: this.peers.size,
    };
  }
}

/**
 * Create an actor system.
 * @param {{name?:string, logger?:Function|false, defaults?:object,
 *          persistence?:object|string, persistenceDir?:string,
 *          mailboxStore?:object, messagesPerTurn?:number, cellsPerTurn?:number}} [options]
 */
function createSystem(options = {}) {
  return new ActorSystem(options);
}

module.exports = { ActorSystem, createSystem, DEFAULT_ACTOR_OPTIONS };
