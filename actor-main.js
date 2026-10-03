'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const { ensureDirs } = require('./config');
const Supervisor = require('./supervisor');
const { RestartStrategy } = require('./supervisor');
const registry = require('./registry');
const logger = require('./logger');
const DLQ = require('./dead-letter-queue');
const metrics = require('./metrics');
const Gossip = require('./gossip');
const PubSub = require('./pubsub');
const HotReloadManager = require('./hot-reload-manager');
const Gateway = require('./gateway');
const Trace = require('./trace');
const TelnetConsole = require('./telnet-console');
const { ACTOR_ID_RE } = require('./telnet-console');
const { validateStoreConfig } = require('./stores');
const msgStore = require('./message-store');

const WORKER_PATH = path.join(__dirname, 'actor-worker.js');
const DEFAULT_PRIORITY = 1;

function normalizePriority(value) {
  return value === 0 || value === 1 || value === 2 ? value : DEFAULT_PRIORITY;
}

/**
 * Owns the local worker threads and routes messages.
 *
 * Fixes over the previous implementation:
 *  - `worker.on('error')` is registered, so a worker that fails to load or
 *    throws can no longer take the whole main process down,
 *  - the worker path is resolved against __dirname, not process.cwd(),
 *  - unexpected worker exits are reported to the supervisor, which actually
 *    restarts them now,
 *  - in-flight requests for a dead actor are rejected immediately instead of
 *    hanging until their timeout,
 *  - `send()` supports remote actors through the TCP gateway.
 */
class ActorManager {
  constructor(options = {}) {
    this.config = options.config || config;
    this.registry = options.registry || registry;
    this.metrics = options.metrics || metrics;
    this.logger = options.logger || logger;
    this.supervisor = options.supervisor || null;
    this.gateway = options.gateway || null;
    this.requestTimeoutMs = this.config.actor.requestTimeoutMs;

    /** @type {Map<string, Worker>} */
    this.actors = new Map();
    /** @type {Map<string, object>} replyId -> pending request */
    this.replyMap = new Map();
    /** @type {Map<string, object>} ctlId -> pending control request */
    this.controlMap = new Map();
    /** Actors stopped on purpose: their exit must not trigger a restart. */
    this.intentional = new Set();
    /** @type {Map<string, Set<string>>} targetActorId -> watcherActorIds */
    this.monitors = new Map();
    this.closed = false;
  }

  // --- lifecycle -----------------------------------------------------------

  createActor(actorId) {
    if (this.closed) throw new Error('ActorManager is closed');
    const id = String(actorId ?? '');
    if (!ACTOR_ID_RE.test(id)) throw new Error(`invalid actorId "${actorId}" (expected [A-Za-z0-9._:-]{1,128})`);
    if (this.actors.has(id)) throw new Error(`actor ${id} already exists`);

    if (this.supervisor) {
      if (!this.supervisor.running && !this.supervisor.circuitOpen) this.supervisor.start();
      if (!this.supervisor.hasChild(id)) {
        this.supervisor.spawnChild(() => this._spawnWorker(id), id, {
          stopFn: (ref) => {
            this.intentional.add(id);
            if (ref && typeof ref.terminate === 'function') ref.terminate().catch(() => {});
          },
        });
        return id;
      }
    }
    this._spawnWorker(id);
    return id;
  }

