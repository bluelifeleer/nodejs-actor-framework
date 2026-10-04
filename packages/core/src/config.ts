'use strict';

/**
 * Central configuration.
 *
 * Everything is env-overridable so the same code can run as a single demo
 * process, as a cluster node, or inside the test suite (which points
 * ACTOR_DATA_DIR at a temp directory and uses ephemeral ports).
 *
 * NOTE: worker_threads inherit process.env, so actor-main.js and
 * the framework resolve the same configuration.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// 应用根目录：框架被安装到 node_modules 里时，__dirname 指向包内，
// 所以根目录必须来自"使用者"而不是"框架自己"。
const ROOT = process.env.ACTOR_APP_ROOT ? path.resolve(process.env.ACTOR_APP_ROOT) : process.cwd();

/** 允许调用方覆盖任意配置项（未给出的走环境变量 / 默认值）。 */
export interface ConfigOverrides {
  dataDir?: string;
  logDir?: string;
  nodeId?: string;
  gossipHost?: string;
  gossipPort?: number;
  advertiseHost?: string;
  seeds?: string[];
  gatewayHost?: string;
  gatewayPort?: number;
  bootActors?: string[];
  persistenceMode?: string;
  actorPersistenceDir?: string;
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === '') return []; // explicitly set to empty means "none"
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');

