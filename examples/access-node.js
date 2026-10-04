import path from 'node:path';
import config from '../packages/core/src/config.ts';
import { createSystem, plugins, ActorNotFoundError } from 'nodejs-actor-framework';
import _ws_server from '../packages/core/src/ops/ws-server.ts';
const { WebSocketServer } = _ws_server;
import _token from '../packages/core/src/ops/token.ts';
const { TokenAuthority, tokenFromRequest } = _token;
import fs from 'node:fs';

/**
 * 接入层（access node）：浏览器/手机客户端唯一需要认识的东西。
 *
 *   node examples/access-node.js                 # 需要 ACTOR_AUTH_SECRET，连本地 room-1
 *   ACTOR_AUTH_SECRET=... SEEDS=10.0.0.1:7200 WSS_TLS=1 \
 *     CERT=... KEY=... node examples/access-node.js
 *
 * 职责（只有这些，业务逻辑全在 Actor 里）：
 *   1. 终结 WebSocket / TLS，把每条客户端消息翻译成一个 Actor 消息；
 *   2. 升级握手时校验 token，**playerId 从 token 里取**（客户端无法冒充别人）；
 *   3. 按 playerId 做一致性哈希选房间，然后按**名字**路由（本地或集群里的远端房间）；
 *   4. 每连接一个 Session Actor：入口限流、有界邮箱、断线清理。
 *
 * 为什么 playerId 必须来自 token：如果让客户端在消息里带 playerId，任何人都能操作别人的角色。
 */







const ROOM_PREFIX = process.env.ROOM_PREFIX || 'room';
const ROOM_COUNT = Number(process.env.ROOM_COUNT || 2);

/**
 * 一致性哈希：同一个 playerId 永远落到同一个房间。
 * 真实项目里这个映射可以存在数据库/配置中心，这里用纯函数演示。
 */