  _spawnWorker(actorId) {
    const worker = new Worker(WORKER_PATH, {});
    const state = { lastError: null, exited: false };
    this.actors.set(actorId, worker);
    this.intentional.delete(actorId);

    worker.on('message', (msg) => this._onWorkerMessage(actorId, msg));

    // Without this listener an unhandled 'error' event terminates the process.
    worker.on('error', (err) => {
      state.lastError = err && err.message ? err.message : String(err);
      this.logger.logSystem('actor_worker_error', { actorId, err: state.lastError });
    });

    worker.on('exit', (code) => {
      if (state.exited) return;
      state.exited = true;
      this.actors.delete(actorId);
      const intentional = this.intentional.delete(actorId);
      this._rejectPendingForActor(actorId, new Error(`actor ${actorId} exited (code ${code})`));
      this.logger.logSystem('actor_exit', { actorId, code, intentional, err: state.lastError });

      // Monitors fire on every death, crash or intentional stop.
      this._notifyWatchers(actorId, intentional ? 'stopped' : 'crash');

      if (this.closed || intentional) {
        this.registry.unregister(actorId);
        // Withdraw from gossip too, otherwise peers keep advertising an actor
        // that no longer exists.
        if (typeof this.onActorRemoved === 'function') this.onActorRemoved(actorId);
        return;
      }
      if (this.supervisor) {
        const result = this.supervisor.handleChildCrash(actorId, { code, error: state.lastError });
        this.logger.logSystem('actor_restart_decision', { actorId, ...result });
        if (!result.restarted) this.registry.unregister(actorId);
      } else {
        this.registry.unregister(actorId);
      }
    });

    worker.postMessage({ type: 'init', actorId });
    this.metrics.initActor(actorId);
    this.logger.logSystem('actor_spawn', { actorId });
    return worker;
  }

  hasActor(actorId) {
    return this.actors.has(String(actorId));
  }

  listActors() {
    return [...this.actors.keys()];
  }

