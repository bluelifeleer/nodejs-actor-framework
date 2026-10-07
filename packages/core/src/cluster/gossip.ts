// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const EventEmitter = require('events');
const config = require('../config.ts');

/** 一轮 gossip 里最多携带多少个 peer 地址（避免大集群把单条消息撑爆）。 */
const MAX_PROPAGATED_PEERS = 64;
const tlsUtil = require('./tls-util.ts');
const proto = require('./proto.ts');
const { CODEC, codecFromName, createFraming } = require('./framing.ts');

/**
 * Gossip cluster membership + registry replication.
 *
 * Transport: length-prefixed binary frames, the same framing the gateway uses
 * (uint32 length + codec byte + body). The envelope is protobuf by default and
 * the replicated registry map travels as JSON bytes inside it, because its
 * values are heterogeneous (actor metadata and subscription sets). See
 * actor-proto.proto.
 *
 * Each round sends the local registry AND the receiver answers with its own
 * state, so both sides converge every round (anti-entropy).
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

const framing = createFraming({
  protoEncode: proto.encodeGossipEnvelope,
  protoDecode: proto.decodeGossipEnvelope,
});

/** 一条 registry 记录（LWW + nodeId 平局判定；删除用墓碑）。 */
interface RegistryEntry {
  key: string;
  value: unknown;
  ts: number;
  nodeId: string;
  deleted?: boolean;
}

/** 一个 peer 的地址与健康状态。 */
interface PeerInfo {
  host: string;
  port: number;
  lastSeen: number;
  failures: number;
}

/** gossip 配置（也可直接传 seeds 数组，兼容旧用法）。 */
interface GossipOptions {
  seeds?: (string | { host: string; port: number })[];
  host?: string;
  advertiseHost?: string;
  intervalMs?: number;
  peerTimeoutMs?: number;
  maxPayloadBytes?: number;
  maxFrameBytes?: number;
  tls?: unknown;
  codec?: number | string;
  /** 注册表条目上限（默认 10000）：注册表是整体复制的，无界 = 一条连接就能把内存灌满。 */
  maxRegistryEntries?: number;
  /** 对等地址表上限（默认 256）：gossip 会**真的去拨**学到的地址。 */
  maxPeers?: number;
  /** 允许的时钟偏移（默认 60s）：ts 超前本机超过它就拒绝（否则未来时间戳可以永久压住 LWW）。 */
  maxClockSkewMs?: number;
}

class Gossip extends EventEmitter {
  /** 注册表条目上限（审计 S2：注册表是整体复制的，无界 = 一条连接就能灌满内存）。 */
  readonly maxRegistryEntries: number;
  /** 对等地址表上限（审计 S2：gossip 会真的去拨学到的地址）。 */
  readonly maxPeers: number;
  /** 允许的时钟偏移（审计 S2）。 */
  readonly maxClockSkewMs: number;

  /**
   * @param nodeId 本节点 id
   * @param port 监听端口
   * @param options seed 数组（旧用法）或配置对象
   */
  constructor(nodeId: string, port?: number, options: GossipOptions | (string | { host: string; port: number })[] = {}) {
    super();
    const opts: GossipOptions = Array.isArray(options) ? { seeds: options } : options;
    options = opts;
    this.nodeId = nodeId || config.gossip.nodeId;
    this.port = port === undefined ? config.gossip.port : port;
    this.host = opts.host || config.gossip.host;
    this.advertiseHost = opts.advertiseHost || this.host;
    this.intervalMs = opts.intervalMs || config.gossip.intervalMs;
    this.peerTimeoutMs = opts.peerTimeoutMs || config.gossip.peerTimeoutMs;
    this.maxPayloadBytes = opts.maxPayloadBytes || config.gossip.maxPayloadBytes;
    this.tls = opts.tls || config.tls;
    // Accept either the numeric constant or its name ('proto'/'json'); a raw
    // string used to be written into the frame header as a corrupt codec byte.
    this.codec = typeof opts.codec === 'number'
      ? opts.codec
      : codecFromName(opts.codec || config.gossip.codec);
    // The registry map is trimmed to maxPayloadBytes, so allow for envelope framing overhead.
    this.maxFrameBytes = opts.maxFrameBytes || this.maxPayloadBytes + 64 * 1024;
    this.maxRegistryEntries = opts.maxRegistryEntries ?? 10000;
    this.maxPeers = opts.maxPeers ?? 256;
    this.maxClockSkewMs = opts.maxClockSkewMs ?? 60_000;

    /** key -> 记录（含墓碑）。 */
    this.localRegistry = new Map<string, RegistryEntry>();
    /** nodeId -> peer 地址与健康状态。 */
    this.peers = new Map<string, PeerInfo>();
    /** nodeId -> 最后一次听到它的时间。 */
    this.nodeLastSeen = new Map<string, number>([[this.nodeId, Date.now()]]);

    this.server = null;
    this.boundPort = null;
    this._timer = null;
    this._sockets = new Set();
    this.stopped = false;

    for (const seed of opts.seeds || config.gossip.seeds) this.addSeed(seed);
  }

