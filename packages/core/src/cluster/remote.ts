// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const config = require('../config.ts');
const Gateway = require('./gateway.ts');
const { ActorStoppedError, ActorNotFoundError } = require('../actor/errors.ts');

/**
 * Location transparency: a remote actor is used exactly like a local one.
 *
 *   const peer = await system.connect({ host: '10.0.0.2', port: 9000 });
 *   const player = peer.ref('arena/alice');
 *   player.tell({ type: 'poke' });                        // fire and forget
 *   const hp = await player.ask({ type: 'hurt', damage: 5 }); // request/response
 *
 * `tell` hands the frame to the transport and returns immediately (the remote
 * mailbox cannot report back without turning tell into ask); `ask` is a real
 * round trip and therefore reports remote errors and timeouts.
 */
/** 发送方元信息（帧上的 sender* 字段）。 */
interface SenderMeta {
  senderPath?: string | null;
  senderHost?: string | null;
  senderPort?: number | null;
  trace?: unknown;
}

/** 本节点的可达地址（发给对端，便于它直接回发）。 */
interface SelfAddress {
  path: string | null;
  host: string | null;
  port: number | null;
  trace: unknown;
}

/** 结构型 system 视图（内核是 CJS，不能 import type）。 */
interface RemoteSystem {
  readonly name: string;
  readonly server: { boundPort: number } | null;
  ownership: {
    shardCount?: number;
    requireFencing?: boolean;
    verifyIncoming?(info: unknown): { ok: boolean; reason?: string };
    epochFor?(path: string): number | null;
  } | null;
  resolve(target: string): RemoteTarget | null;
  connect(options: { host: string | null | undefined; port: number | null | undefined }): Promise<Peer>;
  emit(event: string, ...args: unknown[]): void;
  _log(event: string, meta?: Record<string, unknown>): void;
}

/** 能接收消息的引用（本地 cell、远端引用，或"远端来话方"的只读 stub）。 */
interface RemoteTarget {
  readonly path?: string;
  readonly id?: string | null | undefined;
  readonly isLocal?: boolean;
  readonly host?: string | null;
  readonly port?: number | null;
  tell(msg: unknown, sender?: unknown, trace?: unknown): boolean;
  ask(msg: unknown, timeoutMs?: number, sender?: unknown, trace?: unknown): Promise<unknown>;
  stop(): Promise<unknown>;
  toString?(): string;
}

