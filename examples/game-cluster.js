import path from 'node:path';
import { createSystem, plugins } from 'nodejs-actor-framework';
import _token from '../packages/core/src/ops/token.ts';
const { TokenAuthority } = _token;
import _access_node from './access-node.js';
const { startAccessNode, roomFor } = _access_node;
import _game_server from './game-server.js';
const { Room } = _game_server;
import fs from 'node:fs';

/**
 * 多节点房间分片演示：2 个 Actor 节点 + 1 个接入层（WSS + token 鉴权）。
 *
 *   node examples/game-cluster.js
 *   # 输出会打印可直接粘贴的客户端命令（含 token 与地址）
 *
 * 架构（都在一个进程里，方便演示；生产里每行一个进程/一台机器）：
 *
 *   ws-client ──token──▶ 接入层（access-node: WSS + 鉴权 + 一致性哈希选房间）
 *                            │  按房间名路由：ctx.ask('room-2', …)
 *                            │  cluster 插件负责"room-2 在哪台机器上"
 *                            ▼
 *        ┌─────────────── gossip（成员与 Actor 名册）────────────────┐
 *        ▼                                                          ▼
 *   Actor 节点 game-1（room-1、room-3…）                  Actor 节点 game-2（room-2、room-4…）
 *     └── 房间 Actor（父）+ 玩家 Actor（子，落库）            └── 同上
 *
 * 关键点：**接入层不需要知道房间在哪台机器上**。房间 Actor 启动时会通过 gossip 广播
 * "room-2 在 game-2 的 host:gatewayPort"，接入层的 `ctx.ask('room-2', …)` 就能命中远端。
 */







const NODES = Number(process.env.NODES || 2);
const ROOM_COUNT = Number(process.env.ROOM_COUNT || 4);
const SECRET = process.env.ACTOR_AUTH_SECRET || 'dev-secret-change-me-please-32chars';
const TLS_CERT = process.env.CERT || path.join(import.meta.dirname, '..', 'packages', 'core', 'test', 'fixtures', 'tls', 'node-1.crt');
const TLS_KEY = process.env.KEY || path.join(import.meta.dirname, '..', 'packages', 'core', 'test', 'fixtures', 'tls', 'node-1.key');
const USE_TLS = process.env.WSS_TLS !== '0'; // 默认开 WSS（把 WSS_TLS=0 关掉）

