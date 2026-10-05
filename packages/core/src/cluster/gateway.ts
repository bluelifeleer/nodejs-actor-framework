// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const config = require('../config.ts');
const proto = require('./proto.ts');
const tlsUtil = require('./tls-util.ts');
const { CODEC, CODEC_NAME, HEADER_BYTES, codecFromName, createFraming } = require('./framing.ts');

/**
 * Cross-node delivery gateway.
 *
 * Frame format (both directions):
 *
 *   uint32_be bodyLength | uint8 codec | body
 *
 * codec 0 = JSON (legacy-friendly, human readable)
 * codec 1 = Protocol Buffers (default; see proto.js / actor-proto.proto)
 *
 * The codec travels in the header, so a node always accepts both and mixed
 * peers interoperate without a negotiation round trip.
 *
 * Frame kinds:
 *   hello  { id, nodeId, codec }        -> hello
 *   ping   { id }                       -> pong { id, nodeId, ts }
 *   tell   { targetActorId, payload }    (fire and forget, no reply)
 *   deliver{ id, targetActorId, payload } -> result { id, ok, data|error }
 *   stop   { id, targetActorId }         -> result { id, ok }
 *
 * When TLS is enabled the connection is mutually authenticated and every peer
 * must complete `hello` before sending anything else, so the declared nodeId
 * can be bound to the certificate CN.
 */

const framing = createFraming({
  protoEncode: proto.encodeGatewayFrame,
  protoDecode: proto.decodeGatewayFrame,
});

function encodeFrame(obj, codec = CODEC.PROTOBUF) {
  return framing.encode(obj, codec);
}

function decodeFrame(codec, body) {
  return framing.decode(codec, body);
}

const FrameDecoder = framing.FrameDecoder;

class Gateway extends EventEmitter {
  /**
   * @param {{host?:string, port?:number, nodeId?:string, codec?:string|number,
   *          tls?:object, maxFrameBytes?:number, connectTimeoutMs?:number,
   *          onDeliver?: (targetActorId:string, payload:object, timeoutMs:number,
   *                       senderPath?:string, trace?:object) => Promise<any>}} options
   */
  constructor(options = {}) {
    super();
    this.host = options.host || config.gateway.host;
    this.port = options.port === undefined ? config.gateway.port : options.port;
    this.nodeId = options.nodeId || config.nodeId;
    this.onDeliver = options.onDeliver || (async () => {
      throw new Error('no deliver handler registered');
    });
    /** Fire-and-forget delivery; the result is intentionally not reported. */
    this.onTell = options.onTell || null;
    /** Stop an actor on this node. */
    this.onStop = options.onStop || null;
    this.maxFrameBytes = options.maxFrameBytes || config.gateway.maxFrameBytes;
    this.connectTimeoutMs = options.connectTimeoutMs || config.gateway.connectTimeoutMs;
    this.codec = typeof options.codec === 'number' ? options.codec : codecFromName(options.codec || config.gateway.codec);
    this.tls = options.tls || config.tls;
    // With TLS on, identity matters: no data before a verified hello.
    this.requireHello = tlsUtil.isEnabled(this.tls) && this.tls.verifyNodeId !== false;
    /**
     * fencing（M4 第 2b 步）：本节点声明自己支持 fencing，并在 hello 里带 `shardCount`。
     * 两个决策见 docs/design/m4-cluster-governance.md §3.4.4：
     *   - 默认**软升级**：对端不支持 fencing 时放行，但必须**可见**（`fencing_skipped` 事件）；
     *   - `requireFencing: true` 时切**硬门**：对端不支持就直接拒绝握手。
     */
    /**
     * 能力默认值**取决于我们是否真的能产出 token**：装了 `epochFor` 才声明 `fence`。
     * 反过来（声明支持却产不出 epoch）会让每条帧都变成"协议违规"——这是自己在说谎，
     * 会把滚动升级中的老配置一脚踢出集群（真实回归：unit-tls 的滚动升级用例）。
     */
    this.caps = options.caps === undefined ? (typeof options.epochFor === 'function' ? ['fence'] : []) : options.caps;
    this.shardCount = options.shardCount === undefined ? null : options.shardCount;
    this.requireFencing = options.requireFencing === true;
    /** 所有权判定钩子：网关不认识守卫，只把 (kind, target, epoch, peer) 交给它。 */
    this.verifyOwnership = options.verifyOwnership || null;
    /** 出站时"本节点认为目标 shard 是第几代"（没装守卫时返回 null，即不带字段）。 */
    this.epochFor = options.epochFor || null;
    /** 正在处理的入站请求数（离场排空时要用；不做按 shard 细分——那是保守但诚实的简化）。 */
    this._inflight = 0;

    this.server = null;
    this.boundPort = null;
    /** @type {Map<string, object>} addr -> pooled outbound connection */
    this.pool = new Map();
    /** @type {Set<import('net').Socket>} inbound sockets, tracked so close() can end */
    this.inbound = new Set();
    /** @type {WeakMap<object, {helloOk:boolean}>} per inbound connection state */
    this.inboundState = new WeakMap();
    this.closed = false;
  }

