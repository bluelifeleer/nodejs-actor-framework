'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

/**
 * Minimal, dependency-free WebSocket server (RFC 6455) for the **client-facing**
 * side of a node.
 *
 * Why this exists: the framework's cluster gateway is node↔node (framed
 * protobuf + mTLS). Browsers and mobile clients speak WebSocket, so an access
 * layer needs one. `ws` is a fine choice too — this module exists so the
 * framework stays zero-dependency and so the access layer has no build step.
 *
 * Deliberately minimal (documented limits):
 *   - text/binary frames, continuation frames, ping/pong, close handshake
 *   - permessage-deflate: **not** supported (no compression) — a client that
 *     offers the extension still connects, we simply never use it
 *   - no extensions, no subprotocol negotiation (use the `subprotocol` option
 *     to echo one if you need it)
 *
 * Usage:
 *   const ws = new WebSocketServer({ port: 8080 });                  // ws://
 *   const ws = new WebSocketServer({ port: 8443, tls: {key, cert} }); // wss://
 *   ws.on('connection', (socket, req) => {
 *     socket.on('message', (data, isBinary) => socket.send('pong'));
 *     socket.on('close', (code) => {});
 *   });
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_HANDSHAKE_BYTES = 16 * 1024;

/** One connected client. */
class WebSocketConnection extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    this.socket = socket;
    this.maxPayloadBytes = options.maxPayloadBytes === undefined ? 4 * 1024 * 1024 : options.maxPayloadBytes;
    this.closed = false;
    this.readyState = 'open';
    this._buffer = Buffer.alloc(0);
    this._fragment = null; // { opcode, chunks, length }
    this._closeSent = false;
    this._closeReceived = false;
    /** Written by the access layer: the authenticated player. */
    this.playerId = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this.emit('error', err);
      this._teardown(1006);
    });
    socket.on('close', () => this._teardown(1006, { silent: true }));
  }

  // --- public API ----------------------------------------------------------

  /** Send a text (or binary) message. */
  send(data, { binary = false } = {}) {
    if (this.closed) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const opcode = binary || Buffer.isBuffer(data) ? OPCODE.BINARY : OPCODE.TEXT;
    return this._frame(opcode, payload);
  }

  /** Send a JSON message (convenience for protocol layers). */
  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  ping(payload = Buffer.alloc(0)) {
    return this._frame(OPCODE.PING, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
  }

  pong(payload = Buffer.alloc(0)) {
    return this._frame(OPCODE.PONG, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
  }

  /** RFC 6455 close handshake. */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.readyState = 'closing';
    if (!this._closeSent) {
      const reasonBuf = Buffer.from(String(reason), 'utf8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this._closeSent = true;
      this._frame(OPCODE.CLOSE, payload);
    }
    // Give the peer a moment to echo the close, then drop the socket.
    const timer = setTimeout(() => this._teardown(code), 500);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Drop the connection immediately (no close handshake). */
  destroy() {
    this._teardown(1006);
  }

  // --- framing -------------------------------------------------------------

  _frame(opcode, payload) {
    if (this.socket.destroyed) return false;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode; server frames are never masked
    try {
      this.socket.write(Buffer.concat([header, payload]));
      this.emit('sent', { opcode, length });
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  _onData(chunk) {
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  /** Parse one frame out of the buffer, or null when more bytes are needed. */
  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      // We negotiate no extensions, so any RSV bit set is a protocol error.
      this._fail(1002, 'RSV bits must be zero (no extensions negotiated)');
      return null;
    }
    // A client must mask its frames.
    if (!masked) {
      this._fail(1002, 'client frames must be masked');
      return null;
    }

    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(this.maxPayloadBytes)) {
        this._fail(1009, `payload too large (${big} bytes)`);
        return null;
      }
      length = Number(big);
      offset += 8;
    }
    if (length > this.maxPayloadBytes) {
      this._fail(1009, `payload too large (${length} bytes)`);
      return null;
    }
    if (buf.length < offset + 4 + length) return null;

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) payload[i] = buf[offset + i] ^ mask[i & 3];
    offset += length;

    this._buffer = buf.subarray(offset);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        this.pong(payload);
        this.emit('ping', payload);
        return;
      case OPCODE.PONG:
        this.emit('pong', payload);
        return;
      case OPCODE.CLOSE: {
        this._closeReceived = true;
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this._closeSent) {
          this._closeSent = true;
          this._frame(OPCODE.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        }
        this.emit('closing', { code, reason });
        this._teardown(code, { reason });
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY: {
        if (this._fragment) {
          this._fail(1002, 'new data frame while a fragmented message is in progress');
          return;
        }
        if (fin) {
          this.emit('message', opcode === OPCODE.TEXT ? payload.toString('utf8') : payload, opcode === OPCODE.BINARY);
          return;
        }
        this._fragment = { opcode, chunks: [payload], length: payload.length };
        return;
      }
      case OPCODE.CONTINUATION: {
        if (!this._fragment) {
          this._fail(1002, 'continuation frame without an initial frame');
          return;
        }
        this._fragment.chunks.push(payload);
        this._fragment.length += payload.length;
        if (!fin) return;
        const { opcode: initial, chunks, length } = this._fragment;
        this._fragment = null;
        const full = Buffer.concat(chunks, length);
        this.emit('message', initial === OPCODE.TEXT ? full.toString('utf8') : full, initial === OPCODE.BINARY);
        return;
      }
      default:
        this._fail(1002, `unknown opcode ${opcode}`);
    }
  }

  _fail(code, reason) {
    this.emit('protocolError', new Error(`websocket protocol error: ${reason}`));
    this.close(code, reason.slice(0, 120));
  }

  _teardown(code, { reason = '', silent = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 'closed';
    const socket = this.socket;
    if (!socket.destroyed) socket.destroy();
    if (!silent) this.emit('close', code, reason);
  }
}

/** HTTP(S) + WebSocket upgrade server. */
class WebSocketServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port === undefined ? 0 : options.port;
    this.path = options.path || '/';
    this.maxPayloadBytes = options.maxPayloadBytes === undefined ? 4 * 1024 * 1024 : options.maxPayloadBytes;
    this.subprotocol = options.subprotocol || null;
    /** Optional hook: return false/throw to reject the upgrade (auth, origin check). */
    this.verifyClient = options.verifyClient || null;
    this.connections = new Set();
    this.server = null;
    this.boundPort = null;
    this._tls = options.tls || null;
    this._httpHandler = options.requestHandler || null;
  }

  get secure() {
    return Boolean(this._tls && this._tls.key && this._tls.cert);
  }

  listen() {
    return new Promise((resolve, reject) => {
      const handler = (req, res) => {
        if (this._httpHandler) return this._httpHandler(req, res);
        res.writeHead(426, { 'content-type': 'text/plain' });
        return res.end('Upgrade Required: this endpoint speaks WebSocket\n');
      };
      this.server = this.secure ? https.createServer(this._tls, handler) : http.createServer(handler);
      this.server.on('error', reject);
      // A TLS server emits tlsClientError for handshake failures; surface it
      // instead of dying with an unhandled 'error'.
      this.server.on('tlsClientError', (err, socket) => {
        this.emit('tlsClientError', err);
        socket.destroy();
      });
      this.server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
      this.server.listen(this.port, this.host, () => {
        this.boundPort = this.server.address().port;
        this.port = this.boundPort;
        this.emit('listening', this.boundPort);
        resolve(this.boundPort);
      });
    });
  }

  async _onUpgrade(req, socket, head) {
    const fail = (status, message) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (upgrade !== 'websocket' || !key || version !== '13') {
      return fail(400, 'Bad Request');
    }
    if (req.url.split('?')[0] !== this.path) {
      return fail(404, 'Not Found');
    }

    // Application-level gate (token auth, origin allow-list, ...).
    if (this.verifyClient) {
      let verdict;
      try {
        verdict = await this.verifyClient(req);
      } catch (err) {
        this.emit('clientRejected', { req, error: err });
        return fail(401, 'Unauthorized');
      }
      if (!verdict) {
        this.emit('clientRejected', { req, error: new Error('rejected by verifyClient') });
        return fail(401, 'Unauthorized');
      }
      req.auth = verdict === true ? null : verdict;
    }

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    ];
    if (this.subprotocol) headers.push(`Sec-WebSocket-Protocol: ${this.subprotocol}`);
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    // Bytes that arrived with the handshake belong to the first frame.
    if (head && head.length > 0) socket.unshift(head);

    const connection = new WebSocketConnection(socket, { maxPayloadBytes: this.maxPayloadBytes });
    this.connections.add(connection);
    connection.on('close', () => this.connections.delete(connection));
    this.emit('connection', connection, req);
  }

  async close() {
    for (const connection of [...this.connections]) connection.close(1001, 'server shutting down');
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const connection of [...this.connections]) connection.destroy();
    this.connections.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Build the `Sec-WebSocket-Key` a client would send (used by tests/clients). */
