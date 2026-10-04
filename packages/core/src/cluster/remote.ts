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
class RemoteRef {
  constructor(peer, path) {
    this.peer = peer;
    this._path = String(path);
  }

  get id() {
    const parts = this._path.split('/');
    return parts[parts.length - 1];
  }

  get path() {
    return this._path;
  }

  get isLocal() {
    return false;
  }

  tell(msg, sender, trace) {
    return this.peer.tell(this._path, msg, sender, trace);
  }

  ask(msg, timeoutMs, sender, trace) {
    return this.peer.ask(this._path, msg, timeoutMs, sender, trace);
  }

  stop() {
    return this.peer.stop(this._path);
  }

  inspect() {
    throw new ActorStoppedError(
      `inspect() is local-only; "${this._path}" lives on ${this.peer.describe()}`,
    );
  }

  toString() {
    return `RemoteRef(${this.peer.describe()}/${this._path})`;
  }
}

/** One connected peer node. */
class Peer {
  constructor({ system, host, port, nodeId, tls, ownsGateway }) {
    this.system = system;
    this.host = host;
    this.port = port;
    this.nodeId = nodeId || null;
    this.tls = tls;
    this.gateway = new Gateway({
      host: config.gateway.host,
      port: 0,
      nodeId: system.name,
      tls,
      codec: config.gateway.codec,
    });
    this.ownsGateway = ownsGateway !== false;
  }

  describe() {
    return this.nodeId ? `${this.nodeId}(${this.host}:${this.port})` : `${this.host}:${this.port}`;
  }

  /** An ActorRef for an actor on the peer node. */
  ref(path) {
    if (!path) throw new ActorNotFoundError('peer.ref(path): path is required');
    return new RemoteRef(this, path);
  }

  /** This node's own reachable gateway address, so the peer can reply to us. */
  _selfAddress(sender, trace) {
    return {
      path: sender && sender.path ? sender.path : null,
      host: this.system.server ? config.gossip.advertiseHost : null,
      port: this.system.server ? this.system.server.boundPort : null,
      trace: trace || null,
    };
  }

  tell(path, msg, sender = null, trace = null) {
    return this.gateway.send(this.host, this.port, {
      kind: 'tell',
      targetActorId: String(path),
      payload: msg,
      ...this._selfAddress(sender, trace),
    });
  }

  ask(path, msg, timeoutMs = config.actor.requestTimeoutMs, sender = null, trace = null) {
    return this.gateway.deliver(
      this.host,
      this.port,
      String(path),
      msg,
      timeoutMs,
      { ...this._selfAddress(sender, trace), path: sender && sender.path ? sender.path : null },
    );
  }

  async stop(path) {
    const res = await this.gateway.request(
      this.host,
      this.port,
      { kind: 'stop', targetActorId: String(path) },
      config.actor.requestTimeoutMs,
    );
    if (!res || res.kind !== 'result') throw new ActorStoppedError(`unexpected stop response: ${JSON.stringify(res)}`);
    if (!res.ok) throw new ActorStoppedError(res.error || 'remote stop failed');
    return true;
  }

  async ping() {
    return this.gateway.ping(this.host, this.port);
  }

  /** Probe the peer and learn its node id (its `hello` carries it). */
  async handshake(timeoutMs = 3000) {
    const reply = await this.gateway.request(this.host, this.port, { kind: 'ping' }, timeoutMs);
    if (reply && reply.nodeId) this.nodeId = reply.nodeId;
    return this.nodeId;
  }

  async close() {
    if (this.ownsGateway) await this.gateway.close();
  }
}

/**
 * Create the server side of a node: a gateway bound to a system, so peers can
 * `tell`, `ask` and `stop` this node's actors.
 */
function createServerGateway(system, options = {}) {
  /**
   * A message that arrived from another node: the sender is not a local actor,
   * so it is exposed as a read-only stub carrying the path it came from. Whoever
   * holds a path can push back to it (that is how a room answers a session
   * living on the access node).
   */
  const remoteSender = (meta = {}) => {
    const senderPath = meta.senderPath;
    if (!senderPath) return null;
    // With the sender's gateway address we can reply directly — no gossip round
    // needed. Without it we still expose the path, but sending is an error that
    // says what to do instead.
    const routable = Boolean(meta.senderHost && meta.senderPort);
    const peer = () => system.connect({ host: meta.senderHost, port: meta.senderPort });
    return {
      path: senderPath,
      id: senderPath.split('/').pop(),
      isLocal: false,
      host: meta.senderHost || null,
      port: meta.senderPort || null,
      tell(msg) {
        if (!routable) {
          system._log('remote_sender_unroutable', { path: senderPath });
          throw new ActorStoppedError(
            `cannot tell() a remote sender (${senderPath}): the peer did not advertise a gateway address`,
          );
        }
        peer()
          .then((p) => p.ref(senderPath).tell(msg))
          .catch((err) => {
            system._log('remote_reply_failed', { path: senderPath, err: err.message });
            system.emit('remote_tell_failed', senderPath, err);
          });
        return true;
      },
      async ask(msg, timeoutMs) {
        if (!routable) throw new ActorStoppedError(`cannot ask() a remote sender (${senderPath})`);
        const p = await peer();
        return p.ref(senderPath).ask(msg, timeoutMs);
      },
      stop() {
        return Promise.reject(new ActorStoppedError(`cannot stop() a remote sender (${senderPath})`));
      },
      toString: () => `RemoteSender(${senderPath}${routable ? `@${meta.senderHost}:${meta.senderPort}` : ''})`,
    };
  };

  return new Gateway({
    host: options.host,
    port: options.port === undefined ? config.gateway.port : options.port,
    nodeId: options.nodeId || system.name,
    tls: options.tls || config.tls,
    codec: options.codec || config.gateway.codec,
    onTell: (targetActorId, payload, meta) => {
      const ref = system.resolve(targetActorId);
      if (!ref) throw new ActorNotFoundError(`no actor registered as "${targetActorId}"`);
      return ref.tell(payload, remoteSender(meta), meta.trace);
    },
    onDeliver: (targetActorId, payload, timeoutMs, meta) => {
      const ref = system.resolve(targetActorId);
      if (!ref) throw new ActorNotFoundError(`no actor registered as "${targetActorId}"`);
      return ref.ask(payload, timeoutMs, remoteSender(meta), meta.trace);
    },
    onStop: (targetActorId) => {
      const ref = system.resolve(targetActorId);
      if (!ref) throw new ActorNotFoundError(`no actor registered as "${targetActorId}"`);
      return ref.stop();
    },
  });
}

module.exports = { Peer, RemoteRef, createServerGateway };