  addSeed(seed: string | { host: string; port: number }): boolean {
    // 审计 S2：gossip 会**主动拨号**学到的地址；没有上限时对端每次换地址就能让本节点
    // 无限增长对等表（并向外连任意地址）。满了就拒绝新地址并如实记一条。
    if (this.peers.size >= this.maxPeers) {
      const known = this._describeSeed(seed);
      if (!this.peers.has(known)) {
        this.emit('peer_limit_reached', { limit: this.maxPeers });
        return false;
      }
    }
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
    const key = `${host}:${port}`;
    // Never clobber a known peer: replacing the entry would wipe lastSeen and
    // the failure count, so liveness would reset on every inbound round.
    if (this.peers.has(key)) return false;
    this.peers.set(key, { host, port, lastSeen: 0, failures: 0 });
    return true;
  }

  // --- registry API -------------------------------------------------------

  setLocal(key: string, value: unknown): void {
    this.localRegistry.set(key, { key, value, ts: Date.now(), nodeId: this.nodeId, deleted: false });
  }

  delLocal(key: string): void {
    this.localRegistry.set(key, { key, value: null, ts: Date.now(), nodeId: this.nodeId, deleted: true });
  }

  /** Local view (tombstones included) as a plain object. */
  /** "host:port" 形式的键（addSeed 与 peers 表都用它）。 */
  _describeSeed(seed: string | { host: string; port: number }): string {
    if (typeof seed === 'string') return seed;
    return `${String(seed.host)}:${Number(seed.port)}`;
  }

  exportState(): Record<string, RegistryEntry> {
    const out: Record<string, RegistryEntry> = {};
    let bytes = 2;
    // newest first, so trimming drops the least useful entries
    const entries = [...this.localRegistry.values()].sort((a, b) => b.ts - a.ts);
    for (const entry of entries) {
      // 审计 S12：`.length` 是 UTF-16 码元数，多字节值最多差 3 倍 → 预算是假的。
      const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
      if (bytes + size > this.maxPayloadBytes) {
        this.emit('state_truncated', this.localRegistry.size - Object.keys(out).length);
        break;
      }
      out[entry.key] = entry;
      bytes += size;
    }
    return out;
  }

  _isNewer(incoming: RegistryEntry, current: RegistryEntry): boolean {
    if (!current) return true;
    if (incoming.ts > current.ts) return true;
    if (incoming.ts < current.ts) return false;
    return String(incoming.nodeId) > String(current.nodeId); // deterministic tie-break
  }