function clientKey() {
  return crypto.randomBytes(16).toString('base64');
}

/** Minimal client-side handshake, so examples/tests need no `ws` dependency either. */
function connect(url, { timeoutMs = 5000, headers = {}, tls = {} } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return reject(new Error(`invalid websocket url: ${url}`));
    }
    const secure = parsed.protocol === 'wss:';
    if (!secure && parsed.protocol !== 'ws:') return reject(new Error(`unsupported protocol ${parsed.protocol}`));
    const port = Number(parsed.port || (secure ? 443 : 80));
    const key = clientKey();
    const transport = secure ? require('tls') : require('net');
    const socket = transport.connect({
      host: parsed.hostname,
      port,
      // Verify certificates by default: pass { tls: { rejectUnauthorized: false } }
      // only for self-signed test material.
      ...(secure ? tls : {}),
    });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`websocket handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > MAX_HANDSHAKE_BYTES) {
          socket.destroy();
          reject(new Error('websocket handshake response too large'));
        }
        return;
      }
      socket.off('data', onData);
      const head = buffer.subarray(0, end).toString('utf8');
      const rest = buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error(`websocket upgrade refused: ${head.split('\r\n')[0]}`));
      }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
      if (!accept || accept[1] !== acceptKey(key)) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error('websocket handshake failed: bad Sec-WebSocket-Accept'));
      }
      clearTimeout(timer);
      if (rest.length > 0) socket.unshift(rest);
      const connection = new ClientConnection(socket, { maxPayloadBytes: 64 * 1024 * 1024 });
      // Server frames are unmasked; the connection reads frames either way.
      resolve(connection);
      return undefined;
    };
    socket.on('data', onData);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('close', () => {
      // No error event, no complete handshake: the server refused (or dropped)
      // the upgrade. Report what it said instead of hanging until the timeout.
      clearTimeout(timer);
      const firstLine = buffer.length > 0 ? buffer.toString('utf8').split('\r\n')[0] : 'connection closed';
      reject(new Error(`websocket upgrade refused: ${firstLine}`));
    });
    socket.once('connect', () => {
      const path = `${parsed.pathname}${parsed.search}` || '/';
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${parsed.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ].join('\r\n'),
      );
    });
  });
}

/**
 * Client-side connection. Servers never mask, so this class writes masked
 * frames and accepts unmasked ones — the mirror image of WebSocketConnection.
 */
class ClientConnection extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    this.socket = socket;
    this.closed = false;
    this.maxPayloadBytes = options.maxPayloadBytes === undefined ? 4 * 1024 * 1024 : options.maxPayloadBytes;
    this._buffer = Buffer.alloc(0);
    this._fragment = null;
    this._closeSent = false;
    /** Messages that arrived before anyone attached a listener. */
    this._inbox = [];
    /** Control frames that arrived before anyone attached a listener. */
    this._pingInbox = [];
    this._pongInbox = [];
    this._closed = null; // { code, reason } once the connection ended

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      for (;;) {
        const frame = this._readFrame();
        if (!frame) break;
        this._handleFrame(frame);
        if (this.closed) break;
      }
    });
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this._closed = { code: 1006, reason: '' };
        this.emit('close', 1006, '');
      }
    });
  }

  /** Emit immediately when someone is listening, otherwise queue it. */
  _deliver(data, isBinary) {
    if (this.listenerCount('message') > 0) this.emit('message', data, isBinary);
    else this._inbox.push({ data, isBinary });
  }

  send(data, { binary = false } = {}) {
    if (this.closed) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const opcode = binary || Buffer.isBuffer(data) ? OPCODE.BINARY : OPCODE.TEXT;
    return this._frame(opcode, payload);
  }

  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.closed) return false;
    return this._frame(OPCODE.PING, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
  }

  pong(payload = Buffer.alloc(0)) {
    if (this.closed) return false;
    return this._frame(OPCODE.PONG, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!this._closeSent) {
      const reasonBuf = Buffer.from(String(reason), 'utf8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this._closeSent = true;
      this._frame(OPCODE.CLOSE, payload);
    }
    const timer = setTimeout(() => {
      this.closed = true;
      this.socket.destroy();
      this.emit('close', code, reason);
    }, 200);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Await the next message. Messages that arrived before this call are still
   * returned (the server often replies while the handshake is being parsed).
   */
  nextMessage(timeoutMs = 5000) {
    if (this._inbox.length > 0) return Promise.resolve(this._inbox.shift());
    if (this.closed) {
      return Promise.reject(new Error(`websocket is closed (code ${this._closed ? this._closed.code : 'unknown'})`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a websocket message')), timeoutMs);
      this.once('message', (data, isBinary) => {
        clearTimeout(timer);
        resolve({ data, isBinary });
      });
    });
  }

  /** Await the next PING (buffered like messages, so a greeting is not missed). */
  nextPing(timeoutMs = 5000) {
    if (this._pingInbox.length > 0) return Promise.resolve(this._pingInbox.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a websocket ping')), timeoutMs);
      this.once('ping', (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  /** Await the next PONG. */
  nextPong(timeoutMs = 5000) {
    if (this._pongInbox.length > 0) return Promise.resolve(this._pongInbox.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a websocket pong')), timeoutMs);
      this.once('pong', (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  _frame(opcode, payload) {
    if (this.socket.destroyed) return false;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
    return true;
  }

  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      length = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    if (length > this.maxPayloadBytes) {
      this.emit('error', new Error(`payload too large (${length} bytes)`));
      this.socket.destroy();
      return null;
    }
    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return null;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) payload[i] = mask ? buf[offset + i] ^ mask[i & 3] : buf[offset + i];
    this._buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        this._frame(OPCODE.PONG, payload);
        if (this.listenerCount('ping') > 0) this.emit('ping', payload);
        else this._pingInbox.push(payload);
        return;
      case OPCODE.PONG:
        if (this.listenerCount('pong') > 0) this.emit('pong', payload);
        else this._pongInbox.push(payload);
        return;
      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this._closeSent) this._frame(OPCODE.CLOSE, payload.subarray(0, Math.min(2, payload.length)));
        this.closed = true;
        this._closed = { code, reason: '' };
        this.socket.destroy();
        this.emit('close', code, '');
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY: {
        if (fin) {
          this._deliver(opcode === OPCODE.TEXT ? payload.toString('utf8') : payload, opcode === OPCODE.BINARY);
          return;
        }
        this._fragment = { opcode, chunks: [payload], length: payload.length };
        return;
      }
      case OPCODE.CONTINUATION: {
        if (!this._fragment) return;
        this._fragment.chunks.push(payload);
        this._fragment.length += payload.length;
        if (!fin) return;
        const { opcode: initial, chunks, length } = this._fragment;
        this._fragment = null;
        const full = Buffer.concat(chunks, length);
        this._deliver(initial === OPCODE.TEXT ? full.toString('utf8') : full, initial === OPCODE.BINARY);
        return;
      }
      default:
        this.emit('error', new Error(`unknown opcode ${opcode}`));
    }
  }
}

module.exports = { WebSocketServer, WebSocketConnection, ClientConnection, connect, acceptKey, OPCODE };
module.exports.WebSocketServer = WebSocketServer;
module.exports.connect = connect;
