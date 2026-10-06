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

/** 配置里的证书材料（来自 env/config，字段都可选）。 */
interface TlsConfig {
  enabled?: boolean;
  key?: string | string[];
  cert?: string | string[];
  ca?: string | string[];
  crl?: string | string[];
  servername?: string;
  rejectUnauthorized?: boolean;
  denyNodes?: string | string[];
  verifyNodeId?: boolean;
  [key: string]: unknown;
}

/** Accept a single path, a comma-separated string, or an array. */
function toList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * Read a file, keyed by size+mtime so a rotated file is re-read instead of
 * being served from a stale cache.
 */
const fileCache = new Map<string, Buffer>();
function readFileCached(filePath: string): Buffer {
  let stamp = 'missing';
  try {
    const stat = fs.statSync(filePath);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    /* fall through: the read below reports the real error */
  }
  const key = `${filePath}:${stamp}`;
  const cached = fileCache.get(key);
  if (cached !== undefined) return cached;
  const data = fs.readFileSync(filePath);
  // Keep the cache small: only the newest stamp per path matters.
  for (const existing of fileCache.keys()) {
    if (existing.startsWith(`${filePath}:`) && existing !== key) fileCache.delete(existing);
  }
  fileCache.set(key, data);
  return data;
}

function isEnabled(tlsConfig: TlsConfig | null | undefined): boolean {
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
function validatePem(data: Buffer | string, label: string, filePath: string, kind: string): void {
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
      throw new Error(`${label} (${filePath}) contains a malformed certificate: ${(err instanceof Error ? err.message : String(err))}`);
    }
  }
}

/** 读一批 PEM 文件；多个文件会被拼成一个 Buffer（Node 接受单 Buffer 里放多张证书）。 */
function readBundle(paths: string[], label: string, kind: string): Buffer | null {
  if (paths.length === 0) return null;
  const parts: Buffer[] = [];
  for (const filePath of paths) {
    let data: Buffer;
    try {
      data = readFileCached(filePath);
    } catch (err) {
      throw new Error(`cannot read ${label} (${filePath}): ${(err instanceof Error ? err.message : String(err))}`);
    }
    validatePem(data, label, filePath, kind);
    parts.push(data);
  }
  // Node accepts a single PEM buffer containing several certificates/CRLs.
  const first = parts[0];
  if (parts.length === 1 && first !== undefined) return first;
  return Buffer.concat(parts.map((p) => Buffer.concat([p, Buffer.from('\n')])));
}

interface TlsMaterial {
  key: Buffer | null;
  cert: Buffer | null;
  ca: Buffer | null;
  crl?: Buffer | null;
  passphrase?: string;
}

/** Validate + load the configured key material, failing loudly. */
function loadMaterial(tlsConfig: TlsConfig | null | undefined): TlsMaterial {
  const cfg: TlsConfig = tlsConfig ?? {};
  const keyPaths = toList(cfg.key);
  const certPaths = toList(cfg.cert);
  const caPaths = toList(cfg.ca);
  const crlPaths = toList(cfg.crl);

  const missing = [];
  if (keyPaths.length === 0) missing.push('ACTOR_TLS_KEY');
  if (certPaths.length === 0) missing.push('ACTOR_TLS_CERT');
  if (caPaths.length === 0) missing.push('ACTOR_TLS_CA');
  if (missing.length > 0) {
    throw new Error(`TLS is enabled but ${missing.join(', ')} is not set`);
  }

  const material: TlsMaterial = {
    key: readBundle(keyPaths, 'ACTOR_TLS_KEY', 'key'),
    cert: readBundle(certPaths, 'ACTOR_TLS_CERT', 'cert'),
    ca: readBundle(caPaths, 'ACTOR_TLS_CA', 'ca'),
  };
  if (crlPaths.length > 0) material.crl = readBundle(crlPaths, 'ACTOR_TLS_CRL', 'crl');
  if (typeof cfg.passphrase === 'string') material.passphrase = cfg.passphrase;
  return material;
}

function commonOptions(tlsConfig: TlsConfig | null | undefined): Record<string, unknown> {
  const cfg: TlsConfig = tlsConfig ?? {};
  const material: TlsMaterial = loadMaterial(cfg);
  const options: Record<string, unknown> = {
    key: material.key,
    cert: material.cert,
    ca: material.ca,
    minVersion: typeof cfg.minVersion === 'string' ? cfg.minVersion : 'TLSv1.2',
  };
  if (material.crl) options.crl = material.crl;
  if (material.passphrase) options.passphrase = material.passphrase;
  return options;
}

