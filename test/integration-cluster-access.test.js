import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import _helpers from '../packages/core/test/helpers.js';
const { setupTempEnv, cleanup, waitFor } = _helpers;
// 审计说明：ws-server/token 不在内核公开面，刻意深引用（本用例测的是接入层参考实现）
import _ws_server from '../packages/core/src/ops/ws-server.ts';
const { connect } = _ws_server;
import _token from '../packages/core/src/ops/token.ts';
const { TokenAuthority } = _token;
import _access_node from '../examples/access-node.js';
const { roomFor } = _access_node;

/**
 * 接入层 + 集群分片的端到端测试：真子进程、真 WSS、真 token 校验、真跨节点路由。
 *
 * 覆盖 examples/game-cluster.js + examples/access-node.js 的关键行为：
 *   - 无 token / 伪造 token 的连接在握手阶段就被拒；
 *   - playerId 来自 token，客户端传的 playerId 被忽略；
 *   - 一致性哈希把玩家分到不同房间，房间分布在不同节点上（跨节点路由）；
 *   - 房间能把推送发回接入层的会话（跨节点回信）；
 *   - 明文绑定非回环地址会被拒绝（安全默认）。
 */











const tempDir = setupTempEnv('actor-cluster-access');
const LAUNCHER = path.join(import.meta.dirname, '..', 'examples', 'game-cluster.js');
const CA = path.join(import.meta.dirname, '..', 'packages', 'core', 'test', 'fixtures', 'tls', 'ca.crt');
const SECRET = 'integration-secret-long-enough';

test.after(() => cleanup(tempDir));

const tlsOptions = () => ({ ca: fs.readFileSync(CA) });

