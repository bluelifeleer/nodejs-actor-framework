'use strict';

const EventEmitter = require('events');
const config = require('./config');
const tlsUtil = require('./tls-util');

/**
 * Gossip cluster membership + registry replication.
 *
 * Protocol: newline-delimited JSON over TCP. Each round sends the local
 * registry AND the sender answers with its own state, so both sides converge
 * every round (anti-entropy).
 *
 * Correctness properties that were missing before:
 *  - `peers` is actually populated, so rounds happen at all.
 *  - Entries are last-write-wins with a nodeId tie-break, and deletions are
 *    propagated as tombstones (previously a delete on one node could never
 *    reach another, and a stale value could overwrite a fresh one).
 *  - Nodes that stop gossiping are detected and their actors are pruned.
 *  - Every socket and the server itself have 'error' handlers, so an
 *    unreachable peer cannot crash the process.
 */

const TOMBSTONE_TTL_MS = 10 * 60 * 1000;

class Gossip extends EventEmitter {
  /**
   * @param {string} nodeId
   * @param {number} port
   * @param {Array|object} options seed array (legacy) or options object
   */
  constructor(nodeId, port, options = {}) {
    super();
    if (Array.isArray(options)) options = { seeds: options };
    this.nodeId = nodeId || config.gossip.nodeId;
    this.port = port === undefined ? config.gossip.port : port;
    this.host = options.host || config.gossip.host;
    this.advertiseHost = options.advertiseHost || this.host;
    this.intervalMs = options.intervalMs || config.gossip.intervalMs;
    this.peerTimeoutMs = options.peerTimeoutMs || config.gossip.peerTimeoutMs;
    this.maxPayloadBytes = options.maxPayloadBytes || config.gossip.maxPayloadBytes;
    this.tls = options.tls || config.tls;

    /** @type {Map<string, object>} key -> {key,value,ts,nodeId,deleted} */
    this.localRegistry = new Map();
    /** @type {Map<string, {host:string,port:number,lastSeen:number,failures:number}>} */
    this.peers = new Map();
    /** @type {Map<string, number>} nodeId -> last time we heard from it */
    this.nodeLastSeen = new Map([[this.nodeId, Date.now()]]);

    this.server = null;
    this.boundPort = null;
    this._timer = null;
    this._sockets = new Set();
    this.stopped = false;

    for (const seed of options.seeds || config.gossip.seeds) this.addSeed(seed);
  }

  addSeed(seed) {
    if (!seed) return false;
    let host;
    let port;
    if (typeof seed === 'string') {
      const [h, p] = seed.split(':');
      host = h;
      port = Number(p);
    } else {
      host = seed.host;
      port = Number(seed.port);
    }
    if (!host || !Number.isFinite(port)) return false;
    if (host === this.host && port === this.port) return false; // never dial ourselves
    this.peers.set(`${host}:${port}`, { host, port, lastSeen: 0, failures: 0 });
    return true;
  }

  // --- registry API -------------------------------------------------------

  setLocal(key, value) {
    this.localRegistry.set(key, { key, value, ts: Date.now(), nodeId: this.nodeId, deleted: false });
  }

  delLocal(key) {
    this.localRegistry.set(key, { key, value: null, ts: Date.now(), nodeId: this.nodeId, deleted: true });
  }

  /** Local view (tombstones included) as a plain object. */
  exportState() {
    const out = {};
    let bytes = 2;
    // newest first, so trimming drops the least useful entries
    const entries = [...this.localRegistry.values()].sort((a, b) => b.ts - a.ts);
    for (const entry of entries) {
      const size = JSON.stringify(entry).length + 1;
      if (bytes + size > this.maxPayloadBytes) {
        this.emit('state_truncated', this.localRegistry.size - Object.keys(out).length);
        break;
      }
      out[entry.key] = entry;
      bytes += size;
    }
    return out;
  }

  _isNewer(incoming, current) {
    if (!current) return true;
    if (incoming.ts > current.ts) return true;
    if (incoming.ts < current.ts) return false;
    return String(incoming.nodeId) > String(current.nodeId); // deterministic tie-break
  }

  /** Last-write-wins merge. Emits registry_update / registry_delete. */
  mergeState(remoteEntries, senderNodeId) {
    const applied = [];
    if (!remoteEntries || typeof remoteEntries !== 'object') return applied;
    for (const [key, incoming] of Object.entries(remoteEntries)) {
      if (!incoming || typeof incoming !== 'object' || incoming.key !== key) continue;
      const current = this.localRegistry.get(key);
      if (!this._isNewer(incoming, current)) continue;
      this.localRegistry.set(key, incoming);
      applied.push(key);
      if (incoming.deleted) this.emit('registry_delete', key, incoming);
      else this.emit('registry_update', key, incoming.value, incoming);
    }
    if (senderNodeId) this.nodeLastSeen.set(senderNodeId, Date.now());
    return applied;
  }

  // --- networking ---------------------------------------------------------

