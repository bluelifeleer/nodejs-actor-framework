// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

/**
 * TLS helpers shared by the gateway and gossip transports.
 *
 * Mutual TLS is used: the server requests and verifies a client certificate and
 * the client verifies the server, both against the configured CA bundle. On top
 * of that the declared `nodeId` can be bound to the peer certificate CN, so a
 * node with a valid certificate still cannot impersonate another node's id.
 *
 * Rotation and revocation:
 *  - `ca` and `crl` accept several files (comma-separated in the environment),
 *    which supports multi-CA trust during a CA migration; CRLs are handed to
 *    the TLS stack, so a revoked certificate fails the handshake.
 *  - `denyNodes` is a cheap CN denylist for revocations without CRL plumbing.
 *  - `createReloader` polls the key material and refreshes the listener's
 *    secure context in place, so certificates can be rotated without a restart
 *    and without dropping established connections.
 */

/** Accept a single path, a comma-separated string, or an array. */
function toList(value) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * Read a file, keyed by size+mtime so a rotated file is re-read instead of
 * being served from a stale cache.
 */
const fileCache = new Map();
function readFileCached(filePath) {
  let stamp = 'missing';
  try {
    const stat = fs.statSync(filePath);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    /* fall through: the read below reports the real error */
  }
  const key = `${filePath}:${stamp}`;
  if (fileCache.has(key)) return fileCache.get(key);
  const data = fs.readFileSync(filePath);
  // Keep the cache small: only the newest stamp per path matters.
  for (const existing of fileCache.keys()) {
    if (existing.startsWith(`${filePath}:`) && existing !== key) fileCache.delete(existing);
  }
  fileCache.set(key, data);
  return data;
}