  get codecName() {
    return CODEC_NAME[this.codec];
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = tlsUtil.createServer(this.tls, (socket) => this._handleInbound(socket));
      this.server = server;
      server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });
      server.listen(this.port, this.host, () => {
        this.boundPort = server.address().port;
        this.port = this.boundPort;
        this._startTlsReloader();
        this.emit('listening', this.boundPort);
        resolve(this.boundPort);
      });
    });
  }

  /**
   * Refresh the listener's secure context when certificates are rotated.
   * Established connections keep their session; new ones use the new material.
   */
  _startTlsReloader() {
    if (typeof this.server.setSecureContext !== 'function') return;
    this.reloader = tlsUtil.createReloader(this.tls, {
      onReload: (options) => {
        this.server.setSecureContext(options);
        this.emit('tls_reloaded');
      },
      onError: (err) => this.emit('tls_reload_error', err),
    });
  }

  _handleInbound(socket) {
    socket.setNoDelay(true);
    this.inbound.add(socket);
    this.inboundState.set(socket, { helloOk: false });
    socket.on('close', () => this.inbound.delete(socket));
    const decoder = new FrameDecoder(this.maxFrameBytes);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.emit('protocol_error', err);
        socket.destroy();
        return;
      }
      for (const frame of frames) this._handleFrame(frame, socket);
    });
  }

  /** 在途入站请求数（drain 用它判断"排空了没有"）。 */
  inflight() {
    return this._inflight;
  }

  /** 出站帧上的 fencing 字段：拿不到 epoch 就**不写这个字段**（老节点会忽略它）。 */
  epochField(targetActorId) {
    if (typeof this.epochFor !== 'function') return {};
    const epoch = this.epochFor(targetActorId);
    return Number.isInteger(epoch) && epoch >= 1 ? { shardEpoch: epoch } : {};
  }

  _send(socket, obj) {
    if (socket.destroyed) return;
    try {
      socket.write(encodeFrame(obj, this.codec));
    } catch (err) {
      this.emit('protocol_error', err);
    }
  }

  /**
   * 握手检查（两个决策都在这里）：
   *   - D6：`shardCount` 两边都有且不一致 → **拒绝连接**（算错 shard 会静默放行/拒绝错误的帧）；
   *   - D5：`requireFencing` 时对端必须声明支持 fencing，否则拒绝握手。
   * 返回 `null` = 通过；返回字符串 = 拒绝原因。
   */
  _checkHandshake(frame) {
    const peerShardCount = Number.isInteger(frame.shardCount) ? frame.shardCount : null;
    if (peerShardCount !== null && this.shardCount !== null && peerShardCount !== this.shardCount) {
      return (
        `shardCount 不一致：对端 ${peerShardCount}，本节点 ${this.shardCount}` +
        '（两边会算出不同的 shard，fencing 判定就失去意义——请统一这个运维常量）'
      );
    }
    const peerCaps = Array.isArray(frame.caps) ? frame.caps : [];
    if (this.requireFencing && !peerCaps.includes('fence')) {
      return '本节点要求 fencing（requireFencing: true），但对端没有声明支持：拒绝连接';
    }
    return null;
  }

  /**
   * 所有权判定（返回 `null` = 通过）：
   *   - 对端**声明支持 fencing 却没有带 epoch** → 拒绝（协议违规，不是"老节点"）；
   *   - 对端不支持 fencing 且没带 epoch → 放行，但发 `fencing_skipped` 事件（**降级必须可见**）；
   *   - 带了 epoch → 交给 `verifyOwnership` 钩子判（旧 epoch 会被它拒掉）。
   */
  _checkOwnership(frame, state) {
    const epoch = Number.isInteger(frame.shardEpoch) ? frame.shardEpoch : null;
    const peerSupportsFencing = Array.isArray(state.peerCaps) && state.peerCaps.includes('fence');
    const info = {
      kind: frame.kind,
      targetActorId: frame.targetActorId || null,
      shardEpoch: epoch,
      peerNodeId: state.peerNodeId || null,
      peerSupportsFencing,
    };
    if (!this.verifyOwnership) {
      // 没装守卫：没有所有权信息可判。但"声明支持却带不出 token"仍然是自相矛盾，必须拒绝。
      if (epoch === null) {
        if (peerSupportsFencing) {
          return '对端声明支持 fencing，却没有在帧上带 shardEpoch：拒绝（协议违规）';
        }
        this.emit('fencing_skipped', { kind: info.kind, targetActorId: info.targetActorId, peerNodeId: info.peerNodeId });
      }
      return null;
    }
    const verdict = this.verifyOwnership(info);
    if (verdict && verdict.ok === false) return verdict.reason || '所有权判定拒绝';
    if (epoch === null && !peerSupportsFencing) {
      // 软升级：老节点照常工作，但**降级必须可见**
      this.emit('fencing_skipped', { kind: info.kind, targetActorId: info.targetActorId, peerNodeId: info.peerNodeId });
    }
    return null;
  }

  async _handleFrame(frame, socket) {
    if (!frame || typeof frame !== 'object') return;
    const state = this.inboundState.get(socket) || { helloOk: false };

    if (frame.kind === 'hello') {
      const check = tlsUtil.verifyPeerNodeId(socket, frame.nodeId, this.tls);
      if (!check.ok) {
        this.emit('auth_error', check.reason);
        socket.destroy();
        return;
      }
      const refuse = this._checkHandshake(frame);
      if (refuse !== null) {
        this.emit('handshake_rejected', refuse, { nodeId: frame.nodeId || null });
        socket.destroy();
        return;
      }
      state.helloOk = true;
      state.peerNodeId = frame.nodeId || null;
      state.peerCaps = Array.isArray(frame.caps) ? frame.caps : [];
      this.inboundState.set(socket, state);
      this._send(socket, {
        kind: 'hello',
        id: frame.id,
        nodeId: this.nodeId,
        codec: this.codecName,
        caps: this.caps,
        ...(this.shardCount === null ? {} : { shardCount: this.shardCount }),
      });
      return;
    }

    if (this.requireHello && !state.helloOk) {
      this.emit('auth_error', `peer sent "${frame.kind}" before completing the hello handshake`);
      socket.destroy();
      return;
    }

    if (frame.kind === 'ping') {
      this._send(socket, { kind: 'pong', id: frame.id, nodeId: this.nodeId, ts: Date.now() });
      return;
    }

    // fencing：跨节点的"改状态"动作（tell/stop/deliver）在派发之前先过所有权判定
    if (frame.kind === 'tell' || frame.kind === 'stop' || frame.kind === 'deliver') {
      const rejection = this._checkOwnership(frame, state);
      if (rejection !== null) {
        this.emit('ownership_rejected', rejection, {
          kind: frame.kind,
          targetActorId: frame.targetActorId || null,
          shardEpoch: frame.shardEpoch === undefined ? null : frame.shardEpoch,
          peerNodeId: state.peerNodeId || null,
        });
        // tell 没有回信通道（只记事件）；stop/deliver 有 id，回一个明确的错误
        if (frame.kind !== 'tell' && frame.id !== undefined) {
          this._send(socket, { kind: 'result', id: frame.id, ok: false, error: rejection });
        }
        return;
      }
    }

    if (frame.kind === 'tell') {
      if (!this.onTell) {
        this.emit('protocol_error', new Error('peer sent a tell but no handler is registered'));
        return;
      }
      this._inflight += 1;
      try {
        await this.onTell(frame.targetActorId, frame.payload, {
          senderPath: frame.senderPath || null,
          senderHost: frame.senderHost || null,
          senderPort: frame.senderPort || null,
          trace: frame.trace || null,
        });
      } catch (err) {
        // There is no reply channel: surface it locally instead of silently.
        this.emit('tell_error', err, frame.targetActorId);
      } finally {
        this._inflight -= 1;
      }
      return;
    }

    if (frame.kind === 'stop') {
      this._inflight += 1;
      try {
        if (!this.onStop) throw new Error('remote stop is not supported by this node');
        await this.onStop(frame.targetActorId);
        this._send(socket, { kind: 'result', id: frame.id, ok: true, data: null });
      } catch (err) {
        this._send(socket, {
          kind: 'result',
          id: frame.id,
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      } finally {
        this._inflight -= 1;
      }
      return;
    }

    if (frame.kind === 'deliver') {
      this._inflight += 1;
      try {
        const data = await this.onDeliver(frame.targetActorId, frame.payload, frame.timeoutMs, {
          senderPath: frame.senderPath || null,
          senderHost: frame.senderHost || null,
          senderPort: frame.senderPort || null,
          trace: frame.trace || null,
        });
        this._send(socket, { kind: 'result', id: frame.id, ok: true, data: data === undefined ? null : data });
      } catch (err) {
        this._send(socket, {
          kind: 'result',
          id: frame.id,
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      } finally {
        this._inflight -= 1;
      }
      return;
    }

    this._send(socket, { kind: 'error', id: frame.id, error: `unknown frame kind: ${frame.kind}` });
  }

  _connection(host, port) {
    const addr = `${host}:${port}`;
    const existing = this.pool.get(addr);
    if (existing && !existing.socket.destroyed) return existing;

    const conn = {
      host,
      port,
      socket: null,
      decoder: new FrameDecoder(this.maxFrameBytes),
      pending: new Map(),
      helloOk: false,
      ready: null,
    };

    const { socket, readyEvent } = tlsUtil.connect(this.tls, { host, port });
    conn.socket = socket;
    socket.setNoDelay(true);
    socket.on('error', (err) => this._failConnection(conn, err));
    socket.on('close', () => this._failConnection(conn, new Error('connection closed')));

    conn.ready = new Promise((resolve, reject) => {
      socket.once(readyEvent, () => {
        this.emit('connected', addr);
        // Announce ourselves first: the peer rejects data before hello.
        try {
          socket.write(
            encodeFrame(
              {
                kind: 'hello',
                nodeId: this.nodeId,
                codec: this.codecName,
                caps: this.caps,
                ...(this.shardCount === null ? {} : { shardCount: this.shardCount }),
              },
              this.codec,
            ),
          );
        } catch (err) {
          reject(err);
          return;
        }
        resolve();
      });
      socket.once('error', reject);
    });

    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = conn.decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) this._handleClientFrame(conn, frame);
    });

    this.pool.set(addr, conn);
    return conn;
  }

  _handleClientFrame(conn, frame) {
    if (frame && frame.kind === 'hello') {
      const check = tlsUtil.verifyPeerNodeId(conn.socket, frame.nodeId, this.tls);
      if (!check.ok) {
        this.emit('auth_error', check.reason);
        conn.socket.destroy();
        return;
      }
      // 发起方**也要**检查对端：shardCount 不一致（D6）与 requireFencing（D5）是双向规则，
      // 否则"我拒绝别人"却"被别人的不一致配置牵着走"。
      const refuse = this._checkHandshake(frame);
      if (refuse !== null) {
        this.emit('handshake_rejected', refuse, { nodeId: frame.nodeId || null, direction: 'outbound' });
        conn.socket.destroy();
        return;
      }
      conn.helloOk = true;
      conn.peerNodeId = frame.nodeId || null;
      conn.peerCaps = Array.isArray(frame.caps) ? frame.caps : [];
      this.emit('hello', conn.host, conn.port, frame.nodeId);
      return;
    }
    if (frame && frame.id && conn.pending.has(frame.id)) {
      const entry = conn.pending.get(frame.id);
      conn.pending.delete(frame.id);
      clearTimeout(entry.timer);
      entry.resolve(frame);
    }
  }

  _failConnection(conn, err) {
    for (const [, entry] of conn.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    conn.pending.clear();
    this.pool.delete(`${conn.host}:${conn.port}`);
  }

  /**
   * Write a frame without waiting for (or tracking) a response.
   * Used for remote `tell`, where the actor model does not want a reply.
   */
  send(host, port, frame) {
    if (this.closed) return false;
    const conn = this._connection(host, port);
    conn.ready
      .then(() => {
        if (conn.socket.destroyed) return;
        conn.socket.write(encodeFrame(frame, this.codec), () => {});
      })
      .catch((err) => this.emit('protocol_error', err));
    return true;
  }

  /** Send one request frame and await its response. */
  request(host, port, frame, timeoutMs = config.actor.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('gateway closed'));
      const conn = this._connection(host, port);
      const id = frame.id || crypto.randomUUID();
      const payload = { ...frame, id };

      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`gateway request ${id} to ${host}:${port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      conn.pending.set(id, { resolve, reject, timer });

      // Always write after the connection is ready, so our hello (written by
      // the ready handler) can never be reordered behind a request.
      conn.ready
        .then(() => {
          if (conn.socket.destroyed) throw new Error('connection closed');
          conn.socket.write(encodeFrame(payload, this.codec), (err) => {
            if (err) {
              conn.pending.delete(id);
              clearTimeout(timer);
              reject(err);
            }
          });
        })
        .catch((err) => {
          conn.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /** Convenience: deliver a payload to a remote actor and unwrap the result. */
  async deliver(host, port, targetActorId, payload, timeoutMs = config.actor.requestTimeoutMs, sender = {}) {
    const res = await this.request(
      host,
      port,
      {
        kind: 'deliver',
        targetActorId,
        payload,
        timeoutMs,
        senderPath: sender.path || null,
        senderHost: sender.host || null,
        senderPort: sender.port || null,
        trace: sender.trace || null,
        ...this.epochField(targetActorId),
      },
      timeoutMs + 500,
    );
    if (!res || res.kind !== 'result') throw new Error(`unexpected gateway response: ${JSON.stringify(res)}`);
    if (!res.ok) throw new Error(res.error || 'remote delivery failed');
    return res.data;
  }

  async ping(host, port, timeoutMs = config.gateway.connectTimeoutMs) {
    const res = await this.request(host, port, { kind: 'ping' }, timeoutMs);
    return res && res.kind === 'pong';
  }

  async close() {
    this.closed = true;
    if (this.reloader) {
      this.reloader.stop();
      this.reloader = null;
    }
    for (const conn of this.pool.values()) {
      this._failConnection(conn, new Error('gateway closing'));
      conn.socket.destroy();
    }
    this.pool.clear();
    // Inbound sockets must be destroyed too: server.close() only stops
    // accepting and otherwise waits for peers to hang up, which deadlocks two
    // gateways shutting each other down.
    for (const socket of this.inbound) socket.destroy();
    this.inbound.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }
}

module.exports = Gateway;
module.exports.Gateway = Gateway;
module.exports.encodeFrame = encodeFrame;
module.exports.decodeFrame = decodeFrame;
module.exports.FrameDecoder = FrameDecoder;
module.exports.CODEC = CODEC;
module.exports.codecFromName = codecFromName;
module.exports.HEADER_BYTES = HEADER_BYTES;