  /** Last-write-wins merge. Emits registry_update / registry_delete. */
  mergeState(remoteEntries: Record<string, RegistryEntry> | null | undefined, senderNodeId?: string): string[] {
    const applied: string[] = [];
    if (remoteEntries === null || remoteEntries === undefined || typeof remoteEntries !== 'object') return applied;
    const now = Date.now();
    for (const [key, incoming] of Object.entries(remoteEntries)) {
      if (incoming === null || typeof incoming !== 'object' || incoming.key !== key) continue;
      // 审计 S2：value 形状、条目数上限、时间戳不能跑到未来。
      //
      // 这里只拒"确实无效"的值（undefined / 函数 / symbol）：注册表里**合法地**存在墓碑
      // （`deleted: true`，value 为 null）与**布尔值**（例如 `leaving:<nodeId>` 用 `true` 当标记）。
      // 我前两版分别把这两种拒掉了，各自打红一批集群测试——这是"校验写窄了"的代价。
      if (incoming.value === undefined || typeof incoming.value === 'function' || typeof incoming.value === 'symbol') continue;
      if (!Number.isFinite(incoming.ts) || (incoming.ts as number) > now + this.maxClockSkewMs) {
        this.emit('registry_rejected', { key, reason: 'timestamp_in_future' });
        continue;
      }
      const current = this.localRegistry.get(key);
      if (current === undefined && this.localRegistry.size >= this.maxRegistryEntries) {
        this.emit('registry_rejected', { key, reason: 'registry_full' });
        continue;
      }
      if (current !== undefined && !this._isNewer(incoming, current)) continue;
      this.localRegistry.set(key, incoming);
      applied.push(key);
      if (incoming.deleted) this.emit('registry_delete', key, incoming);
      else this.emit('registry_update', key, incoming.value, incoming);
    }
    if (senderNodeId) this.nodeLastSeen.set(senderNodeId, Date.now());
    return applied;
  }

  // --- networking ---------------------------------------------------------