function roomFor(playerId, roomCount = ROOM_COUNT, prefix = ROOM_PREFIX) {
  // FNV-1a：稳定、无依赖、分布够均匀
  let hash = 0x811c9dc5;
  for (let i = 0; i < playerId.length; i += 1) {
    hash ^= playerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${(hash % roomCount) + 1}`;
}

/** 一条 WS 连接 = 一个 Session Actor（工厂 + handler bag，闭包捕获连接）。 */
function makeSession(socket, { playerId, roomCount, roomPrefix }) {
  const write = (obj) => socket.sendJson(obj);
  const room = (ctx) => roomFor(playerId, roomCount, roomPrefix);

  async function handle(cmd, arg, ctx) {
    switch (cmd) {
      case 'join':
        // 按名字路由：本地房间直接命中，远端房间由 cluster 插件发现（懒连接）
        return ctx.ask(room(ctx), { type: 'join', playerId }, 5000);
      case 'hit':
      case 'move':
      case 'stats':
        return ctx.ask(room(ctx), { ...arg, type: cmd, playerId }, 5000);
      case 'chat':
        return ctx.ask(room(ctx), { type: 'chat', text: arg.text, from: playerId }, 5000);
      case 'top':
        return ctx.ask(room(ctx), { type: 'top', n: arg.n }, 8000);
      case 'room':
        return ctx.ask(room(ctx), { type: 'room' }, 5000);
      default:
        throw new Error(`unknown command "${cmd}"`);
    }
  }

  return {
    state: () => ({ playerId, lines: 0, errors: 0 }),

    async onMessage(msg, ctx) {
      // 服务端推送（房间广播 → Session → socket）
      if (msg.type === 'push') {
        write({ push: 'event', text: msg.text, from: msg.from });
        return 'pushed';
      }
      if (msg.type === 'close') {
        write({ push: 'bye' });
        return ctx.stopSelf();
      }

      this.state.lines += 1;
      const cmd = String(msg.cmd || '').trim();
      try {
        const result = await handle(cmd, msg, ctx);
        write({ ok: true, cmd, player: playerId, room: room(ctx), result });
        return 'ok';
      } catch (err) {
        // 业务错误回给客户端，而不是让会话 Actor 崩掉
        this.state.errors += 1;
        const hint = err instanceof ActorNotFoundError ? '（房间不存在？先 join，或检查 ROOM_COUNT/集群发现）' : '';
        write({ ok: false, cmd, player: playerId, error: `${err.message}${hint}` });
        return 'error';
      }
    },

    async onStop(ctx) {
      // 断线只清会话映射：玩家 Actor 与状态留给下次登录
      try {
        await ctx.ask(room(ctx), { type: 'disconnect', playerId }, 2000);
      } catch {
        /* the room may already be gone during shutdown */
      }
      try {
        socket.close(1000, 'session stopped');
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Start the access layer on an existing system.
 *
 * @param {object} options
 * @param {object} options.system      ActorSystem (needs the cluster plugin to reach remote rooms)
 * @param {TokenAuthority} options.tokens
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {object} [options.tls]       `{key, cert}` for WSS; required off-loopback
 * @param {number} [options.roomCount]
 * @param {string} [options.roomPrefix]
 */
async function startAccessNode(options) {
  const {
    system,
    tokens,
    host = process.env.WS_HOST || '127.0.0.1',
    port = Number(process.env.WS_PORT || 8080),
    tls = null,
    roomCount = ROOM_COUNT,
    roomPrefix = ROOM_PREFIX,
  } = options;

  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!isLoopback && !tls) {
    // Same stance as the telnet console: never expose a plaintext client
    // endpoint on a public interface by accident.
    throw new Error(
      `refusing to serve plaintext WebSocket on ${host}: pass { tls: { key, cert } } ` +
        '(or bind 127.0.0.1 behind a TLS terminator)',
    );
  }

  let sessionSeq = 0;
  const server = new WebSocketServer({
    host,
    port,
    path: process.env.WS_PATH || '/game',
    tls,
    maxPayloadBytes: 64 * 1024, // client messages are small; cap them
    verifyClient(req) {
      const token = tokenFromRequest(req);
      const verified = token ? tokens.verify(token) : null;
      if (!verified) {
        system.emit('auth_failed', { url: req.url, remote: req.socket.remoteAddress });
        return false;
      }
      return verified; // { playerId, ... } becomes req.auth
    },
  });

  server.on('connection', async (socket, req) => {
    const playerId = (req.auth && req.auth.playerId) || null;
    socket.playerId = playerId;
    system.emit('client_connected', { playerId, room: roomFor(playerId, roomCount, roomPrefix) });

    const session = await system.spawn(makeSession(socket, { playerId, roomCount, roomPrefix }), {
      id: `session-${++sessionSeq}`,
      mailbox: { maxSize: 200 },
      rateLimit: { capacity: 40, rate: 25 }, // 入口限流：刷屏只影响这条连接
    });

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        socket.sendJson({ ok: false, error: '消息必须是 JSON' });
        return;
      }
      session.tell(msg);
    });
    socket.on('close', () => {
      if (system.resolve(session.path)) session.tell({ type: 'close' });
    });
    socket.on('error', () => {});
  });

  await server.listen();
  return {
    server,
    port: server.boundPort,
    secure: server.secure,
    roomFor: (playerId) => roomFor(playerId, roomCount, roomPrefix),
    async close() {
      await server.close();
    },
  };
}

/** Standalone mode: build a system with the cluster plugin and serve. */
async function main() {
  const secret = process.env.ACTOR_AUTH_SECRET;
  if (!secret) {
    console.error('需要 ACTOR_AUTH_SECRET（至少 16 字符）。生成一个：openssl rand -hex 24');
    process.exit(1);
  }
  const tokens = new TokenAuthority({ secret });
  const seeds = (process.env.SEEDS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const tls = process.env.WSS_TLS
    ? {
      key: fs.readFileSync(process.env.KEY || path.join(config.root, 'certs', 'server.key')),
      cert: fs.readFileSync(process.env.CERT || path.join(config.root, 'certs', 'server.crt')),
    }
    : null;

  const system = createSystem({
    name: process.env.NODE_ID || 'access-1',
    plugins: [
      plugins.cluster({
        host: config.gossip.host,
        advertiseHost: config.gossip.advertiseHost,
        port: config.gossip.port,
        seeds,
        tls: config.tls,
      }),
      plugins.tracing(),
      plugins.rateLimit({ capacity: 50, rate: 25 }),
      plugins.metrics({ exporter: { enabled: process.env.METRICS_PORT !== '0', host: '127.0.0.1', port: Number(process.env.METRICS_PORT || 9465) } }),
    ],
  });

  // 房间要把推送发到本节点的会话 Actor 上，所以接入层也要在网关上服务 Actor。
  // 生产里这个端口只应对集群内网开放（或直接开 mTLS）。
  await system.listen({ host: config.gateway.host, port: config.gateway.port, tls: config.tls });

  const access = await startAccessNode({ system, tokens });
  console.log(`接入层已启动：${access.secure ? 'wss' : 'ws'}://${process.env.WS_HOST || '127.0.0.1'}:${access.port}/game`);
  console.log('签发一个测试 token：');
  const { token, expiresAt } = tokens.issue({ playerId: process.env.DEMO_PLAYER || 'alice' });
  console.log(`  node examples/ws-client.js ws://127.0.0.1:${access.port}/game ${token}`);
  console.log(`  （过期时间 ${new Date(expiresAt).toISOString()}）`);

  const shutdown = async () => {
    await access.close();
    await system.stop();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((err) => {
    console.error('接入层启动失败:', err.message);
    process.exit(1);
  });
}

export { startAccessNode, makeSession, roomFor };
export default { startAccessNode, makeSession, roomFor };
