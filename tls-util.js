'use strict';

const fs = require('fs');
const net = require('net');
const tls = require('tls');

/**
 * TLS helpers shared by the gateway and gossip transports.
 *
 * Mutual TLS is used: the server requests and verifies a client certificate
 * and the client verifies the server, both against the configured CA. On top
 * of that the declared `nodeId` can be bound to the peer certificate CN, so a
 * node with a valid certificate still cannot impersonate another node's id.
 */

const fileCache = new Map();

function readFileCached(filePath) {
  if (fileCache.has(filePath)) return fileCache.get(filePath);
  const data = fs.readFileSync(filePath);
  fileCache.set(filePath, data);
  return data;
}

function isEnabled(tlsConfig) {
  return Boolean(tlsConfig && tlsConfig.enabled);
}

/** Validate + load the configured key material, failing loudly. */
function loadMaterial(tlsConfig) {
  const missing = [];
  if (!tlsConfig.key) missing.push('ACTOR_TLS_KEY');
  if (!tlsConfig.cert) missing.push('ACTOR_TLS_CERT');
  if (!tlsConfig.ca) missing.push('ACTOR_TLS_CA');
  if (missing.length > 0) {
    throw new Error(`TLS is enabled but ${missing.join(', ')} is not set`);
  }
  const material = { key: null, cert: null, ca: null };
  for (const [field, envName] of [['key', 'ACTOR_TLS_KEY'], ['cert', 'ACTOR_TLS_CERT'], ['ca', 'ACTOR_TLS_CA']]) {
    const filePath = tlsConfig[field];
    try {
      material[field] = readFileCached(filePath);
    } catch (err) {
      throw new Error(`cannot read ${envName} (${filePath}): ${err.message}`);
    }
  }
  if (tlsConfig.passphrase) material.passphrase = tlsConfig.passphrase;
  return material;
}

function commonOptions(tlsConfig) {
  const material = loadMaterial(tlsConfig);
  return {
    key: material.key,
    cert: material.cert,
    ca: material.ca,
    passphrase: material.passphrase,
    minVersion: tlsConfig.minVersion || 'TLSv1.2',
  };
}

function serverOptions(tlsConfig) {
  return {
    ...commonOptions(tlsConfig),
    requestCert: tlsConfig.requestCert !== false,
    rejectUnauthorized: tlsConfig.rejectUnauthorized !== false,
  };
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
 * Check that the peer's certificate identity matches the nodeId it claims.
 * @returns {{ok:boolean, cn?:string|null, reason?:string, skipped?:boolean}}
 */
function verifyPeerNodeId(socket, declaredNodeId, tlsConfig) {
  if (!isEnabled(tlsConfig)) return { ok: true, skipped: true };
  if (tlsConfig.verifyNodeId === false) return { ok: true, skipped: true };
  const cn = peerCommonName(socket);
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

/** Test helper: forget cached certificate files. */
function clearCache() {
  fileCache.clear();
}

module.exports = {
  isEnabled,
  loadMaterial,
  serverOptions,
  clientOptions,
  createServer,
  connect,
  peerCommonName,
  verifyPeerNodeId,
  clearCache,
};