  start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const server = tlsUtil.createServer(this.tls, (socket: import('node:net').Socket) => this._handleInbound(socket));
      this.server = server;
      server.on('error', (err: Error) => {
        // Never let a busy/forbidden port take down the whole process.
        this.emit('error', err);
        reject(err);
      });
      server.listen(this.port, this.host, () => {
        this.boundPort = server.address().port;
        this.port = this.boundPort;
        this._startTlsReloader();
        this._timer = setInterval(() => {
          // 先把过期成员剔出去，再开始这一轮：否则 nodeLastSeen 只增不减，
          // "成员视图"会永远包含早就死掉的节点（多数派判据、故障接管全都跟着错）。
          try {
            this.pruneStaleNodes();
          } catch (err) {
            this.emit('protocol_error', err);
          }
          this.gossipRound().catch(() => {});
        }, this.intervalMs);
        if (typeof this._timer.unref === 'function') this._timer.unref();
        this.emit('listening', this.boundPort);
        resolve(this.boundPort);
      });
    });
  }

  /** Refresh the secure context in place when certificates are rotated. */
  _startTlsReloader(): void {
    if (typeof this.server.setSecureContext !== 'function') return;
    this.reloader = tlsUtil.createReloader(this.tls, {
      onReload: (options: import('node:tls').SecureContextOptions) => {
        this.server.setSecureContext(options);
        this.emit('tls_reloaded');
      },
      onError: (err: Error) => this.emit('tls_reload_error', err),
    });
  }

  _handleInbound(socket: import('node:net').Socket): void {
    this._sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => this._sockets.delete(socket));
    const decoder = new framing.FrameDecoder(this.maxFrameBytes);
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.emit('protocol_error', err);
        socket.destroy();
        return;
      }
      for (const payload of frames) this._onGossipPayload(payload, socket);
    });
  }

  _write(socket: import('node:net').Socket, payload: Record<string, unknown>): void {
    if (socket.destroyed) return;
    try {
      socket.write(framing.encode(payload, this.codec), () => {});
    } catch (err) {
      this.emit('protocol_error', err);
    }
  }

  /**
   * When TLS is on, the declared sender must match the peer certificate CN,
   * so a valid certificate cannot be used to impersonate another node id.
   */
  _verifySender(socket: import('node:net').Socket, senderNodeId: unknown): boolean {
    const check = tlsUtil.verifyPeerNodeId(socket, senderNodeId, this.tls);
    if (!check.ok) {
      this.emit('auth_error', check.reason);
      socket.destroy();
      return false;
    }
    return true;
  }

  _onGossipPayload(payload: Record<string, unknown>, socket: import('node:net').Socket): void {
    const sender = typeof payload.sender === 'string' ? payload.sender : '';
    const advertiseHost = typeof payload.advertiseHost === 'string' ? payload.advertiseHost : '';
    const senderPort = Number(payload.port);
    const data = (payload.data ?? null) as Record<string, RegistryEntry> | null;
    const propagatedPeers = Array.isArray(payload.peers) ? (payload.peers as { host?: unknown; port?: unknown }[]) : null;
    if (!payload || payload.type !== 'gossip') return;
    if (sender === this.nodeId) return;
    if (!this._verifySender(socket, sender)) return;
    if (socket.remoteAddress) {
      this.nodeLastSeen.set(sender, Date.now());
      // Learn the sender as a dialable peer.
      this.addSeed({ host: advertiseHost || socket.remoteAddress.replace(/^::ffff:/, ''), port: senderPort });
    }
    // 以及"发送方认识的其它节点"：没有这一步，N>=3 时成员视图永远不收敛
    if (propagatedPeers !== null) {
      for (const peer of propagatedPeers.slice(0, MAX_PROPAGATED_PEERS)) {
        if (peer === null || typeof peer !== 'object' || typeof peer.host !== 'string') continue;
        this.addSeed({ host: peer.host, port: Number(peer.port) });
      }
    }
    this.mergeState(data, sender);
    this.emit('round', sender);
    // Answer with our own state so the dialer converges too.
    this._write(socket, this._payload());
  }

  /**
   * 一轮 gossip 的内容：注册表 + **已知的其它节点地址**。
   *
   * 带上 peer 列表是"发现"的关键：只学"发给我的人"，那么种在同一个节点上的 N 个节点
   * 会永远只认识种子（各自看到不同的成员集合）——一致性哈希算出的 owner 就各不相同。
   * 列表有上限，避免集群很大时把消息撑爆（gossip 是 O(N) 消息量的小集群方案）。
   */
  _payload(): Record<string, unknown> {
    return {
      type: 'gossip',
      sender: this.nodeId,
      advertiseHost: this.advertiseHost,
      port: this.boundPort || this.port,
      data: this.exportState(),
      peers: [...this.peers.values()].slice(0, MAX_PROPAGATED_PEERS).map((peer) => ({
        host: peer.host,
        port: peer.port,
      })),
    };
  }

  /** One anti-entropy round against a random peer（返回是否真的送达）。 */
  gossipRound(): Promise<boolean> {
    const peers = [...this.peers.values()];
    if (peers.length === 0) return Promise.resolve(false);
    const peer = peers[Math.floor(Math.random() * peers.length)];
    return this.pushTo(peer);
  }

  /** 推一轮状态给某个 peer；`false` = 连不上/超时（会累加 failures）。 */
  pushTo(peer: PeerInfo): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
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

      const decoder = new framing.FrameDecoder(this.maxFrameBytes);
      socket.on('error', () => finish(false));
      socket.on(readyEvent, () => {
        try {
          socket.write(framing.encode(this._payload(), this.codec));
        } catch {
          finish(false);
        }
      });
      socket.on('data', (chunk: Buffer) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch {
          finish(false);
          return;
        }
        for (const payload of frames) {
          this._onGossipPayload(payload, socket);
          if (payload && payload.sender) this.nodeLastSeen.set(payload.sender, Date.now());
        }
        if (frames.length > 0) finish(true);
      });
    });
  }

  /** Detect nodes that stopped gossiping and drop their registry entries. */
  pruneStaleNodes(now = Date.now()): string[] {
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

  _gcTombstones(now: number): void {
    for (const [key, entry] of [...this.localRegistry]) {
      if (entry.deleted && now - entry.ts > TOMBSTONE_TTL_MS) this.localRegistry.delete(key);
    }
  }

  info(): Record<string, unknown> {
    return {
      nodeId: this.nodeId,
      port: this.boundPort || this.port,
      peers: [...this.peers.values()].map((p) => ({ ...p })),
      nodes: [...this.nodeLastSeen.keys()],
      registrySize: this.localRegistry.size,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reloader) {
      this.reloader.stop();
      this.reloader = null;
    }
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }
}

module.exports = Gossip;
module.exports.Gossip = Gossip;