async function main() {
  const nodes = [];
  const gossipSeeds = [];

  for (let i = 1; i <= NODES; i += 1) {
    const name = `game-${i}`;
    const system = createSystem({
      name,
      persistenceDir: process.env.DATA_DIR ? path.join(process.env.DATA_DIR, name) : undefined,
      shutdownTimeoutMs: 3000,
      plugins: [
        plugins.cluster({
          host: '127.0.0.1',
          advertiseHost: '127.0.0.1',
          port: 0,
          seeds: [...gossipSeeds], // 第一个节点没有种子，后面的都指向它
          intervalMs: 200,
        }),
        plugins.tracing(),
        plugins.deadLetters(),
        plugins.rateLimit({ capacity: 100, rate: 50 }),
        plugins.metrics({ exporter: { enabled: true, host: '127.0.0.1', port: Number(process.env.METRICS_PORT || 9464) + i - 1 } }),
      ],
    });
    await system.init();
    if (gossipSeeds.length === 0) gossipSeeds.push({ host: '127.0.0.1', port: system.cluster.port });
    await system.listen({ host: '127.0.0.1', port: 0 });

    // worker 隔离的排行榜（每个节点一个）
    await system.spawn('./examples/actors/leaderboard.js', { id: 'leaderboard', isolation: 'worker' });
    system.game = { leaderboard: 'leaderboard' };

    // 房间分片：房间号 % NODES 决定它属于哪个节点
    const owned = [];
    for (let r = 1; r <= ROOM_COUNT; r += 1) {
      if ((r - 1) % NODES !== i - 1) continue;
      await system.spawn(Room, { id: `room-${r}`, persistence: { mode: 'snapshot' } });
      owned.push(`room-${r}`);
    }
    // 每个房间的 tick（驱动存档等周期逻辑）
    const ticker = setInterval(() => {
      for (const room of owned) {
        const ref = system.resolve(room);
        if (ref) ref.tell({ type: 'tick' });
      }
    }, 200);
    ticker.unref();

    nodes.push({ name, system, owned, port: system.port, gossip: system.cluster.port });
    console.log(`${name}: 网关 ${system.port}, gossip ${system.cluster.port}, 房间 ${owned.join(', ') || '(无)'}`);
  }

  // 接入层：一个 token 签发机构 + 一个系统（装了 cluster 才能发现远端房间）
  const tokens = new TokenAuthority({ secret: SECRET });
  const accessSystem = createSystem({
    name: 'access-1',
    plugins: [
      plugins.cluster({ host: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, seeds: [...gossipSeeds], intervalMs: 200 }),
      plugins.tracing(),
      plugins.rateLimit({ capacity: 50, rate: 25 }),
    ],
  });
  await accessSystem.init();
  // The access node must also serve actors on the gateway: the room pushes to
  // the *session* which lives here. Without this, sessions are announced
  // without a reachable gateway port and pushes fail with "not found".
  await accessSystem.listen({ host: '127.0.0.1', port: 0 });
  console.log(`access-1: 网关 ${accessSystem.port}（房间要把推送发到这里）`);

  const tls = USE_TLS
    ? { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }
    : null;
  const access = await startAccessNode({
    system: accessSystem,
    tokens,
    host: '127.0.0.1',
    port: Number(process.env.WS_PORT || 0),
    tls,
    roomCount: ROOM_COUNT,
  });

  const scheme = access.secure ? 'wss' : 'ws';
  const url = `${scheme}://127.0.0.1:${access.port}/game`;
  console.log(`\n接入层: ${url}${access.secure ? '（WSS，测试证书：客户端需 --insecure 或证书信任 packages/core/test/fixtures/tls/ca.crt）' : '（明文，仅限回环）'}`);
  console.log('房间路由（playerId → room）：');
  for (const playerId of ['alice', 'bob', 'carol']) {
    const room = roomFor(playerId, ROOM_COUNT, 'room');
    const owner = nodes.find((n) => n.owned.includes(room));
    console.log(`  ${playerId} → ${room}（在 ${owner ? owner.name : '?'} 上）  token=${tokens.issue({ playerId }).token}`);
  }
  const caHint = access.secure ? `CA=${path.join(import.meta.dirname, '..', 'packages', 'core', 'test', 'fixtures', 'tls', 'ca.crt')} ` : '';
  console.log(`\n客户端示例（默认校验证书；示例证书是自签的，所以要带上 CA）：`);
  console.log(`  ${caHint}node examples/ws-client.js ${url} <上面的 token>`);
  console.log(`  或本地偷懒：node examples/ws-client.js ${url} <token> --insecure`);
  console.log('  URL=' + url);
  console.log('  PORT=' + access.port);

  const shutdown = async () => {
    console.log('\n[signal] 正在关闭集群…');
    await access.close();
    await accessSystem.stop();
    for (const node of nodes) await node.system.stop();
    console.log('已全部关闭（玩家与房间状态已落库）');
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);

  // 让测试/脚本知道集群就绪：所有节点都互相发现即可
  if (process.env.WAIT_DISCOVERY === '1') {
    for (const room of ['room-1', 'room-2', 'room-3', 'room-4']) {
      if (room === 'room-1' && !nodes[0].owned.includes(room)) continue;
      try {
        await accessSystem.cluster.waitFor(room, 10000);
      } catch {
        /* 该房间可能不在任何节点上（ROOM_COUNT 小于节点数时） */
      }
    }
    console.log('READY=1');
  }
}

if (process.argv[1] === import.meta.filename) {
  main().catch((err) => {
    console.error('集群启动失败:', err);
    process.exit(1);
  });
}

export { main };
export default { main };
