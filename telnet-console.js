'use strict';

const net = require('net');
const crypto = require('crypto');
const config = require('./config');

const ACTOR_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PRIORITY_NAMES = { 0: 'HIGH', 1: 'NORMAL', 2: 'LOW' };
const BANNER = [
  '=== Actor Framework Console ===',
  'help | hurt [actorId] [damage] [priority] | getState [actorId] | actors',
  'spawn [actorId] | kill [actorId] | crash [actorId] | sup info',
  'registry list | dlq list|size|clear | metrics dump',
  'pub sub|unsub [topic] [actorId] | pub pub [topic] json | pub topics',
  'hotreload [actorId] <code> | hotload [actorId] [module] [export]',
  'gossip info | gateway ping [host] [port] | exit',
].join('\n');

function tokenEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Telnet debug console.
 *
 * Fixes over the previous inline implementation:
 *  - line buffering (TCP chunks are no longer mistaken for commands, and
 *    several commands in one packet all work),
 *  - optional token authentication, required automatically on non-loopback
 *    binds (the console can replace actor code),
 *  - input validation, so `hurt a abc` no longer poisons actor state with NaN,
 *  - bounded line length and connection count,
 *  - an empty line re-prompts instead of closing the session.
 */
class TelnetConsole {
  constructor(options = {}) {
    this.host = options.host || config.telnet.host;
    this.port = options.port === undefined ? config.telnet.port : options.port;
    this.token = options.token ?? config.telnet.token;
    this.maxLineBytes = options.maxLineBytes || config.telnet.maxLineBytes;
    this.maxConnections = options.maxConnections || config.telnet.maxConnections;
    this.ctx = options.context || {};
    this.logger = options.logger || this.ctx.logger;
    this.server = null;
    this.boundPort = null;
    this.sockets = new Set();
  }

  get requiresAuth() {
    return Boolean(this.token);
  }