/** Start the demo cluster and parse the URL + issued tokens from its output. */
async function startCluster() {
  const proc = spawn(process.execPath, [LAUNCHER], {
    env: {
      ...process.env,
      ACTOR_AUTH_SECRET: SECRET,
      ROOM_COUNT: '4',
      NODES: '2',
      DATA_DIR: path.join(tempDir, `run-${Date.now()}`),
      WAIT_DISCOVERY: '1',
      METRICS_PORT: '19464',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (c) => {
    output += c.toString();
  });
  proc.stderr.on('data', (c) => {
    output += c.toString();
  });

  await waitFor(() => /READY=1/.test(output), {
    message: 'the demo cluster to become ready',
    timeout: 30000,
  }).catch((err) => {
    proc.kill('SIGKILL');
    throw new Error(`${err.message}\n--- cluster output ---\n${output}`);
  });

  const url = /URL=(\S+)/.exec(output)[1];
  const tokens = {};
  for (const match of output.matchAll(/(\w+) → ([\w-]+)（在 ([\w-]+) 上）\s+token=(\S+)/g)) {
    tokens[match[1]] = { token: match[4], room: match[2], node: match[3] };
  }
  const accessGateway = /access-1: 网关 (\d+)/.exec(output);

  return {
    proc,
    url,
    tokens,
    accessGatewayPort: accessGateway ? Number(accessGateway[1]) : null,
    output: () => output,
    async stop() {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill('SIGTERM');
      await exited;
      return output;
    },
  };
}

/** Minimal client with a request/response helper that skips pushes. */
async function wsClient(url, token) {
  const connection = await connect(url, {
    headers: { authorization: `Bearer ${token}` },
    tls: tlsOptions(),
  });
  const inbox = [];
  const pushes = [];
  connection.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.push) pushes.push(msg);
    else inbox.push(msg);
  });
  return {
    connection,
    pushes,
    async call(obj, timeoutMs = 8000) {
      connection.sendJson(obj);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (inbox.length > 0) return inbox.shift();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no reply for ${JSON.stringify(obj)}`);
    },
    close: () => connection.close(1000, 'done'),
  };
}

test('cluster+access: token auth, playerId from the token, and cross-node routing', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  // 1) Handshake rejected without a token and with a forged one.
  await assert.rejects(() => connect(cluster.url, { tls: tlsOptions() }), /401|refused/);
  await assert.rejects(
    () => connect(cluster.url, { tls: tlsOptions(), headers: { authorization: 'Bearer forged.token' } }),
    /401|refused/,
  );

  // An expired token is rejected too. It must be *well* in the past: the server
  // tolerates 5s of clock skew, so a token that expired 10ms ago is still valid.
  const expired = new TokenAuthority({ secret: SECRET, ttlMs: -60000 }).issue({ playerId: 'alice' }).token;
  await assert.rejects(
    () => connect(cluster.url, { tls: tlsOptions(), headers: { authorization: `Bearer ${expired}` } }),
    /401|refused/,
  );

  // 2) Two players, routed by the access node's hash to different rooms/nodes.
  assert.notStrictEqual(cluster.tokens.alice.room, cluster.tokens.bob.room, 'the demo spreads players');
  const alice = await wsClient(cluster.url, cluster.tokens.alice.token);
  const bob = await wsClient(cluster.url, cluster.tokens.bob.token);
  t.after(() => {
    alice.close();
    bob.close();
  });

  const aliceJoin = await alice.call({ cmd: 'join' });
  assert.strictEqual(aliceJoin.ok, true);
  assert.strictEqual(aliceJoin.player, 'alice');
  assert.strictEqual(aliceJoin.room, cluster.tokens.alice.room);

  const bobJoin = await bob.call({ cmd: 'join' });
  assert.strictEqual(bobJoin.player, 'bob');

  // The two rooms must be served by different actor nodes.
  const aliceRoom = await alice.call({ cmd: 'room' });
  const bobRoom = await bob.call({ cmd: 'room' });
  assert.strictEqual(aliceRoom.result.node, cluster.tokens.alice.node);
  assert.strictEqual(bobRoom.result.node, cluster.tokens.bob.node);
  assert.notStrictEqual(aliceRoom.result.node, bobRoom.result.node, 'rooms are sharded across nodes');

  // 3) The client's own playerId is ignored: identity comes from the token.
  await alice.call({ cmd: 'hit', damage: 25 });
  const forged = await alice.call({ cmd: 'stats', playerId: 'bob' });
  assert.strictEqual(forged.player, 'alice');
  assert.strictEqual(forged.result.hp, 75, 'alice was damaged, bob was not');
  assert.strictEqual(forged.result.playerId, 'alice');

  // bob is untouched by alice's actions.
  const bobStats = await bob.call({ cmd: 'stats' });
  assert.strictEqual(bobStats.result.hp, 100);
});

test('cluster+access: a room pushes back to a session on another node', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const alice = await wsClient(cluster.url, cluster.tokens.alice.token);
  t.after(() => alice.close());
  await alice.call({ cmd: 'join' });

  const chat = await alice.call({ cmd: 'chat', text: 'gg' });
  assert.strictEqual(chat.ok, true);
  assert.strictEqual(chat.result.delivered, 1, 'the room found the session and pushed to it');

  // The push travels room(node A) → session(access node) → this socket.
  await waitFor(() => alice.pushes.length > 0, { message: 'the cross-node push to arrive', timeout: 5000 });
  assert.deepStrictEqual(alice.pushes[0].push, 'event');
  assert.match(alice.pushes[0].text, /\[聊天\] gg/);
  assert.strictEqual(alice.pushes[0].from, 'alice');
});

test('cluster+access: an actor that is not on any node is reported, not hung', async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  const alice = await wsClient(cluster.url, cluster.tokens.alice.token);
  t.after(() => alice.close());

  // A room outside the configured hash range does not exist anywhere.
  const missing = await alice.call({ cmd: 'stats', playerId: 'ghost' });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /not found|不在房间|no actor registered/i);

  // Unknown commands are reported too, and the connection stays usable.
  const unknown = await alice.call({ cmd: 'explode' });
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.error, /unknown command/);
  const stillAlive = await alice.call({ cmd: 'join' });
  assert.strictEqual(stillAlive.ok, true);
});

test('access layer: plaintext on a non-loopback host is refused', () => {
  const { startAccessNode } = _access_node;
  const tokens = new TokenAuthority({ secret: 'refusal-test-secret-long-enough' });
  const fakeSystem = { emit() {}, spawn() {}, resolve: () => null };
  assert.rejects(
    () => startAccessNode({ system: fakeSystem, tokens, host: '0.0.0.0', port: 0, tls: null }),
    /refusing to serve plaintext WebSocket/,
  );
});

test('access layer: roomFor is a stable, evenly spread hash', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `player-${i}`);
  const rooms = new Set(ids.map((id) => roomFor(id, 4, 'room')));
  assert.deepStrictEqual([...rooms].sort(), ['room-1', 'room-2', 'room-3', 'room-4']);
  // Same input, same room — otherwise a player would land in a random room.
  assert.strictEqual(roomFor('alice', 4, 'room'), roomFor('alice', 4, 'room'));
  // Distribution sanity: no bucket should be wildly over/under-filled.
  const counts = {};
  for (const id of ids) {
    const room = roomFor(id, 4, 'room');
    counts[room] = (counts[room] || 0) + 1;
  }
  for (const count of Object.values(counts)) {
    assert.ok(count > 20 && count < 80, `bucket sizes should be roughly even, got ${JSON.stringify(counts)}`);
  }
});
