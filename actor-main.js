import config from './packages/core/src/config.js';
import logger from './packages/core/src/obs/logger.js';
import msgStore from './packages/core/src/store/message-store.js';
import { createSystem, plugins, Actor } from 'nodejs-actor-framework';
import TelnetConsole from './packages/core/src/ops/telnet-console.js';
import _message_store from './packages/core/src/store/message-store.js';
const { validateStoreConfig } = _message_store;

/**
 * Demo / ops node, built on the framework.
 *
 *   node actor-main.js
 *
 * Everything here is *composition*: the Actor semantics live in `lib/`, the
 * optional capabilities live in `plugins/`, and this file only wires them to
 * configuration and adds a telnet console. If you are embedding the framework
 * in your own service you do not need this file — use `createSystem()` directly.
 *
 * Environment (see config.js for the full list):
 *   ACTOR_NODE_ID, ACTOR_TELNET_*, ACTOR_GATEWAY_*, ACTOR_GOSSIP_*,
 *   ACTOR_TLS_*, ACTOR_STORE_*, ACTOR_BOOT_ACTORS, ACTOR_PERSISTENCE_MODE
 */








/**
 * Built-in demo actor, so the documented console commands work out of the box.
 * Real deployments pass a module path instead (see `ACTOR_BOOT_MODULES`).
 */
class DemoActor extends Actor {
  preStart() {
    this.state = { hp: 100, hurtTotal: 0, handled: 0 };
  }

  async receive(msg, ctx) {
    this.state.handled += 1;
    switch (msg.type) {
      case 'hurt':
        this.state.hp -= msg.damage;
        this.state.hurtTotal += msg.damage;
        return this.state.hp;
      case 'debug:getState':
        return {
          ...this.state,
          path: ctx.path,
          restored: ctx.restored,
          isolation: 'inline',
          traceId: ctx.trace ? ctx.trace.traceId : null,
        };
      case 'debug:crash':
        throw new Error(`crash requested via console for ${ctx.path}`);
      default:
        return { ok: true, echo: msg };
    }
  }
}

/** Compose the plugin list from configuration. */
function buildPlugins(cfg) {
  const list = [];

  if (cfg.gossip.enabled) {
    list.push(plugins.cluster({
      nodeId: cfg.nodeId,
      host: cfg.gossip.host,
      port: cfg.gossip.port,
      advertiseHost: cfg.gossip.advertiseHost,
      seeds: cfg.gossip.seeds,
      intervalMs: cfg.gossip.intervalMs,
      peerTimeoutMs: cfg.gossip.peerTimeoutMs,
      tls: cfg.tls,
      codec: cfg.gossip.codec,
    }));
  }
  list.push(plugins.pubsub());

  if (cfg.actor.tracingEnabled !== false) list.push(plugins.tracing());

  if (cfg.metrics.exporter.enabled) {
    list.push(plugins.metrics({
      intervalMs: cfg.actor.metricsFlushMs,
      exporter: {
        enabled: true,
        host: cfg.metrics.exporter.host,
        port: cfg.metrics.exporter.port,
        path: cfg.metrics.exporter.path,
      },
      storeBackend: cfg.store.backend,
    }));
  }

  list.push(plugins.deadLetters());
  list.push(plugins.rateLimit({
    capacity: cfg.actor.tokenBucketCapacity,
    rate: cfg.actor.tokenBucketRate,
  }));

  return list;
}

/** Map config onto the framework's per-actor defaults. */
function actorDefaults(cfg) {
  return {
    mailbox: { maxSize: cfg.actor.maxMailboxSize },
    supervision: {
      strategy: cfg.supervisor.strategy,
      maxRestarts: cfg.supervisor.maxRestarts,
      withinSeconds: cfg.supervisor.withinSeconds,
    },
    askTimeoutMs: cfg.actor.requestTimeoutMs,
    maxRetry: cfg.actor.maxRetry,
    retryBackoffMs: cfg.actor.retryBackoffMs,
    maxRetryBackoffMs: cfg.actor.maxRetryBackoffMs,
  };
}

function persistenceFor(cfg, id) {
  const mode = cfg.persistenceMode;
  if (!mode || mode === 'none') return 'none';
  if (mode === 'events') return { mode: 'events' };
  if (mode === 'mailbox') return { mode: 'mailbox' };
  return { mode: 'snapshot' };
}

/**
 * Boot a node: system + plugins + optional gateway + console.
 *
 * @returns {Promise<object>} the node context (also what the console receives)
 */