  /** Intentional stop: the supervisor will NOT restart the actor. */
  async destroyActor(actorId) {
    const id = String(actorId ?? '');
    const worker = this.actors.get(id);
    const supervised = this.supervisor ? this.supervisor.hasChild(id) : false;
    if (!worker && !supervised) return false;

    this.intentional.add(id);
    if (supervised) this.supervisor.removeChild(id); // stopFn terminates the worker
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* already gone */
      }
    }
    this.actors.delete(id);
    registry.unregister(id);
    return true;
  }

  /** Simulate a crash: the supervisor must restart the actor. */
  crashActor(actorId) {
    const id = String(actorId ?? '');
    const worker = this.actors.get(id);
    if (!worker) return false;
    this.intentional.delete(id);
    worker.terminate().catch(() => {});
    return true;
  }

  async restartActor(actorId) {
    const id = String(actorId ?? '');
    if (!this.actors.has(id)) return false;
    this.crashActor(id);
    return true;
  }

  // --- messaging -----------------------------------------------------------

  async send(actorId, payload, timeoutMs = this.requestTimeoutMs, priority = DEFAULT_PRIORITY, parentTraceCtx = null) {
    if (!payload || typeof payload !== 'object') throw new TypeError('send(actorId, payload): payload must be an object');
    const id = String(actorId ?? '');
    const trace = Trace.buildContext(parentTraceCtx);
    const prio = normalizePriority(priority);
    const worker = this.actors.get(id);

    if (worker) {
      return new Promise((resolve, reject) => {
        const replyId = crypto.randomUUID();
        const timer = setTimeout(() => {
          this.replyMap.delete(replyId);
          reject(new Error(`message ${replyId} to ${id} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        this.replyMap.set(replyId, { resolve, reject, timer, actorId: id });
        worker.postMessage({ ...payload, __replyId: replyId, priority: prio, trace });
      });
    }

    const meta = this.registry.find(id);
    if (meta && meta.type === 'remote') {
      if (!meta.host || !meta.gatewayPort) throw new Error(`actor ${id} is remote but has no reachable gateway address`);
      if (!this.gateway) throw new Error(`actor ${id} is remote but the gateway is disabled`);
      return this.gateway.deliver(meta.host, meta.gatewayPort, id, { ...stripInternal(payload), priority: prio, trace }, timeoutMs);
    }

    throw new Error(`actor ${id} not found`);
  }

  /**
   * Control channel: request/response against a worker outside the mailbox
   * (hot reload, monitors, stats, shutdown).
   */
  control(actorId, message, timeoutMs = this.requestTimeoutMs) {
    const id = String(actorId ?? '');
    const worker = this.actors.get(id);
    if (!worker) return Promise.reject(new Error(`actor ${id} not found`));
    return new Promise((resolve, reject) => {
      const ctlId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.controlMap.delete(ctlId);
        reject(new Error(`control "${message.type}" to ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.controlMap.set(ctlId, { resolve, reject, timer, actorId: id });
      worker.postMessage({ ...message, __ctl: true, __ctlId: ctlId });
    });
  }

  /** Watch an actor: the watcher receives monitor:notifyDead when it dies. */
  monitor(watcherActorId, targetActorId) {
    const watcher = String(watcherActorId);
    const target = String(targetActorId);
    if (watcher === target) return Promise.reject(new Error('an actor cannot monitor itself'));
    if (!this.monitors.has(target)) this.monitors.set(target, new Set());
    this.monitors.get(target).add(watcher);
    // Also register inside the worker so it shows up in `debug:stats`.
    return this.control(target, { type: 'monitor:watch', watcherActorId: watcher }).catch(() => this);
  }

  unmountMonitor(watcherActorId, targetActorId) {
    const watcher = String(watcherActorId);
    const target = String(targetActorId);
    if (this.monitors.has(target)) this.monitors.get(target).delete(watcher);
    return this.control(target, { type: 'monitor:unwatch', watcherActorId: watcher }).catch(() => this);
  }

  _notifyWatchers(deadActorId, reason) {
    const watchers = this.monitors.get(deadActorId);
    if (!watchers) return;
    this.monitors.delete(deadActorId);
    for (const watcherActorId of watchers) {
      this.send(watcherActorId, {
        type: 'monitor:notifyDead',
        deadActorId,
        reason,
      }).catch((err) => this.logger.logSystem('monitor_notify_failed', { watcherActorId, err: err.message }));
    }
  }

  /** Used by the gateway when a peer asks us to deliver to a local actor. */
  deliverLocal(targetActorId, payload, timeoutMs = this.requestTimeoutMs) {
    const id = String(targetActorId ?? '');
    // Only local delivery: never forward a peer's request back out, which
    // would let two nodes bounce a message between them.
    if (!this.actors.has(id)) throw new Error(`actor ${id} is not local to this node`);
    return this.send(id, payload, timeoutMs);
  }

  _onWorkerMessage(actorId, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'reply':
        this._settle(this.replyMap, msg.replyId, true, msg.data);
        break;
      case 'error':
        this._settle(this.replyMap, msg.replyId, false, new Error(msg.err));
        break;
      case 'mailbox_full':
        this._settle(this.replyMap, msg.replyId, false, new Error(msg.error));
        break;
      case 'ctl_reply':
        if (msg.ok) this._settle(this.controlMap, msg.ctlId, true, msg.data);
        else this._settle(this.controlMap, msg.ctlId, false, new Error(msg.error));
        break;
      case 'metrics':
        this.metrics.observe(msg.actorId || actorId, msg.delta);
        break;
      default:
        break;
    }
  }

  _settle(map, id, ok, value) {
    const entry = map.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    map.delete(id);
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }

  _rejectPendingForActor(actorId, err) {
    for (const [id, entry] of [...this.replyMap]) {
      if (entry.actorId !== actorId) continue;
      clearTimeout(entry.timer);
      this.replyMap.delete(id);
      entry.reject(err);
    }
    for (const [id, entry] of [...this.controlMap]) {
      if (entry.actorId !== actorId) continue;
      clearTimeout(entry.timer);
      this.controlMap.delete(id);
      entry.reject(err);
    }
  }

  stats() {
    return {
      actors: this.listActors(),
      pendingReplies: this.replyMap.size,
      pendingControls: this.controlMap.size,
      remote: this.registry.listAll().filter((e) => e.type === 'remote').map((e) => e.id),
    };
  }

  async close() {
    this.closed = true;
    for (const [actorId, worker] of [...this.actors]) {
      this.intentional.add(actorId);
      try {
        await this.control(actorId, { type: 'actor:shutdown' }, 300);
      } catch {
        /* fall through to terminate */
      }
      try {
        await worker.terminate();
      } catch {
        /* already gone */
      }
    }
    this.actors.clear();
    for (const entry of this.replyMap.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('ActorManager closed'));
    }
    this.replyMap.clear();
    for (const entry of this.controlMap.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('ActorManager closed'));
    }
    this.controlMap.clear();
  }
}

function stripInternal(payload) {
  const { __replyId, __msgId, ...rest } = payload;
  return rest;
}

/**
 * Start a full node: supervisor, gateway, gossip, pub/sub, hot reload, console.
 * Everything degrades gracefully: a busy port logs a warning instead of
 * killing the process.
 */
async function bootstrap(overrides = {}) {
  const cfg = config.loadConfig(overrides);
  ensureDirs(cfg);

  // Each node gets its own registry, so two nodes can be embedded in one
  // process (as the cluster tests do) without sharing discovery state.
  const nodeRegistry = overrides.registry || registry;

  const warnings = [];
  const warn = (msg, err) => {
    const text = `${msg}${err ? `: ${err.message}` : ''}`;
    warnings.push(text);
    logger.logSystem('warning', { msg, err: err && err.message });
    console.error(`[warn] ${text}`);
  };

  await DLQ.init();

  // Report persistence problems up front instead of failing inside a worker.
  const storeCheck = validateStoreConfig(cfg.store);
  if (!storeCheck.ok) warn(`store backend is not usable: ${storeCheck.reason}`);

  const supervisor = new Supervisor('root-sup', {
    strategy: cfg.supervisor.strategy || RestartStrategy.ONE_FOR_ONE,
    maxRestarts: cfg.supervisor.maxRestarts,
    withinSeconds: cfg.supervisor.withinSeconds,
    cooldownMs: cfg.supervisor.cooldownMs,
  });
  supervisor.start();

  const actorManager = new ActorManager({ config: cfg, supervisor, registry: nodeRegistry, metrics, logger });

  // --- gateway ------------------------------------------------------------
  const gateway = new Gateway({
    host: cfg.gateway.host,
    port: cfg.gateway.port,
    nodeId: cfg.nodeId,
    codec: cfg.gateway.codec,
    tls: cfg.tls,
    onDeliver: (targetActorId, payload, timeoutMs) =>
      actorManager.deliverLocal(targetActorId, payload, timeoutMs || cfg.actor.requestTimeoutMs),
  });
  gateway.on('error', (err) => warn('gateway error', err));
  gateway.on('auth_error', (reason) => {
    logger.logSystem('gateway_auth_error', { reason });
    console.error(`[security] gateway rejected a peer: ${reason}`);
  });

  let gatewayEnabled = false;
  if (cfg.gateway.enabled) {
    try {
      await gateway.listen();
      gatewayEnabled = true;
    } catch (err) {
      warn(`gateway could not listen on ${cfg.gateway.host}:${cfg.gateway.port}`, err);
    }
  }
  // The manager needs the live gateway to dispatch to remote actors.
  actorManager.gateway = gatewayEnabled ? gateway : null;

  // --- gossip -------------------------------------------------------------
  const gossip = new Gossip(cfg.nodeId, cfg.gossip.port, {
    host: cfg.gossip.host,
    advertiseHost: cfg.gossip.advertiseHost,
    seeds: cfg.gossip.seeds,
    intervalMs: cfg.gossip.intervalMs,
    peerTimeoutMs: cfg.gossip.peerTimeoutMs,
    tls: cfg.tls,
  });

  const localActorMeta = (actorId) => ({
    nodeId: cfg.nodeId,
    type: 'actor',
    actorId,
    host: cfg.gossip.advertiseHost,
    gatewayPort: gateway.boundPort || cfg.gateway.port,
  });

  gossip.on('registry_update', (key, value, entry) => {
    if (key.startsWith('subs:')) return; // handled by the PubSub bridge
    if (!value || value.type !== 'actor') return;
    nodeRegistry.set(key, {
      type: 'remote',
      nodeId: entry?.nodeId || value.nodeId,
      host: value.host,
      gatewayPort: value.gatewayPort,
      lastSeen: Date.now(),
    });
  });
  gossip.on('registry_delete', (key) => {
    if (key.startsWith('subs:')) return;
    const meta = nodeRegistry.find(key);
    if (meta && meta.type === 'remote') nodeRegistry.unregister(key);
  });
  gossip.on('node_timeout', (nodeId) => logger.logSystem('gossip_node_timeout', { nodeId }));
  // Remote entries must stay fresh while their node keeps gossiping. LWW only
  // emits registry_update when the *value* changes, so refreshing on the event
  // alone would let a perfectly healthy peer's actors expire.
  gossip.on('round', (senderNodeId) => nodeRegistry.touchNode(senderNodeId, Date.now()));
  gossip.on('auth_error', (reason) => {
    logger.logSystem('gossip_auth_error', { reason });
    console.error(`[security] gossip rejected a peer: ${reason}`);
  });

  let gossipEnabled = false;
  if (cfg.gossip.enabled) {
    try {
      await gossip.start();
      gossipEnabled = true;
    } catch (err) {
      warn(
        `gossip could not listen on ${cfg.gossip.host}:${cfg.gossip.port} ` +
          '(port 7000 is used by macOS AirPlay Receiver; pick another via ACTOR_GOSSIP_PORT)',
        err,
      );
      await gossip.stop().catch(() => {});
    }
  }

  // --- supervisor <-> registry wiring ------------------------------------
  const announce = (actorId) => {
    nodeRegistry.set(actorId, { nodeId: cfg.nodeId, type: 'actor' });
    if (gossipEnabled) gossip.setLocal(actorId, localActorMeta(actorId));
  };
  const withdraw = (actorId) => {
    nodeRegistry.unregister(actorId);
    if (gossipEnabled) gossip.delLocal(actorId);
  };
  actorManager.onActorRemoved = withdraw;

  supervisor.on('child_start', announce);
  supervisor.on('child_restart', (actorId) => {
    announce(actorId);
    logger.logSystem('actor_restarted', { actorId });
  });
  supervisor.on('child_crash', (actorId, info) => {
    logger.logSystem('actor_crashed', { actorId, ...info });
    withdraw(actorId);
  });
  supervisor.on('child_stop', withdraw);
  supervisor.on('supervisor_circuit_open', () => {
    logger.logSystem('supervisor_circuit_open', { supervisor: supervisor.id });
    for (const actorId of [...nodeRegistry.keys()]) {
      const meta = nodeRegistry.find(actorId);
      if (meta && meta.type === 'actor') withdraw(actorId);
    }
  });
  supervisor.on('supervisor_circuit_close', () => {
    logger.logSystem('supervisor_circuit_close', { supervisor: supervisor.id });
    for (const child of supervisor.children.values()) if (!child.stopped) announce(child.id);
  });

  // --- pub/sub ------------------------------------------------------------
  const pubsub = new PubSub({ actorManager, gossip: gossipEnabled ? gossip : null, nodeId: cfg.nodeId });

  // --- hot reload ---------------------------------------------------------
  const hotReload = new HotReloadManager(actorManager, {
    enabled: cfg.hotReload.enabled,
    maxCodeBytes: cfg.hotReload.maxCodeBytes,
    modulePath: cfg.hotReload.modulePath,
  });

  // --- boot actors --------------------------------------------------------
  for (const actorId of cfg.bootActors) {
    try {
      actorManager.createActor(actorId);
    } catch (err) {
      warn(`could not spawn boot actor ${actorId}`, err);
    }
  }

  // --- local actor monitor example + registry pruning ---------------------
  const pruneTimer = setInterval(() => {
    for (const key of nodeRegistry.pruneStale(cfg.gossip.peerTimeoutMs)) {
      if (gossipEnabled) gossip.delLocal(key);
    }
    if (gossipEnabled) gossip.pruneStaleNodes();
  }, cfg.registryPruneMs);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

  // --- console ------------------------------------------------------------
  const console_ = new TelnetConsole({
    host: cfg.telnet.host,
    port: cfg.telnet.port,
    token: cfg.telnet.token,
    maxLineBytes: cfg.telnet.maxLineBytes,
    maxConnections: cfg.telnet.maxConnections,
    context: {
      am: actorManager,
      supervisor,
      registry: nodeRegistry,
      dlq: DLQ,
      metrics,
      pubsub,
      gossip: gossipEnabled ? gossip : null,
      hotReload,
      gateway: gatewayEnabled ? gateway : null,
      logger,
    },
    logger,
  });

  let consoleEnabled = false;
  if (cfg.telnet.enabled) {
    try {
      await console_.listen();
      consoleEnabled = true;
    } catch (err) {
      warn(`console could not listen on ${cfg.telnet.host}:${cfg.telnet.port}`, err);
    }
  }

  const ctx = {
    config: cfg,
    warnings,
    actorManager,
    supervisor,
    registry: nodeRegistry,
    gossip: gossipEnabled ? gossip : null,
    pubsub,
    hotReload,
    gateway: gatewayEnabled ? gateway : null,
    console: consoleEnabled ? console_ : null,
    metrics,
    dlq: DLQ,
    logger,
    storeBackend: msgStore.backendName,
    ports: {
      console: consoleEnabled ? console_.boundPort : null,
      gateway: gatewayEnabled ? gateway.boundPort : null,
      gossip: gossipEnabled ? gossip.boundPort : null,
    },
    async close() {
      clearInterval(pruneTimer);
      if (consoleEnabled) await console_.close();
      if (gatewayEnabled) await gateway.close();
      if (gossipEnabled) await gossip.stop();
      supervisor.stop();
      await actorManager.close();
      await logger.flush();
    },
  };

  return ctx;
}

async function main() {
  const ctx = await bootstrap();
  logger.logSystem('bootstrap_complete', {
    nodeId: ctx.config.nodeId,
    actors: ctx.actorManager.listActors(),
    ports: ctx.ports,
    warnings: ctx.warnings,
  });
  console.log('Actor Framework bootstrap complete');
  console.log(`  node:    ${ctx.config.nodeId}`);
  console.log(`  actors:  ${ctx.actorManager.listActors().join(', ') || '(none)'}`);
  console.log(`  console: ${ctx.ports.console ? `telnet ${ctx.config.telnet.host}:${ctx.ports.console}` : 'disabled'}`);
  console.log(`  gateway: ${ctx.ports.gateway ? `${ctx.config.gateway.host}:${ctx.ports.gateway} (codec=${ctx.gateway.codecName})` : 'disabled'}`);
  console.log(`  gossip:  ${ctx.ports.gossip ? `${ctx.config.gossip.host}:${ctx.ports.gossip}` : 'disabled'}`);
  console.log(`  tls:     ${ctx.config.tls.enabled ? 'enabled (mutual)' : 'disabled'}`);
  console.log(`  store:   ${ctx.storeBackend}`);
  console.log(`  data:    ${ctx.config.dataDir}`);

  const shutdown = async (signal) => {
    console.log(`\n[${signal}] shutting down`);
    try {
      await ctx.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return ctx;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('bootstrap failed:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  ActorManager,
  bootstrap,
  main,
  WORKER_PATH,
  normalizePriority,
  stripInternal,
};