function isEnabled(tlsConfig) {
  return Boolean(tlsConfig && tlsConfig.enabled);
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const PEM_CRL = /-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g;
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Reject unusable key material *before* it is installed.
 *
 * Without this a truncated or half-written rotation would be handed to
 * setSecureContext() and silently break every new connection; instead the
 * reload fails and the previous context keeps serving.
 */
function validatePem(data, label, filePath, kind) {
  const text = data.toString('utf8');
  if (kind === 'key') {
    if (!PEM_KEY.test(text)) throw new Error(`${label} (${filePath}) contains no private key`);
    return;
  }
  if (kind === 'crl') {
    if ((text.match(PEM_CRL) || []).length === 0) throw new Error(`${label} (${filePath}) contains no CRL`);
    return;
  }
  const blocks = text.match(PEM_CERT) || [];
  if (blocks.length === 0) throw new Error(`${label} (${filePath}) contains no certificate`);
  for (const block of blocks) {
    try {
      // eslint-disable-next-line no-new
      new crypto.X509Certificate(block);
    } catch (err) {
      throw new Error(`${label} (${filePath}) contains a malformed certificate: ${err.message}`);
    }
  }
}

function readBundle(paths, label, kind) {
  if (paths.length === 0) return null;
  const parts = [];
  for (const filePath of paths) {
    let data;
    try {
      data = readFileCached(filePath);
    } catch (err) {
      throw new Error(`cannot read ${label} (${filePath}): ${err.message}`);
    }
    validatePem(data, label, filePath, kind);
    parts.push(data);
  }
  // Node accepts a single PEM buffer containing several certificates/CRLs.
  return parts.length === 1 ? parts[0] : Buffer.concat(parts.map((p) => Buffer.concat([p, Buffer.from('\n')])));
}

/** Validate + load the configured key material, failing loudly. */
function loadMaterial(tlsConfig) {
  const keyPaths = toList(tlsConfig.key);
  const certPaths = toList(tlsConfig.cert);
  const caPaths = toList(tlsConfig.ca);
  const crlPaths = toList(tlsConfig.crl);

  const missing = [];
  if (keyPaths.length === 0) missing.push('ACTOR_TLS_KEY');
  if (certPaths.length === 0) missing.push('ACTOR_TLS_CERT');
  if (caPaths.length === 0) missing.push('ACTOR_TLS_CA');
  if (missing.length > 0) {
    throw new Error(`TLS is enabled but ${missing.join(', ')} is not set`);
  }

  const material = {
    key: readBundle(keyPaths, 'ACTOR_TLS_KEY', 'key'),
    cert: readBundle(certPaths, 'ACTOR_TLS_CERT', 'cert'),
    ca: readBundle(caPaths, 'ACTOR_TLS_CA', 'ca'),
  };
  if (crlPaths.length > 0) material.crl = readBundle(crlPaths, 'ACTOR_TLS_CRL', 'crl');
  if (tlsConfig.passphrase) material.passphrase = tlsConfig.passphrase;
  return material;
}

function commonOptions(tlsConfig) {
  const material = loadMaterial(tlsConfig);
  const options = {
    key: material.key,
    cert: material.cert,
    ca: material.ca,
    minVersion: tlsConfig.minVersion || 'TLSv1.2',
  };
  if (material.crl) options.crl = material.crl;
  if (material.passphrase) options.passphrase = material.passphrase;
  return options;
}

function serverOptions(tlsConfig) {
  const options = {
    ...commonOptions(tlsConfig),
    requestCert: tlsConfig.requestCert !== false,
    rejectUnauthorized: tlsConfig.rejectUnauthorized !== false,
  };
  // Validate the material as a *set* (the key must match the certificate).
  // Only done for servers, i.e. at startup and on rotation, never per client
  // connection.
  tls.createSecureContext(options);
  return options;
}

/** Options for a listening server. Identical to serverOptions, kept symmetric. */
function secureContextOptions(tlsConfig) {
  return serverOptions(tlsConfig);
}

function clientOptions(tlsConfig, host) {
  const options = {
    ...commonOptions(tlsConfig),
    rejectUnauthorized: tlsConfig.rejectUnauthorized !== false,
  };
  // SNI only makes sense for names, not for bare IP addresses.
  if (tlsConfig.serverName) options.servername = tlsConfig.serverName;
  else if (host && net.isIP(host) === 0) options.servername = host;
  return options;
}

/** Create a listening server (TLS or plain TCP) with one uniform signature. */
function createServer(tlsConfig, onConnection) {
  if (!isEnabled(tlsConfig)) return net.createServer(onConnection);
  const options = serverOptions(tlsConfig);
  return tls.createServer(options, (socket) => onConnection(socket));
}

/** Open a client connection (TLS or plain TCP) plus the event that means "ready". */
function connect(tlsConfig, { host, port }) {
  if (!isEnabled(tlsConfig)) {
    return { socket: net.createConnection({ host, port }), readyEvent: 'connect', secure: false };
  }
  const options = { ...clientOptions(tlsConfig, host), host, port };
  return { socket: tls.connect(options), readyEvent: 'secureConnect', secure: true };
}

/** The CN of the peer certificate, or null when there is none. */
function peerCommonName(socket) {
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
  let cert;
  try {
    cert = socket.getPeerCertificate();
  } catch {
    return null;
  }
  if (!cert || !cert.subject || !cert.subject.CN) return null;
  return String(cert.subject.CN);
}

/**
 * Check that the peer's certificate identity matches the nodeId it claims, and
 * that the identity is not on the denylist.
 * @returns {{ok:boolean, cn?:string|null, reason?:string, skipped?:boolean}}
 */
function verifyPeerNodeId(socket, declaredNodeId, tlsConfig) {
  if (!isEnabled(tlsConfig)) return { ok: true, skipped: true };

  // The denylist is a hard block: it must apply even when the CN binding is
  // relaxed for a rolling upgrade.
  const denied = toList(tlsConfig.denyNodes);
  if (denied.includes(String(declaredNodeId))) {
    return { ok: false, cn: null, reason: `nodeId "${declaredNodeId}" is on the denylist` };
  }

  const cn = peerCommonName(socket);
  if (denied.includes(String(cn))) {
    return { ok: false, cn, reason: `peer certificate CN "${cn}" is on the denylist` };
  }

  if (tlsConfig.verifyNodeId === false) return { ok: true, skipped: true, cn };

  if (!cn) return { ok: false, cn: null, reason: 'peer presented no certificate CN' };
  if (String(declaredNodeId) !== cn) {
    return {
      ok: false,
      cn,
      reason: `peer declared nodeId "${declaredNodeId}" but its certificate CN is "${cn}"`,
    };
  }
  return { ok: true, cn };
}

/** A stamp of every key-material file, used to detect rotation. */
function fileStamp(tlsConfig) {
  const paths = [
    ...toList(tlsConfig.key),
    ...toList(tlsConfig.cert),
    ...toList(tlsConfig.ca),
    ...toList(tlsConfig.crl),
  ];
  return paths
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${filePath}:missing`;
      }
    })
    .join('|');
}

/**
 * Watch the key material and hand a fresh secure context to the caller.
 *
 * A failed reload keeps the previous context serving (a half-written file must
 * not take the cluster down) and retries on the next tick.
 *
 * @param {object} tlsConfig
 * @param {{onReload:(options:object)=>void, onError?:(err:Error)=>void, intervalMs?:number}} handlers
 */
function createReloader(tlsConfig, handlers = {}) {
  if (!isEnabled(tlsConfig)) return null;
  const intervalMs = handlers.intervalMs === undefined ? tlsConfig.reloadMs : handlers.intervalMs;
  if (!intervalMs || intervalMs <= 0) return null;

  let last = fileStamp(tlsConfig);
  const timer = setInterval(() => {
    const current = fileStamp(tlsConfig);
    if (current === last) return;
    try {
      const options = secureContextOptions(tlsConfig);
      last = current; // only advance once the new material loaded cleanly
      handlers.onReload(options);
    } catch (err) {
      if (handlers.onError) handlers.onError(err);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    get stamp() {
      return last;
    },
    /** Force a reload now (tests, or an operator-triggered SIGHUP). */
    reloadNow() {
      const options = secureContextOptions(tlsConfig);
      last = fileStamp(tlsConfig);
      handlers.onReload(options);
      return options;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** Test helper: forget cached certificate files. */
function clearCache() {
  fileCache.clear();
}

module.exports = {
  isEnabled,
  toList,
  loadMaterial,
  serverOptions,
  secureContextOptions,
  clientOptions,
  createServer,
  connect,
  peerCommonName,
  verifyPeerNodeId,
  fileStamp,
  createReloader,
  clearCache,
};
