'use strict';

/**
 * Central configuration.
 *
 * Everything is env-overridable so the same code can run as a single demo
 * process, as a cluster node, or inside the test suite (which points
 * ACTOR_DATA_DIR at a temp directory and uses ephemeral ports).
 *
 * NOTE: worker_threads inherit process.env, so actor-main.js and
 * actor-worker.js resolve the same configuration.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;

function readString(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function readList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === '') return []; // explicitly set to empty means "none"
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');

function build(overrides = {}) {
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

    // How often remote registry entries from silent nodes are pruned.
    registryPruneMs: readNumber('ACTOR_REGISTRY_PRUNE_MS', 3000),

    // --- worker behaviour -------------------------------------------------
    actor: {
      maxMailboxSize: readNumber('ACTOR_MAX_MAILBOX', 1000),
      batchMaxSize: readNumber('ACTOR_BATCH_MAX', 5),
      batchTimeoutMs: readNumber('ACTOR_BATCH_TIMEOUT_MS', 200),
      maxRetry: readNumber('ACTOR_MAX_RETRY', 3),
      retryBackoffMs: readNumber('ACTOR_RETRY_BACKOFF_MS', 50),
      maxRetryBackoffMs: readNumber('ACTOR_MAX_RETRY_BACKOFF_MS', 1000),
      requestTimeoutMs: readNumber('ACTOR_REQUEST_TIMEOUT_MS', 3000),
      tokenBucketCapacity: readNumber('ACTOR_BUCKET_CAPACITY', 100),
      tokenBucketRate: readNumber('ACTOR_BUCKET_RATE', 50),
      metricsFlushMs: readNumber('ACTOR_METRICS_FLUSH_MS', 200),
      maxRecovered: readNumber('ACTOR_MAX_RECOVERED', 1000),
      shutdownTimeoutMs: readNumber('ACTOR_SHUTDOWN_TIMEOUT_MS', 2000),
    },

    // --- supervisor -------------------------------------------------------
    supervisor: {
      strategy: readString('ACTOR_SUP_STRATEGY', 'one_for_one'),
      maxRestarts: readNumber('ACTOR_SUP_MAX_RESTARTS', 3),
      withinSeconds: readNumber('ACTOR_SUP_WITHIN_SECONDS', 5),
      cooldownMs: readNumber('ACTOR_SUP_COOLDOWN_MS', 5000),
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
      key: readString('ACTOR_TLS_KEY', ''),
      cert: readString('ACTOR_TLS_CERT', ''),
      ca: readString('ACTOR_TLS_CA', ''),
      passphrase: readString('ACTOR_TLS_PASSPHRASE', ''),
      serverName: readString('ACTOR_TLS_SERVER_NAME', ''),
      requestCert: readBoolean('ACTOR_TLS_REQUEST_CERT', true),
      rejectUnauthorized: readBoolean('ACTOR_TLS_REJECT_UNAUTHORIZED', true),
      // Bind the declared nodeId to the peer certificate CN.
      verifyNodeId: readBoolean('ACTOR_TLS_VERIFY_NODE_ID', true),
      minVersion: readString('ACTOR_TLS_MIN_VERSION', 'TLSv1.2'),
    },

    // Message persistence backend: file (default, dependency-free), memory
    // (tests only) or level (optional native LevelDB binding).
    store: {
      backend: readString('ACTOR_STORE', 'file'),
      levelPath: readString('ACTOR_STORE_LEVEL_PATH', ''),
      compactionThresholdBytes: readNumber('ACTOR_STORE_COMPACT_BYTES', 256 * 1024),
      maxFileBytes: readNumber('ACTOR_STORE_MAX_FILE_BYTES', 32 * 1024 * 1024),
    },

    hotReload: {
      // Replacing actor code with `new Function` is remote code execution by
      // design, so it is opt-in.
      enabled: readBoolean('ENABLE_HOT_RELOAD', false),
      maxCodeBytes: readNumber('ACTOR_HOT_RELOAD_MAX_BYTES', 8 * 1024),
      // Optional: a reviewed JS file exporting handlers, loaded with require().
      modulePath: readString('ACTOR_HOT_RELOAD_MODULE', ''),
    },

    log: {
      sampleRate: readNumber('ACTOR_LOG_SAMPLE_RATE', 0.3),
      maxFieldChars: readNumber('ACTOR_LOG_MAX_FIELD', 2000),
    },
  };

  return config;
}

/** Deep-ish merge of a partial override tree onto the env-derived base. */
function loadConfig(overrides = {}) {
  const base = build(overrides);
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      merged[key] = { ...base[key], ...value };
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function ensureDirs(config) {
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