async function bootstrap(overrides = {}) {
  const cfg = config.loadConfig(overrides);
  config.ensureDirs(cfg);

  const warnings = [];
  const warn = (msg, err) => {
    const text = `${msg}${err ? `: ${err.message}` : ''}`;
    warnings.push(text);
    logger.logSystem('warning', { msg, err: err && err.message });
    console.error(`[warn] ${text}`);
  };

  const storeCheck = validateStoreConfig(cfg.store);
  if (!storeCheck.ok) warn(`store backend is not usable: ${storeCheck.reason}`);

  // Hot reload: the old runtime compiled actor code at runtime. The framework
  // deliberately has no eval path; a module-isolated actor is restarted instead.
  if (cfg.hotReload.enabled) {
    warn('ENABLE_HOT_RELOAD is ignored: the framework has no runtime code eval. Use isolation: \'worker\' + restart');
  }

  const system = createSystem({
    name: cfg.nodeId,
    plugins: buildPlugins(cfg),
    defaults: actorDefaults(cfg),
    persistenceDir: cfg.actorPersistenceDir,
    mailboxStore: cfg.persistenceMode === 'mailbox' ? msgStore : null,
    shutdownTimeoutMs: cfg.actor.shutdownTimeoutMs,
  });

  system.on('system_failure', (err, ref) => warn(`actor failure${ref ? ` (${ref.path})` : ''}`, err));
  system.on('dead_letter', (entry) => logger.logSystem('dead_letter', entry));
  system.on('remote_tell_failed', (pathName, err) => warn(`remote tell to ${pathName} failed`, err));

  // --- gateway -------------------------------------------------------------
  let gatewayEnabled = false;
  let gatewayCodec = null;
  if (cfg.gateway.enabled) {
    try {
      await system.listen({
        host: cfg.gateway.host,
        port: cfg.gateway.port,
        tls: cfg.tls,
        codec: cfg.gateway.codec,
      });
      gatewayEnabled = true;
      gatewayCodec = system.server ? system.server.codecName : cfg.gateway.codec;
    } catch (err) {
      warn(`gateway could not listen on ${cfg.gateway.host}:${cfg.gateway.port}`, err);
    }
  }

  // --- plugins -------------------------------------------------------------
  // init() is where plugin setup (gossip, metrics exporter) happens; it is also
  // called lazily by spawn(), so a failure here is reported but not fatal.
  try {
    await system.init();
  } catch (err) {
    warn('plugin setup failed', err);
  }

  // --- boot actors ---------------------------------------------------------
  const booted = [];
  for (const actorId of cfg.bootActors) {
    try {
      await system.spawn(DemoActor, { id: actorId, persistence: persistenceFor(cfg, actorId) });
      booted.push(actorId);
    } catch (err) {
      warn(`boot actor "${actorId}" could not start`, err);
    }
  }

  // --- console -------------------------------------------------------------
  let console_ = null;
  if (cfg.telnet.enabled) {
    console_ = new TelnetConsole({
      host: cfg.telnet.host,
      port: cfg.telnet.port,
      token: cfg.telnet.token,
      maxLineBytes: cfg.telnet.maxLineBytes,
      maxConnections: cfg.telnet.maxConnections,
      // services come from the system; 默认 Actor 定义由应用注入（内核不依赖应用）
      context: { system, config: cfg, warnings, logger, defaultActorDefinition: DemoActor },
      logger,
    });
    try {
      await console_.listen();
    } catch (err) {
      warn(`console could not listen on ${cfg.telnet.host}:${cfg.telnet.port}`, err);
      console_ = null;
    }
  }

  const ctx = {
    // Framework-first surface.
    system,
    config: cfg,
    warnings,
    logger,
    console: console_,
    metrics: system.metrics || null,
    metricsExporter: system.metricsExporter || null,
    cluster: system.cluster || null,
    pubsub: system.pubsub || null,
    storeBackend: msgStore.backendName,
    gatewayCodec,
    booted,
    ports: {
      console: console_ ? console_.boundPort : null,
      gateway: gatewayEnabled && system.server ? system.server.boundPort : null,
      gossip: system.cluster ? system.cluster.port : null,
      metrics: system.metricsExporter ? system.metricsExporter.boundPort : null,
    },
    async close() {
      if (console_) await console_.close();
      await system.stop();
      await logger.flush();
    },
  };

  return ctx;
}

/** One-line summary per subsystem, for logs and `node actor-main.js`. */
function describe(ctx) {
  const lines = [
    `  node:    ${ctx.config.nodeId}`,
    `  actors:  ${ctx.system.listActors().join(', ') || '(none)'}`,
    `  console: ${ctx.ports.console ? `telnet ${ctx.config.telnet.host}:${ctx.ports.console}` : 'disabled'}`,
    `  gateway: ${ctx.ports.gateway ? `${ctx.config.gateway.host}:${ctx.ports.gateway} (codec=${ctx.gatewayCodec})` : 'disabled'}`,
    `  gossip:  ${ctx.ports.gossip ? `${ctx.config.gossip.host}:${ctx.ports.gossip}` : 'disabled'}`,
    `  tls:     ${ctx.config.tls.enabled ? 'enabled (mutual)' : 'disabled'}`,
    `  store:   ${ctx.storeBackend}${ctx.config.persistenceMode !== 'none' ? ` + actors:${ctx.config.persistenceMode}` : ''}`,
    `  plugins: ${[...ctx.system.installed.keys()].join(', ') || '(none)'}`,
    `  metrics: ${ctx.ports.metrics ? `http://${ctx.config.metrics.exporter.host}:${ctx.ports.metrics}${ctx.config.metrics.exporter.path}` : 'disabled'}`,
    `  data:    ${ctx.config.dataDir}`,
  ];
  if (ctx.warnings.length > 0) lines.push(`  warnings: ${ctx.warnings.length} (see above)`);
  return lines.join('\n');
}

async function main() {
  const ctx = await bootstrap();
  logger.logSystem('bootstrap_complete', {
    nodeId: ctx.config.nodeId,
    actors: ctx.system.listActors(),
    ports: ctx.ports,
    plugins: [...ctx.system.installed.keys()],
    warnings: ctx.warnings,
  });

  console.log('Actor framework node up (framework model + plugins)');
  console.log(describe(ctx));

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[${signal}] shutting down`);
    try {
      await ctx.close();
    } finally {
      process.exit(0);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
}

if (process.argv[1] === import.meta.filename) {
  main().catch((err) => {
    console.error('bootstrap failed:', err);
    process.exit(1);
  });
}

export { bootstrap, main, DemoActor, buildPlugins, actorDefaults, describe };
export default { bootstrap, main, DemoActor, buildPlugins, actorDefaults, describe };

