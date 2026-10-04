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

  _send(socket, obj) {
    if (socket.destroyed) return;
    try {
      socket.write(encodeFrame(obj, this.codec));
    } catch (err) {
      this.emit('protocol_error', err);
    }
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
      state.helloOk = true;
      this.inboundState.set(socket, state);
      this._send(socket, { kind: 'hello', id: frame.id, nodeId: this.nodeId, codec: this.codecName });
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

    if (frame.kind === 'tell') {
      if (!this.onTell) {
        this.emit('protocol_error', new Error('peer sent a tell but no handler is registered'));
        return;
      }
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
      }
      return;
    }

    if (frame.kind === 'stop') {
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
      }
      return;
    }

    if (frame.kind === 'deliver') {
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
          socket.write(encodeFrame({ kind: 'hello', nodeId: this.nodeId, codec: this.codecName }, this.codec));
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
      conn.helloOk = true;
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
