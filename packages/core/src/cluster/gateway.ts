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

/** 网关帧（两种编码都接受；字段由 proto/JSON 编解码负责）。 */
interface GatewayFrame {
  /** 帧类型（hello/ping/tell/deliver/stop/result/pong…）。 */
  kind: string;
  id?: string | undefined;
  nodeId?: string | undefined;
  targetActorId?: string | undefined;
  payload?: unknown;
  senderPath?: string | null | undefined;
  trace?: unknown;
  shardEpoch?: number | null | undefined;
  shardCount?: number | undefined;
  caps?: string[] | undefined;
  codec?: number | string | undefined;
  ts?: number | undefined;
  ok?: boolean | undefined;
  data?: unknown;
  error?: string | undefined;
  [key: string]: unknown;
}

/** 池化的出站连接。 */
interface OutboundConnection {
  readonly host: string;
  readonly port: number;
  /** 建立前为 null；`_connection()` 里赋值。 */
  socket: import('node:net').Socket | null;
  readonly decoder: InstanceType<typeof FrameDecoder>;
  readonly pending: Map<string, { resolve(value: unknown): void; reject(err: Error): void; timer: NodeJS.Timeout }>;
  helloOk: boolean;
  /** hello 之后记录的对端身份与能力（出站侧的 ownership 判定要用）。 */
  peerNodeId?: string | null;
  peerCaps?: string[];
  /** 握手完成的信号（`once(readyEvent)`）。 */
  ready: Promise<void> | null;
}

/** 入站连接的状态（hello 是否完成）。 */
interface InboundState {
  helloOk: boolean;
  /** hello 之后记录的对端身份与能力（用于入站 ownership 判定）。 */
  peerNodeId?: string | null;
  peerCaps?: string[];
}

interface GatewayOptions {
  host?: string;
  port?: number;
  nodeId?: string;
  codec?: string | number;
  tls?: Record<string, unknown>;
  maxFrameBytes?: number;
  connectTimeoutMs?: number;
  onDeliver?: (
    targetActorId: string,
    payload: unknown,
    timeoutMs: number,
    sender: { senderPath: string | null; senderHost: string | null; senderPort: number | null; trace: unknown },
  ) => Promise<unknown>;
  onTell?: ((
    targetActorId: string,
    payload: unknown,
    sender: { senderPath: string | null; senderHost: string | null; senderPort: number | null; trace: unknown },
  ) => void) | null;
  onStop?: ((targetActorId: string) => Promise<void> | void) | null;
  caps?: string[];
  shardCount?: number | null;
  requireFencing?: boolean;
  /** 所有权判定钩子：收一个 info 对象（见 _checkOwnership），返回是否放行。 */
  verifyOwnership?: ((info: {
    kind: string;
    targetActorId: string | null | undefined;
    shardEpoch: number | null | undefined;
    peerNodeId: string | null | undefined;
    peerSupportsFencing: boolean;
  }) => { ok: boolean; reason?: string } | null | undefined) | null;
  epochFor?: ((target: string) => number | null) | null;
  /** 在非回环地址上裸奔绑定的**显式**许可（默认拒绝，见 `assertSafeBinding`）。 */
  allowInsecureBinding?: boolean;
  /** 每个连接的在途入站请求上限（默认 1000）：超限即断开并记一条 `overloaded`。 */
  maxInflightPerConnection?: number;
  /** 入站连接数上限（默认 1024）：半开连接不能无限占 fd/内存。 */
  maxConnections?: number;
}

function encodeFrame(obj: GatewayFrame, codec: number = CODEC.PROTOBUF): Buffer {
  return framing.encode(obj, codec);
}

function decodeFrame(codec: number, body: Buffer): GatewayFrame {
  return framing.decode(codec, body);
}

const FrameDecoder = framing.FrameDecoder;

/** 入站帧必须带 targetActorId；缺失是协议违规（明确抛错，而不是把 undefined 传下去）。 */
function requireTarget(frame: GatewayFrame): string {
  if (typeof frame.targetActorId !== 'string' || frame.targetActorId === '') {
    throw new Error(`frame "${frame.kind}" is missing targetActorId`);
  }
  return frame.targetActorId;
}