  assertSafeBinding() {
    const isLoopback = this.host === '127.0.0.1' || this.host === '::1' || this.host === 'localhost';
    if (!isLoopback && !this.token) {
      throw new Error(
        `refusing to expose the console on ${this.host} without ACTOR_TELNET_TOKEN ` +
          '(the console can replace actor code)',
      );
    }
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.assertSafeBinding();
      const server = net.createServer((socket) => this._onConnection(socket));
      this.server = server;
      server.on('error', (err) => reject(err));
      server.maxConnections = this.maxConnections;
      server.listen(this.port, this.host, () => {
        this.boundPort = server.address().port;
        this.port = this.boundPort;
        resolve(this.boundPort);
      });
    });
  }

  _onConnection(socket) {
    this.sockets.add(socket);
    const session = { authed: !this.requiresAuth, buffer: '' };

    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));

    socket.write(`${BANNER}\n> `);

    socket.on('data', (chunk) => {
      session.buffer += chunk.toString('utf8');
      if (Buffer.byteLength(session.buffer, 'utf8') > this.maxLineBytes) {
        socket.write('ERR: line too long\n');
        session.buffer = '';
        return;
      }
      let idx;
      while ((idx = session.buffer.indexOf('\n')) >= 0) {
        const rawLine = session.buffer.slice(0, idx);
        session.buffer = session.buffer.slice(idx + 1);
        this._handleLine(rawLine.replace(/\r$/, ''), socket, session);
        if (socket.destroyed) return;
      }
    });
  }

  async _handleLine(line, socket, session) {
    const trimmed = line.trim();
    if (trimmed === '') {
      socket.write('> ');
      return;
    }
    if (trimmed === 'exit' || trimmed === 'quit') {
      socket.end('bye\n');
      return;
    }

    if (!session.authed) {
      const [cmd, ...rest] = trimmed.split(/\s+/);
      if (cmd !== 'auth' || !tokenEquals(rest.join(' ').trim(), this.token)) {
        this.logger?.logSystem('telnet_auth_failed', {});
        socket.end('ERR: authentication required (auth <token>)\n');
        return;
      }
      session.authed = true;
      socket.write('authenticated\n> ');
      return;
    }

    let out;
    try {
      out = await this._dispatch(trimmed);
    } catch (err) {
      out = `ERR:${err.message}`;
    }
    if (out === undefined || out === null) out = 'ok';
    socket.write(`${out}\n> `);
  }

  // --- command dispatch ----------------------------------------------------

  async _dispatch(line) {
    const parts = line.split(/\s+/);
    const cmd = parts[0];
    const { am, supervisor, registry, dlq, metrics, pubsub, gossip, hotReload, gateway } = this.ctx;
    const timeoutMs = config.actor.requestTimeoutMs;

    switch (cmd) {
      case 'help':
        return BANNER;

      case 'hurt': {
        const actorId = this._actorId(parts[1]);
        const damage = Number(parts[2]);
        if (!Number.isFinite(damage)) throw new Error(`damage must be a finite number, got "${parts[2]}"`);
        const priority = this._priority(parts[3]);
        const hp = await am.send(actorId, { type: 'hurt', damage }, timeoutMs, priority);
        return `OK hp=${hp} priority=${priority}(${PRIORITY_NAMES[priority]})`;
      }

      case 'getState': {
        const actorId = this._actorId(parts[1]);
        const state = await am.send(actorId, { type: 'debug:getState' }, timeoutMs);
        return `state:${JSON.stringify(state)}`;
      }

      case 'actors': {
        const list = am.listActors();
        return `actors:${JSON.stringify(list)}`;
      }

      case 'spawn': {
        const actorId = this._actorId(parts[1]);
        if (am.hasActor(actorId)) throw new Error(`actor ${actorId} already exists`);
        am.createActor(actorId);
        return `spawn ${actorId} ok`;
      }

      case 'kill': {
        const actorId = this._actorId(parts[1]);
        const ok = await am.destroyActor(actorId);
        return ok ? `kill ${actorId} ok (intentional stop, will NOT be restarted)` : `ERR:actor ${actorId} not found`;
      }

      case 'drop': {
        const actorId = this._actorId(parts[1]);
        if (supervisor) supervisor.removeChild(actorId);
        await am.destroyActor(actorId);
        registry.unregister(actorId);
        return `drop ${actorId} ok (no restart)`;
      }

      case 'crash': {
        const actorId = this._actorId(parts[1]);
        am.crashActor(actorId);
        return `crash ${actorId} sent, supervisor will restart it`;
      }

      case 'sup':
        if (parts[1] !== 'info') throw new Error('usage: sup info');
        return `sup:${JSON.stringify(supervisor.info())}`;

      case 'registry':
        if (parts[1] !== 'list') throw new Error('usage: registry list');
        return `registry:${JSON.stringify(registry.getAll())}`;

      case 'dlq': {
        if (parts[1] === 'list') return `DLQ:${JSON.stringify(await dlq.list(50))}`;
        if (parts[1] === 'size') return `DLQ size:${await dlq.size()}`;
        if (parts[1] === 'clear') {
          await dlq.clear();
          return 'DLQ cleared';
        }
        throw new Error('usage: dlq list|size|clear');
      }

      case 'metrics':
        if (parts[1] !== 'dump') throw new Error('usage: metrics dump');
        return `metrics:${JSON.stringify(metrics.dump())}`;

      case 'pub': {
        if (parts[1] === 'sub') {
          pubsub.subscribe(parts[2], this._actorId(parts[3]));
          return `subscribe ${parts[2]} -> ${parts[3]}`;
        }
        if (parts[1] === 'unsub') {
          pubsub.unsubscribe(parts[2], this._actorId(parts[3]));
          return `unsub ${parts[2]} -> ${parts[3]}`;
        }
        if (parts[1] === 'topics') return `topics:${JSON.stringify(pubsub.listTopics())}`;
        if (parts[1] === 'pub') {
          const topic = parts[2];
          if (!topic) throw new Error('usage: pub pub [topic] json');
          const payloadRaw = line.slice(line.indexOf(topic) + topic.length).trim();
          if (!payloadRaw) throw new Error('usage: pub pub [topic] json');
          let payload;
          try {
            payload = JSON.parse(payloadRaw);
          } catch (err) {
            throw new Error(`payload must be valid JSON: ${err.message}`);
          }
          const traceCtx = require('./trace').newRoot();
          const res = await pubsub.publish(topic, payload, traceCtx);
          return `publish result:${JSON.stringify(res)}`;
        }
        throw new Error('usage: pub sub|unsub|pub|topics');
      }

      case 'hotreload': {
        const actorId = this._actorId(parts[1]);
        if (!hotReload.isEnabled) {
          throw new Error('hot reload is disabled; start with ENABLE_HOT_RELOAD=1 to enable it');
        }
        if (parts[2] === undefined) throw new Error('usage: hotreload [actorId] <code>');
        let code = line.slice(line.indexOf(parts[2])).trim();
        // Accept the documented quoted form: hotreload a "async (msg)=>{...}"
        if (code.length >= 2 && ((code[0] === '"' && code.endsWith('"')) || (code[0] === "'" && code.endsWith("'")))) {
          code = code.slice(1, -1);
        }
        if (!code) throw new Error('usage: hotreload [actorId] <code>');
        const res = await hotReload.hotUpdate(actorId, code);
        return `hot reload ${actorId}: ${JSON.stringify(res)}`;
      }

      case 'hotload': {
        const actorId = this._actorId(parts[1]);
        const res = await hotReload.loadFromModule(actorId, parts[2], parts[3]);
        return `hot load ${actorId}: ${JSON.stringify(res)}`;
      }

      case 'gossip':
        if (parts[1] !== 'info') throw new Error('usage: gossip info');
        return `gossip:${JSON.stringify(gossip ? gossip.info() : { enabled: false })}`;

      case 'gateway': {
        if (parts[1] !== 'ping') throw new Error('usage: gateway ping [host] [port]');
        if (!gateway) throw new Error('gateway disabled');
        const host = parts[2] || config.gateway.host;
        const port = Number(parts[3] || config.gateway.port);
        const ok = await gateway.ping(host, port);
        return `gateway ${host}:${port} -> ${ok ? 'pong' : 'no response'}`;
      }

      default:
        return `unknown command: ${cmd} (try "help")`;
    }
  }

  _actorId(value) {
    if (!value) throw new Error('actorId is required');
    if (!ACTOR_ID_RE.test(value)) {
      throw new Error('actorId must match [A-Za-z0-9._:-]{1,128}');
    }
    return value;
  }

  _priority(value) {
    if (value === undefined || value === '') return 1;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 2) throw new Error(`priority must be 0, 1 or 2 (got "${value}")`);
    return n;
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }
}

module.exports = TelnetConsole;
module.exports.TelnetConsole = TelnetConsole;
module.exports.ACTOR_ID_RE = ACTOR_ID_RE;