  start() {
    return new Promise((resolve, reject) => {
      const server = tlsUtil.createServer(this.tls, (socket) => this._handleInbound(socket));
      this.server = server;
      server.on('error', (err) => {
        // Never let a busy/forbidden port take down the whole process.
        this.emit('error', err);
        reject(err);
      });
      server.listen(this.port, this.host, () => {
        this.boundPort = server.address().port;
        this.port = this.boundPort;
        this._timer = setInterval(() => this.gossipRound().catch(() => {}), this.intervalMs);
        if (typeof this._timer.unref === 'function') this._timer.unref();
        this.emit('listening', this.boundPort);
        resolve(this.boundPort);
      });
    });
  }

  _handleInbound(socket) {
    this._sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => this._sockets.delete(socket));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > this.maxPayloadBytes * 2) {
        socket.destroy();
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        this._onGossipPayload(payload, socket);
      }
    });
  }

  /**
   * When TLS is on, the declared sender must match the peer certificate CN,
   * so a valid certificate cannot be used to impersonate another node id.
   */
  _verifySender(socket, senderNodeId) {
    const check = tlsUtil.verifyPeerNodeId(socket, senderNodeId, this.tls);
    if (!check.ok) {
      this.emit('auth_error', check.reason);
      socket.destroy();
      return false;
    }
    return true;
  }

  _onGossipPayload(payload, socket) {
    if (!payload || payload.type !== 'gossip') return;
    if (payload.sender === this.nodeId) return;
    if (!this._verifySender(socket, payload.sender)) return;
    if (socket.remoteAddress) {
      this.nodeLastSeen.set(payload.sender, Date.now());
      // Learn the sender as a dialable peer.
      this.addSeed({ host: payload.advertiseHost || socket.remoteAddress.replace(/^::ffff:/, ''), port: payload.port });
    }
    this.mergeState(payload.data, payload.sender);
    this.emit('round', payload.sender);
    // Answer with our own state so the dialer converges too.
    try {
      socket.write(`${JSON.stringify(this._payload())}\n`);
    } catch {
      /* peer vanished */
    }
  }

  _payload() {
    return {
      type: 'gossip',
      sender: this.nodeId,
      advertiseHost: this.advertiseHost,
      port: this.boundPort || this.port,
      data: this.exportState(),
    };
  }

  /** One anti-entropy round against a random peer. */
  gossipRound() {
    const peers = [...this.peers.values()];
    if (peers.length === 0) return Promise.resolve(false);
    const peer = peers[Math.floor(Math.random() * peers.length)];
    return this.pushTo(peer);
  }

  pushTo(peer) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        this._sockets.delete(socket);
        if (ok) {
          peer.lastSeen = Date.now();
          peer.failures = 0;
        } else {
          peer.failures += 1;
        }
        resolve(ok);
      };

      const { socket, readyEvent } = tlsUtil.connect(this.tls, { host: peer.host, port: peer.port });
      this._sockets.add(socket);
      const timer = setTimeout(() => finish(false), Math.max(1000, this.intervalMs));
      if (typeof timer.unref === 'function') timer.unref();

      socket.on('error', () => finish(false));
      socket.on(readyEvent, () => {
        try {
          socket.write(`${JSON.stringify(this._payload())}\n`);
        } catch {
          finish(false);
        }
      });
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        try {
          const payload = JSON.parse(buf.slice(0, idx));
          this._onGossipPayload(payload, socket);
          this.nodeLastSeen.set(peer.host ? payload.sender : payload.sender, Date.now());
        } catch {
          /* ignore malformed reply */
        }
        finish(true);
      });
    });
  }

  /** Detect nodes that stopped gossiping and drop their registry entries. */
  pruneStaleNodes(now = Date.now()) {
    const removed = [];
    for (const [nodeId, seen] of this.nodeLastSeen) {
      if (nodeId === this.nodeId) continue;
      if (now - seen <= this.peerTimeoutMs) continue;
      this.nodeLastSeen.delete(nodeId);
      for (const [key, entry] of [...this.localRegistry]) {
        if (entry.nodeId === nodeId) {
          this.localRegistry.delete(key);
          removed.push(key);
          this.emit('registry_delete', key, { ...entry, deleted: true, reason: 'node_timeout' });
        }
      }
      this.emit('node_timeout', nodeId);
    }
    for (const [addr, peer] of [...this.peers]) {
      if (peer.failures >= 3 && now - peer.lastSeen > this.peerTimeoutMs) {
        this.peers.delete(addr);
        this.emit('peer_dropped', addr);
      }
    }
    this._gcTombstones(now);
    return removed;
  }

  _gcTombstones(now) {
    for (const [key, entry] of [...this.localRegistry]) {
      if (entry.deleted && now - entry.ts > TOMBSTONE_TTL_MS) this.localRegistry.delete(key);
    }
  }

  info() {
    return {
      nodeId: this.nodeId,
      port: this.boundPort || this.port,
      peers: [...this.peers.values()].map((p) => ({ ...p })),
      nodes: [...this.nodeLastSeen.keys()],
      registrySize: this.localRegistry.size,
    };
  }

  async stop() {
    this.stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }
}

module.exports = Gossip;
module.exports.Gossip = Gossip;