class Gateway extends EventEmitter {
  readonly host: string;
  port: number;
  readonly nodeId: string;
  readonly onDeliver: GatewayOptions['onDeliver'];
  readonly onTell: GatewayOptions['onTell'];
  readonly onStop: GatewayOptions['onStop'];
  readonly maxFrameBytes: number;
  readonly connectTimeoutMs: number;
  readonly codec: number;
  readonly tls: Record<string, unknown>;
  readonly requireHello: boolean;
  readonly caps: string[];
  readonly shardCount: number | null;
  readonly requireFencing: boolean;
  verifyOwnership: GatewayOptions['verifyOwnership'];
  readonly allowInsecureBinding: boolean;
  readonly maxInflightPerConnection: number;
  readonly maxConnections: number;
  readonly epochFor: GatewayOptions['epochFor'];
  _inflight: number;
  server: import('node:net').Server | import('node:tls').Server | null;
  boundPort: number | null;
  /** "host:port" -> 池化连接。 */
  readonly pool: Map<string, OutboundConnection>;
  readonly inbound: Set<import('node:net').Socket>;
  readonly inboundState: WeakMap<import('node:net').Socket, InboundState>;
  closed: boolean;

  constructor(options: GatewayOptions = {}) {
    super();
    this.host = options.host || config.gateway.host;
    this.port = options.port === undefined ? config.gateway.port : options.port;
    this.nodeId = options.nodeId || config.nodeId;
    this.onDeliver =
      options.onDeliver ??
      (async () => {
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
    this.verifyOwnership = options.verifyOwnership ?? null;
    this.allowInsecureBinding = options.allowInsecureBinding === true;
    this.maxInflightPerConnection = options.maxInflightPerConnection ?? 1000;
    this.maxConnections = options.maxConnections ?? 1024;
    /** 出站时"本节点认为目标 shard 是第几代"（没装守卫时返回 null，即不带字段）。 */
    this.epochFor = options.epochFor ?? null;
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
    /** 每个入站 socket 的在途请求数（`maxInflightPerConnection` 的语义靠它）。 */
    this.inboundInflight = new WeakMap();
    this.closed = false;
  }

  get codecName(): string | undefined {
    return CODEC_NAME[this.codec];
  }

  /**
   * 审计 S1/S7：**默认零认证**的绑定必须被拦住，而不是靠"使用者自己会配 TLS"。
   *
   * 三条规则：
   *   1. 非回环 + 未启用 TLS → 拒绝启动（除非显式 `allowInsecureBinding: true`）；
   *   2. TLS 开着但 `requestCert === false` **且** `verifyNodeId === false` → 拒绝启动
   *      （两个开关一起关掉 = TLS 开着却零客户端认证，是很容易配出来的假安全）；
   *   3. 只配了 `verifyNodeId: false`（滚动升级场景）→ 放行但**大声记一条**日志（降级可见）。
   *
   * 与 `ops/telnet-console.ts` 的 `assertSafeBinding` 同一套语义——同类服务行为要一致。
   */
  assertSafeBinding(): void {
    const host = this.host;
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
    const tlsEnabled = tlsUtil.isEnabled(this.tls);
    if (!loopback && !tlsEnabled && !this.allowInsecureBinding) {
      throw new Error(
        `refusing to bind the actor gateway on ${host} without TLS: every peer on that network could ` +
          'tell/deliver/stop your actors. Enable TLS (ACTOR_TLS_ENABLED=1) or pass ' +
          'allowInsecureBinding: true if you really mean it.',
      );
    }
    if (tlsEnabled && (this.tls as { requestCert?: unknown }).requestCert === false && (this.tls as { verifyNodeId?: unknown }).verifyNodeId === false) {
      throw new Error(
        'refusing to start: TLS with requestCert=false AND verifyNodeId=false accepts any client without a ' +
          'certificate (zero client authentication). Drop one of the two switches.',
      );
    }
    if (tlsEnabled && (this.tls as { verifyNodeId?: unknown }).verifyNodeId === false) {
      this._logSafe('tls_node_id_verification_disabled', {
        hint: 'verifyNodeId=false：持有任一合法证书的对端可以冒充其它 nodeId（只应在滚动升级窗口内使用）',
      });
    }
  }

  /**
   * 发事件但**绝不让监听器把内核拖下水**（审计：Gateway 的 `emit('error')` 在无监听者时会抛
   * `ERR_UNHANDLED_ERROR`，而抛点在 net server 的 error 回调里 → `reject(err)` 永远不执行、
   * 进程还可能直接退出）。
   */
  _logSafe(event: string, meta?: Record<string, unknown>): void {
    for (const listener of this.listeners('log')) {
      try {
        (listener as (e: string, m?: Record<string, unknown>) => void)(event, meta);
      } catch {
        /* 监听器坏了不能影响内核 */
      }
    }
  }

  /** 安全发事件：有监听者才发，且吞掉监听器的异常。 */
  _safeEmit(event: string, ...args: unknown[]): void {
    const listeners = this.listeners(event);
    if (listeners.length === 0) {
      if (event === 'error') {
        // 没有监听者的 error 事件：记一条（如果装了 log 监听），但绝不抛
        this._logSafe('gateway_error_unhandled', { err: args[0] instanceof Error ? args[0].message : String(args[0]) });
      }
      return;
    }
    for (const listener of listeners) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        this._logSafe('gateway_listener_failed', { event, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  listen(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      try {
        this.assertSafeBinding();
      } catch (err) {
        reject(err);
        return;
      }
      const server = tlsUtil.createServer(this.tls, (socket: import('node:net').Socket) => this._handleInbound(socket));
      this.server = server;
      server.on('error', (err: Error) => {
        this._safeEmit('error', err);
        reject(err);
      });
      server.listen(this.port, this.host, () => {
        const address = server.address();
        const port = address !== null && typeof address === 'object' ? address.port : this.port;
        this.boundPort = port;
        this.port = port;
        this._startTlsReloader();
        this.emit('listening', port);
        resolve(port);
      });
    });
  }

  /**
   * Refresh the listener's secure context when certificates are rotated.
   * Established connections keep their session; new ones use the new material.
   */
  _startTlsReloader(): void {
    const server = this.server as { setSecureContext?(options: import('node:tls').SecureContextOptions): void } | null;
    if (server === null || typeof server.setSecureContext !== 'function') return;
    this.reloader = tlsUtil.createReloader(this.tls, {
      onReload: (options: import('node:tls').SecureContextOptions) => {
        server.setSecureContext?.(options);
        this.emit('tls_reloaded');
      },
      onError: (err: Error) => this.emit('tls_reload_error', err),
    });
  }

  _handleInbound(socket: import('node:net').Socket): void {
    if (this.inbound.size >= this.maxConnections) {
      this._logSafe('gateway_connection_limit', { limit: this.maxConnections });
      this._safeEmit('connection_rejected', { limit: this.maxConnections });
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    this.inbound.add(socket);
    this.inboundState.set(socket, { helloOk: false });
    socket.on('close', () => this.inbound.delete(socket));
    const decoder = new FrameDecoder(this.maxFrameBytes);
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      let frames: GatewayFrame[];
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
  inflight(): number {
    return this._inflight;
  }

  /** 出站帧上的 fencing 字段：拿不到 epoch 就**不写这个字段**（老节点会忽略它）。 */
  epochField(targetActorId: string): { shardEpoch?: number } {
    if (typeof this.epochFor !== 'function') return {};
    const epoch = this.epochFor(targetActorId);
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) return {};
    return { shardEpoch: epoch };
  }

  _send(socket: import('node:net').Socket, obj: GatewayFrame): void {
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
  _checkHandshake(frame: GatewayFrame): string | null {
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
  _checkOwnership(frame: GatewayFrame, state: InboundState): string | null {
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
    const verdict = this.verifyOwnership?.(info);
    if (verdict && verdict.ok === false) return verdict.reason || '所有权判定拒绝';
    if (epoch === null && !peerSupportsFencing) {
      // 软升级：老节点照常工作，但**降级必须可见**
      this.emit('fencing_skipped', { kind: info.kind, targetActorId: info.targetActorId, peerNodeId: info.peerNodeId });
    }
    return null;
  }

  _beginInbound(socket: import('node:net').Socket): void {
    this._inflight += 1;
    this.inboundInflight.set(socket, (this.inboundInflight.get(socket) ?? 0) + 1);
  }

  _endInbound(socket: import('node:net').Socket): void {
    this._inflight -= 1;
    const next = (this.inboundInflight.get(socket) ?? 1) - 1;
    if (next <= 0) this.inboundInflight.delete(socket);
    else this.inboundInflight.set(socket, next);
  }

  async _handleFrame(frame: GatewayFrame, socket: import('node:net').Socket): Promise<void> {
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
      state.peerNodeId = frame.nodeId ?? null;
      state.peerCaps = Array.isArray(frame.caps) ? frame.caps : [];
      this.inboundState.set(socket, state);
      this._send(socket, {
        kind: 'hello',
        id: frame.id,
        nodeId: this.nodeId,
        codec: this.codecName ?? String(this.codec),
        caps: this.caps,
        ...(this.shardCount === null ? {} : { shardCount: this.shardCount }),
      });
      return;
    }

    /**
     * 审计 S4：单连接可以堆积无限在途请求 —— 一条连接就能让节点同时处理任意多 handler
     * （每份 payload 最大 maxFrameBytes），而且 `inflight()` 是集群优雅离场判断"排空了没有"的依据，
     * 无界在途会让 drain 永远等不到排空。
     */
    const socketInflight = this.inboundInflight.get(socket) ?? 0;
    if (socketInflight >= this.maxInflightPerConnection) {
      this._safeEmit('overloaded', { inflight: socketInflight, limit: this.maxInflightPerConnection });
      this._logSafe('gateway_overloaded', { inflight: socketInflight, limit: this.maxInflightPerConnection });
      socket.destroy();
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
      this._beginInbound(socket);
      try {
        const target = requireTarget(frame);
        await this.onTell(target, frame.payload, {
          senderPath: frame.senderPath ?? null,
          senderHost: (frame.senderHost as string | null | undefined) ?? null,
          senderPort: (frame.senderPort as number | null | undefined) ?? null,
          trace: frame.trace ?? null,
        });
      } catch (err) {
        // There is no reply channel: surface it locally instead of silently.
        this.emit('tell_error', err, frame.targetActorId);
      } finally {
        this._endInbound(socket);
      }
      return;
    }

    if (frame.kind === 'stop') {
      this._beginInbound(socket);
      try {
        if (!this.onStop) throw new Error('remote stop is not supported by this node');
        await this.onStop(requireTarget(frame));
        this._send(socket, { kind: 'result', id: frame.id, ok: true, data: null });
      } catch (err) {
        this._send(socket, {
          kind: 'result',
          id: frame.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this._endInbound(socket);
      }
      return;
    }

    if (frame.kind === 'deliver') {
      this._beginInbound(socket);
      try {
        const target = requireTarget(frame);
        const sender = {
          senderPath: frame.senderPath ?? null,
          senderHost: (frame.senderHost as string | null | undefined) ?? null,
          senderPort: (frame.senderPort as number | null | undefined) ?? null,
          trace: frame.trace ?? null,
        };
        const deliver = this.onDeliver;
        if (deliver === undefined) throw new Error('no deliver handler registered');
        const data = await deliver(
          target,
          frame.payload,
          Number(frame.timeoutMs ?? config.actor.requestTimeoutMs),
          sender,
        );
        this._send(socket, { kind: 'result', id: frame.id, ok: true, data: data === undefined ? null : data });
      } catch (err) {
        this._send(socket, {
          kind: 'result',
          id: frame.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this._endInbound(socket);
      }
      return;
    }

    this._send(socket, { kind: 'error', id: frame.id, error: `unknown frame kind: ${frame.kind}` });
  }

  _connection(host: string, port: number): OutboundConnection {
    const addr = `${host}:${port}`;
    const existing = this.pool.get(addr);
    if (existing !== undefined && existing.socket !== null && !existing.socket.destroyed) return existing;

    const conn: OutboundConnection = {
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
    // 连接超时：对端黑洞/半开时不能永久挂住并复用坏连接
    socket.setTimeout(this.connectTimeoutMs, () => {
      this._failConnection(conn, new Error(`connect to ${host}:${port} timed out after ${this.connectTimeoutMs}ms`));
      socket.destroy();
    });
    socket.on('error', (err: Error) => this._failConnection(conn, err));
    socket.on('close', () => this._failConnection(conn, new Error('connection closed')));

    conn.ready = new Promise<void>((resolve, reject) => {
      socket.once(readyEvent, () => {
        socket.setTimeout(0); // 建立后不再用连接超时（空闲回收不在这里做）
        this.emit('connected', addr);
        // Announce ourselves first: the peer rejects data before hello.
        try {
          socket.write(
            encodeFrame(
              {
                kind: 'hello',
                nodeId: this.nodeId,
                codec: this.codecName ?? String(this.codec),
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

    socket.on('data', (chunk: Buffer) => {
      let frames: GatewayFrame[];
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

  _handleClientFrame(conn: OutboundConnection, frame: GatewayFrame): void {
    const socket = conn.socket;
    if (socket === null) return; // 到不了：能收到帧就说明连接已建立（挡住而不是假设）
    if (frame && frame.kind === 'hello') {
      const socket = conn.socket;
      if (socket === null) return;
      const check = tlsUtil.verifyPeerNodeId(socket as import('node:tls').TLSSocket, frame.nodeId, this.tls);
      if (!check.ok) {
        this.emit('auth_error', check.reason);
        socket.destroy();
        return;
      }
      // 发起方**也要**检查对端：shardCount 不一致（D6）与 requireFencing（D5）是双向规则，
      // 否则"我拒绝别人"却"被别人的不一致配置牵着走"。
      const refuse = this._checkHandshake(frame);
      if (refuse !== null) {
        this.emit('handshake_rejected', refuse, { nodeId: frame.nodeId ?? null, direction: 'outbound' });
        socket.destroy();
        return;
      }
      conn.helloOk = true;
      conn.peerNodeId = frame.nodeId ?? null;
      conn.peerCaps = Array.isArray(frame.caps) ? frame.caps : [];
      this.emit('hello', conn.host, conn.port, frame.nodeId);
      return;
    }
    if (frame && frame.id && conn.pending.has(frame.id)) {
      const entry = conn.pending.get(frame.id);
      if (entry !== undefined) {
        conn.pending.delete(frame.id);
        clearTimeout(entry.timer);
        entry.resolve(frame);
      }
    }
  }

  _failConnection(conn: OutboundConnection, err: Error): void {
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
  /** 发一帧、不等回复（远端 tell 用）。返回是否已交给传输层。 */
  send(host: string, port: number, frame: GatewayFrame): boolean {
    if (this.closed) return false;
    const conn = this._connection(host, port);
    conn.ready
      ?.then(() => {
        const socket = conn.socket;
        if (socket === null || socket.destroyed) return;
        socket.write(encodeFrame(frame, this.codec), () => {});
      })
      .catch((err: Error) => this.emit('protocol_error', err));
    return true;
  }

  /** Send one request frame and await its response. */
  request(
    host: string,
    port: number,
    frame: GatewayFrame,
    timeoutMs: number = config.actor.requestTimeoutMs as number,
  ): Promise<GatewayFrame> {
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
        ?.then(() => {
          const socket = conn.socket;
          if (socket === null || socket.destroyed) throw new Error('connection closed');
          socket.write(encodeFrame(payload, this.codec), (err?: Error | null) => {
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
  async deliver(
    host: string,
    port: number,
    targetActorId: string,
    payload: unknown,
    timeoutMs: number = config.actor.requestTimeoutMs as number,
    sender: { path?: string | null; host?: string | null; port?: number | null; trace?: unknown } = {},
  ): Promise<unknown> {
    const res = await this.request(
      host,
      port,
      {
        kind: 'deliver',
        targetActorId,
        payload,
        timeoutMs,
        senderPath: sender.path ?? null,
        senderHost: sender.host ?? null,
        senderPort: sender.port ?? null,
        trace: sender.trace ?? null,
        ...this.epochField(targetActorId),
      },
      timeoutMs + 500,
    );
    if (res.kind !== 'result') throw new Error(`unexpected gateway response: ${JSON.stringify(res)}`);
    if (res.ok !== true) throw new Error(res.error ?? 'remote delivery failed');
    return res.data;
  }

  async ping(host: string, port: number, timeoutMs: number = config.gateway.connectTimeoutMs as number): Promise<boolean> {
    const res = await this.request(host, port, { kind: 'ping' }, timeoutMs);
    return res.kind === 'pong';
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reloader) {
      this.reloader.stop();
      this.reloader = null;
    }
    for (const conn of this.pool.values()) {
      this._failConnection(conn, new Error('gateway closing'));
      conn.socket?.destroy();
    }
    this.pool.clear();
    // Inbound sockets must be destroyed too: server.close() only stops
    // accepting and otherwise waits for peers to hang up, which deadlocks two
    // gateways shutting each other down.
    for (const socket of this.inbound) socket.destroy();
    this.inbound.clear();
    const server = this.server;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