interface GatewayLike {
  send(host: string, port: number, frame: Record<string, unknown>): boolean;
  request(host: string, port: number, frame: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  deliver(
    host: string,
    port: number,
    targetActorId: string,
    payload: unknown,
    timeoutMs: number,
    sender: SenderMeta & { path: string | null },
  ): Promise<unknown>;
  ping(host: string, port: number, timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
  epochField?(path: string): { shardEpoch?: number };
}

class RemoteRef {
  readonly peer: Peer;
  readonly _path: string;

  constructor(peer: Peer, path: string) {
    this.peer = peer;
    this._path = String(path);
  }

  get id(): string | undefined {
    const parts = this._path.split('/');
    return parts[parts.length - 1];
  }

  get path(): string {
    return this._path;
  }

  get isLocal(): boolean {
    return false;
  }

  tell(msg: unknown, sender?: unknown, trace?: unknown): boolean {
    return this.peer.tell(this._path, msg, sender as { path?: string } | null | undefined, trace);
  }

  ask(msg: unknown, timeoutMs?: number, sender?: unknown, trace?: unknown): Promise<unknown> {
    return this.peer.ask(this._path, msg, timeoutMs, sender as { path?: string } | null | undefined, trace);
  }

  stop(): Promise<boolean> {
    return this.peer.stop(this._path);
  }

  inspect(): never {
    throw new ActorStoppedError(
      `inspect() is local-only; "${this._path}" lives on ${this.peer.describe()}`,
    );
  }

  toString(): string {
    return `RemoteRef(${this.peer.describe()}/${this._path})`;
  }
}

/** One connected peer node. */
/**
 * fencing 相关选项（M4 第 2b 步）。
 *
 * **出站与入站两条网关构造都必须用同一份**：只给服务端装，就会出现"发帧的网关不带 token、
 * 收帧的网关却要求 token"——跨节点调用被自己人拒掉（这是真实踩到的 bug，见提交信息）。
 * 客户端网关不需要"判定钩子"（它不接收 tell/deliver），但**必须**能给出自己的 epoch。
 */
function ownershipOptions(system: RemoteSystem, { inbound }: { inbound: boolean }): Record<string, unknown> {
  const ownership = system.ownership || null;
  if (ownership === null) return {};
  return {
    shardCount: ownership.shardCount ?? null,
    ...(inbound
      ? {
          requireFencing: ownership.requireFencing === true,
          verifyOwnership: (info: unknown) => ownership.verifyIncoming?.(info),
        }
      : {}),
    epochFor: (path: string) => ownership.epochFor?.(path) ?? null,
  };
}

class Peer {
  readonly system: RemoteSystem;
  readonly host: string;
  readonly port: number;
  nodeId: string | null;
  readonly tls: unknown;
  readonly gateway: GatewayLike;
  readonly ownsGateway: boolean;

  constructor({
    system,
    host,
    port,
    nodeId,
    tls,
    ownsGateway,
  }: {
    system: RemoteSystem;
    host: string;
    port: number;
    nodeId?: string | null;
    tls?: unknown;
    ownsGateway?: boolean;
  }) {
    this.system = system;
    this.host = host;
    this.port = port;
    this.nodeId = nodeId ?? null;
    this.tls = tls;
    this.gateway = new Gateway({
      host: config.gateway.host,
      port: 0,
      nodeId: system.name,
      tls,
      codec: config.gateway.codec,
      ...ownershipOptions(system, { inbound: false }),
    });
    this.ownsGateway = ownsGateway !== false;
  }

  describe(): string {
    return this.nodeId ? `${this.nodeId}(${this.host}:${this.port})` : `${this.host}:${this.port}`;
  }

  /** An ActorRef for an actor on the peer node. */
  ref(path: string): RemoteRef {
    if (!path) throw new ActorNotFoundError('peer.ref(path): path is required');
    return new RemoteRef(this, path);
  }

  /** This node's own reachable gateway address, so the peer can reply to us. */
  /** 本节点的可达网关地址（对端据此直接回发，不用再走 gossip）。 */
  _selfAddress(sender: { path?: string } | null | undefined, trace: unknown): SelfAddress {
    // 插件选项 `advertiseHost` 必须优先于全局配置：否则多网卡部署里 gossip 广播的地址
    // 与网关回复地址不一致，对端会按错误地址回发。
    const advertised = (this.system as { cluster?: { gossip?: { advertiseHost?: unknown } } }).cluster?.gossip?.advertiseHost;
    return {
      path: sender && sender.path ? sender.path : null,
      host: this.system.server ? (typeof advertised === 'string' && advertised !== '' ? advertised : config.gossip.advertiseHost) : null,
      port: this.system.server ? this.system.server.boundPort : null,
      trace: trace || null,
    };
  }

  tell(path: string, msg: unknown, sender: { path?: string } | null | undefined = null, trace: unknown = null): boolean {
    return this.gateway.send(this.host, this.port, {
      kind: 'tell',
      targetActorId: String(path),
      payload: msg,
      ...this.epochField(String(path)),
      ...this._selfAddress(sender, trace),
    });
  }

  /** fencing token：本节点认为目标 shard 是第几代（没装守卫时是空对象）。 */
  epochField(path: string): { shardEpoch?: number } {
    return typeof this.gateway.epochField === 'function' ? this.gateway.epochField(path) : {};
  }

  ask(
    path: string,
    msg: unknown,
    timeoutMs: number = config.actor.requestTimeoutMs as number,
    sender: { path?: string } | null | undefined = null,
    trace: unknown = null,
  ): Promise<unknown> {
    return this.gateway.deliver(
      this.host,
      this.port,
      String(path),
      msg,
      timeoutMs,
      { ...this._selfAddress(sender, trace), path: sender && sender.path ? sender.path : null },
    );
  }

  async stop(path: string): Promise<boolean> {
    const res = await this.gateway.request(
      this.host,
      this.port,
      { kind: 'stop', targetActorId: String(path), ...this.epochField(String(path)) },
      config.actor.requestTimeoutMs,
    );
    if (res.kind !== 'result') throw new ActorStoppedError(`unexpected stop response: ${JSON.stringify(res)}`);
    if (res.ok !== true) throw new ActorStoppedError(String(res.error ?? 'remote stop failed'));
    return true;
  }

  async ping(): Promise<boolean> {
    return this.gateway.ping(this.host, this.port);
  }

  /** Probe the peer and learn its node id (its `hello` carries it). */
  async handshake(timeoutMs = 3000): Promise<string | null> {
    const reply = await this.gateway.request(this.host, this.port, { kind: 'ping' }, timeoutMs);
    if (typeof reply.nodeId === 'string' && reply.nodeId !== '') this.nodeId = reply.nodeId;
    return this.nodeId;
  }

  async close(): Promise<void> {
    if (this.ownsGateway) await this.gateway.close();
  }
}

/**
 * Create the server side of a node: a gateway bound to a system, so peers can
 * `tell`, `ask` and `stop` this node's actors.
 */
function createServerGateway(system: RemoteSystem, options: Record<string, unknown> = {}): GatewayLike {
  /**
   * A message that arrived from another node: the sender is not a local actor,
   * so it is exposed as a read-only stub carrying the path it came from. Whoever
   * holds a path can push back to it (that is how a room answers a session
   * living on the access node).
   */
  const remoteSender = (meta: SenderMeta = {}): RemoteTarget | null => {
    const senderPath = meta.senderPath;
    if (!senderPath) return null;
    // With the sender's gateway address we can reply directly — no gossip round
    // needed. Without it we still expose the path, but sending is an error that
    // says what to do instead.
    const routable = Boolean(meta.senderHost !== undefined && meta.senderHost !== null && meta.senderPort);
    const peer = () => system.connect({ host: meta.senderHost, port: meta.senderPort });
    return {
      path: senderPath,
      id: senderPath.split('/').pop() ?? null,
      isLocal: false,
      host: meta.senderHost ?? null,
      port: meta.senderPort ?? null,
      tell(msg: unknown): boolean {
        if (!routable) {
          system._log('remote_sender_unroutable', { path: senderPath });
          throw new ActorStoppedError(
            `cannot tell() a remote sender (${senderPath}): the peer did not advertise a gateway address`,
          );
        }
        peer()
          .then((target) => target.ref(senderPath).tell(msg))
          .catch((err: unknown) => {
            system._log('remote_reply_failed', { path: senderPath, err: err instanceof Error ? err.message : String(err) });
            system.emit('remote_tell_failed', senderPath, err);
          });
        return true;
      },
      async ask(msg: unknown, timeoutMs?: number): Promise<unknown> {
        if (!routable) throw new ActorStoppedError(`cannot ask() a remote sender (${senderPath})`);
        const p = await peer();
        return p.ref(senderPath).ask(msg, timeoutMs);
      },
      stop(): Promise<never> {
        return Promise.reject(new ActorStoppedError(`cannot stop() a remote sender (${senderPath})`));
      },
      toString: () => `RemoteSender(${senderPath}${routable ? `@${meta.senderHost}:${meta.senderPort}` : ''})`,
    };
  };

  return new Gateway({
    host: options.host as string | undefined,
    port: options.port === undefined ? (config.gateway.port as number) : (options.port as number),
    nodeId: (options.nodeId as string | undefined) ?? system.name,
    tls: options.tls ?? config.tls,
    codec: (options.codec as string | number | undefined) ?? config.gateway.codec,
    // 所有权由插件装在 system.ownership 上；没装就是"没有所有权信息"，网关照旧工作（诚实降级）
    ...ownershipOptions(system, { inbound: true }),
    onTell: (targetActorId: string, payload: unknown, meta: SenderMeta) => {
      const ref = system.resolve(targetActorId);
      if (!ref) throw new ActorNotFoundError(`no actor registered as "${targetActorId}"`);
      return ref.tell(payload, remoteSender(meta), meta.trace);
    },
    onDeliver: (targetActorId: string, payload: unknown, timeoutMs: number, meta: SenderMeta) => {
      const ref = system.resolve(targetActorId);
      if (!ref) throw new ActorNotFoundError(`no actor registered as "${targetActorId}"`);
      return ref.ask(payload, timeoutMs, remoteSender(meta), meta.trace);
    },
    onStop: (targetActorId: string) => {
      const ref = system.resolve(targetActorId);
      if (!ref) throw new ActorNotFoundError(`no actor registered as "${targetActorId}"`);
      return ref.stop();
    },
  });
}

module.exports = { Peer, RemoteRef, createServerGateway };