function build(overrides: ConfigOverrides = {}) {
  const dataDir = overrides.dataDir || readString('ACTOR_DATA_DIR', DEFAULT_DATA_DIR);
  const logDir = overrides.logDir || readString('ACTOR_LOG_DIR', dataDir);
  const gossipPort = overrides.gossipPort ?? readNumber('ACTOR_GOSSIP_PORT', 7200);

  const config = {
    root: ROOT,
    dataDir,
    logDir,

    // Identity of this node inside a gossip cluster.
    nodeId: overrides.nodeId || readString('ACTOR_NODE_ID', `${os.hostname()}-${gossipPort}`),

    // Actors spawned at startup (the README examples use player_001).
    bootActors: overrides.bootActors || readList('ACTOR_BOOT_ACTORS', ['player_001']),

    // --- framework node ---------------------------------------------------
    // Persistence for boot actors: none | snapshot | events | mailbox.
    persistenceMode: overrides.persistenceMode || readString('ACTOR_PERSISTENCE_MODE', 'none'),
    // Where snapshots/events live (the mailbox store has its own backend).
    actorPersistenceDir: overrides.actorPersistenceDir
      || readString('ACTOR_PERSISTENCE_DIR', path.join(dataDir, 'actors')),

    // --- actor defaults (mapped onto createSystem's per-actor options) -----
    actor: {
      maxMailboxSize: readNumber('ACTOR_MAX_MAILBOX', 1000),
      maxRetry: readNumber('ACTOR_MAX_RETRY', 3),
      retryBackoffMs: readNumber('ACTOR_RETRY_BACKOFF_MS', 50),
      maxRetryBackoffMs: readNumber('ACTOR_MAX_RETRY_BACKOFF_MS', 1000),
      requestTimeoutMs: readNumber('ACTOR_REQUEST_TIMEOUT_MS', 3000),
      tokenBucketCapacity: readNumber('ACTOR_BUCKET_CAPACITY', 100),
      tokenBucketRate: readNumber('ACTOR_BUCKET_RATE', 50),
      metricsFlushMs: readNumber('ACTOR_METRICS_FLUSH_MS', 200),
      shutdownTimeoutMs: readNumber('ACTOR_SHUTDOWN_TIMEOUT_MS', 2000),
    },

    // --- supervisor -------------------------------------------------------
    supervisor: {
      strategy: readString('ACTOR_SUP_STRATEGY', 'one_for_one'),
      maxRestarts: readNumber('ACTOR_SUP_MAX_RESTARTS', 3),
      withinSeconds: readNumber('ACTOR_SUP_WITHIN_SECONDS', 5),
    },

    // --- Telnet debug console --------------------------------------------
    telnet: {
      enabled: readBoolean('ACTOR_TELNET_ENABLED', true),
      // Loopback by default: the console can hot-replace actor code.
      host: readString('ACTOR_TELNET_HOST', '127.0.0.1'),
      port: readNumber('ACTOR_TELNET_PORT', 8080),
      token: readString('ACTOR_TELNET_TOKEN', ''),
      maxLineBytes: readNumber('ACTOR_TELNET_MAX_LINE', 64 * 1024),
      maxConnections: readNumber('ACTOR_TELNET_MAX_CONN', 8),
    },

    // --- cluster ----------------------------------------------------------
    gossip: {
      enabled: readBoolean('ACTOR_GOSSIP_ENABLED', true),
      nodeId: overrides.nodeId || readString('ACTOR_NODE_ID', `${os.hostname()}-${gossipPort}`),
      // Peers must be able to reach this address, not necessarily 127.0.0.1.
      host: overrides.gossipHost || readString('ACTOR_GOSSIP_HOST', '127.0.0.1'),
      port: gossipPort,
      advertiseHost: overrides.advertiseHost || readString('ACTOR_ADVERTISE_HOST', '127.0.0.1'),
      seeds: overrides.seeds || readList('ACTOR_GOSSIP_SEEDS', []),
      intervalMs: readNumber('ACTOR_GOSSIP_INTERVAL_MS', 1000),
      peerTimeoutMs: readNumber('ACTOR_GOSSIP_PEER_TIMEOUT_MS', 6000),
      maxPayloadBytes: readNumber('ACTOR_GOSSIP_MAX_PAYLOAD', 1024 * 1024),
      // Outbound frame codec; inbound frames of either codec are always accepted.
      codec: readString('ACTOR_GOSSIP_CODEC', 'proto'),
    },

    gateway: {
      enabled: readBoolean('ACTOR_GATEWAY_ENABLED', true),
      host: overrides.gatewayHost || readString('ACTOR_GATEWAY_HOST', '127.0.0.1'),
      port: overrides.gatewayPort ?? readNumber('ACTOR_GATEWAY_PORT', 9000),
      maxFrameBytes: readNumber('ACTOR_GATEWAY_MAX_FRAME', 8 * 1024 * 1024),
      connectTimeoutMs: readNumber('ACTOR_GATEWAY_CONNECT_TIMEOUT_MS', 2000),
      // Outbound frame codec. Inbound frames of either codec are always
      // accepted (the codec is carried in the frame header).
      codec: readString('ACTOR_GATEWAY_CODEC', 'proto'),
    },

    // Mutual TLS for the gateway and gossip transports. Certs are loaded from
    // disk; a misconfiguration disables the affected listener rather than
    // silently falling back to plaintext.
    tls: {
      enabled: readBoolean('ACTOR_TLS_ENABLED', false),
      key: readList('ACTOR_TLS_KEY', []),
      cert: readList('ACTOR_TLS_CERT', []),
      ca: readList('ACTOR_TLS_CA', []),
      // Optional CRL bundle(s); revoked certificates fail the handshake.
      crl: readList('ACTOR_TLS_CRL', []),
      // Cheap revocation without CRL plumbing: these node ids / CNs are refused.
      denyNodes: readList('ACTOR_TLS_DENY_NODES', []),
      passphrase: readString('ACTOR_TLS_PASSPHRASE', ''),
      serverName: readString('ACTOR_TLS_SERVER_NAME', ''),
      requestCert: readBoolean('ACTOR_TLS_REQUEST_CERT', true),
      rejectUnauthorized: readBoolean('ACTOR_TLS_REJECT_UNAUTHORIZED', true),
      // Bind the declared nodeId to the peer certificate CN.
      verifyNodeId: readBoolean('ACTOR_TLS_VERIFY_NODE_ID', true),
      minVersion: readString('ACTOR_TLS_MIN_VERSION', 'TLSv1.2'),
      // Poll interval for certificate rotation; 0 disables hot reload.
      reloadMs: readNumber('ACTOR_TLS_RELOAD_MS', 30000),
    },

    // Message persistence backend: file (default, dependency-free), memory
    // (tests only) or level (optional native LevelDB binding).
    store: {
      backend: readString('ACTOR_STORE', 'file'),
      levelPath: readString('ACTOR_STORE_LEVEL_PATH', ''),
      compactionThresholdBytes: readNumber('ACTOR_STORE_COMPACT_BYTES', 256 * 1024),
      maxFileBytes: readNumber('ACTOR_STORE_MAX_FILE_BYTES', 32 * 1024 * 1024),
    },

    // The framework has no runtime code-eval path (no `new Function`). The flag
    // is kept only so a legacy deployment gets a clear warning at startup
    // instead of silent surprise; the module-based replacement is
    // `isolation: 'worker'` + restart.
    hotReload: {
      enabled: readBoolean('ENABLE_HOT_RELOAD', false),
    },

    log: {
      sampleRate: readNumber('ACTOR_LOG_SAMPLE_RATE', 0.3),
      maxFieldChars: readNumber('ACTOR_LOG_MAX_FIELD', 2000),
    },

    // Prometheus / OpenTelemetry-collector scrape endpoint (opt-in).
    metrics: {
      exporter: {
        enabled: readBoolean('ACTOR_METRICS_ENABLED', false),
        host: readString('ACTOR_METRICS_HOST', '127.0.0.1'),
        port: readNumber('ACTOR_METRICS_PORT', 9464),
        path: readString('ACTOR_METRICS_PATH', '/metrics'),
      },
    },
  };

  return config;
}

/** Deep-ish merge of a partial override tree onto the env-derived base. */
function loadConfig(overrides: ConfigOverrides = {}) {
  const base: Record<string, any> = build(overrides);
  const merged: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      // Merge one level deep (and one more for things like metrics.exporter).
      // A shallow replace used to drop sibling defaults, so
      // `telnet: { port: 0 }` silently lost maxLineBytes/maxConnections.
      const nested: Record<string, any> = { ...(base[key] as Record<string, any>) };
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subValue && typeof subValue === 'object' && !Array.isArray(subValue)
          && nested[subKey] && typeof nested[subKey] === 'object') {
          nested[subKey] = { ...nested[subKey], ...subValue };
        } else {
          nested[subKey] = subValue;
        }
      }
      merged[key] = nested;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function ensureDirs(config: Record<string, any>): Record<string, any> {
  for (const dir of [config.dataDir, config.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return config;
}

const config = loadConfig();

module.exports = config;
module.exports.loadConfig = loadConfig;
module.exports.ensureDirs = ensureDirs;
module.exports.build = build;