function serverOptions(tlsConfig: TlsConfig | null | undefined): Record<string, unknown> {
  const cfg: TlsConfig = tlsConfig ?? {};
  const options = {
    ...commonOptions(cfg),
    requestCert: cfg.requestCert !== false,
    rejectUnauthorized: cfg.rejectUnauthorized !== false,
  };
  // Validate the material as a *set* (the key must match the certificate).
  // Only done for servers, i.e. at startup and on rotation, never per client
  // connection.
  tls.createSecureContext(options);
  return options;
}

/** Options for a listening server. Identical to serverOptions, kept symmetric. */
function secureContextOptions(tlsConfig: TlsConfig): import('node:tls').SecureContextOptions {
  return serverOptions(tlsConfig);
}

function clientOptions(tlsConfig: TlsConfig | null | undefined, host: string): Record<string, unknown> {
  const cfg: TlsConfig = tlsConfig ?? {};
  const options: Record<string, unknown> = {
    ...commonOptions(cfg),
    rejectUnauthorized: cfg.rejectUnauthorized !== false,
  };
  // SNI only makes sense for names, not for bare IP addresses.
  if (typeof cfg.serverName === 'string') options.servername = cfg.serverName;
  else if (host && net.isIP(host) === 0) options.servername = host;
  return options;
}

/** Create a listening server (TLS or plain TCP) with one uniform signature. */
function createServer(tlsConfig: TlsConfig | null | undefined, onConnection: (socket: import('node:net').Socket) => void): import('node:net').Server | import('node:tls').Server {
  if (!isEnabled(tlsConfig)) return net.createServer(onConnection);
  const options = serverOptions(tlsConfig);
  return tls.createServer(options as import('node:tls').TlsOptions, (socket: import('node:tls').TLSSocket) => onConnection(socket));
}

/** Open a client connection (TLS or plain TCP) plus the event that means "ready". */
function connect(
  tlsConfig: TlsConfig | null | undefined,
  { host, port }: { host: string; port: number },
): { socket: import('node:net').Socket; readyEvent: string; secure: boolean } {
  if (!isEnabled(tlsConfig)) {
    return { socket: net.createConnection({ host, port }), readyEvent: 'connect', secure: false };
  }
  const options = { ...clientOptions(tlsConfig, host), host, port };
  return { socket: tls.connect(options), readyEvent: 'secureConnect', secure: true };
}

/** The CN of the peer certificate, or null when there is none. */
function peerCommonName(socket: import('node:tls').TLSSocket): string | null {
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
function verifyPeerNodeId(socket: import('node:tls').TLSSocket, declaredNodeId: unknown, tlsConfig: TlsConfig): { ok: boolean; reason?: string; cn?: string | null; skipped?: boolean } {
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
function fileStamp(tlsConfig: TlsConfig | null | undefined): string {
  const cfg: TlsConfig = tlsConfig ?? {};
  const paths = [
    ...toList(cfg.key),
    ...toList(cfg.cert),
    ...toList(cfg.ca),
    ...toList(cfg.crl),
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
 * @param {object} cfg
 * @param {{onReload:(options:object)=>void, onError?:(err:Error)=>void, intervalMs?:number}} handlers
 */
/** 证书热更新的句柄。 */
interface TlsReloader {
  /** 已加载的那份材料的指纹（测试用来断言"真的重读了"）。 */
  readonly stamp: string;
  /** 立刻重读（测试，或运维发 SIGHUP）。 */
  reloadNow(): import('node:tls').SecureContextOptions;
  stop(): void;
}

function createReloader(
  tlsConfig: TlsConfig | null | undefined,
  handlers: { onReload?: (options: import('node:tls').SecureContextOptions) => void; onError?: (err: Error) => void; intervalMs?: number } = {},
): TlsReloader | null {
  if (!isEnabled(tlsConfig)) return null;
  const cfg: TlsConfig = tlsConfig ?? {};
  const intervalMs = handlers.intervalMs === undefined ? cfg.reloadMs : handlers.intervalMs;
  if (typeof intervalMs !== 'number' || intervalMs <= 0) return null;

  let last = fileStamp(cfg);
  const timer = setInterval(() => {
    const current = fileStamp(cfg);
    if (current === last) return;
    try {
      const options = secureContextOptions(cfg);
      last = current; // only advance once the new material loaded cleanly
      if (handlers.onReload) handlers.onReload(options);
    } catch (err) {
      if (handlers.onError) handlers.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    get stamp() {
      return last;
    },
    reloadNow() {
      const options = secureContextOptions(cfg);
      last = fileStamp(cfg);
      if (handlers.onReload) handlers.onReload(options);
      return options;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** Test helper: forget cached certificate files. */
function clearCache(): void {
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
