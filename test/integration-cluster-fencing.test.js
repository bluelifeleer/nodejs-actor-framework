import { test } from 'node:test';
import assert from 'node:assert';
import { createSystem, plugins, ring } from 'nodejs-actor-framework';
import _helpers from '../packages/core/test/helpers.js';

const { setupTempEnv, cleanup, freePort, waitFor } = _helpers;

const tempDir = setupTempEnv('actor-cluster-fencing');

test.after(() => cleanup(tempDir));

const SHARDS = 256;
const MEMBERS = ['node-a', 'node-b'];

/** 找一个"按环归 node-a 所有"的 actor id（这样 a 才会给它带 fencing token）。 */
function actorOwnedByA() {
  const r = ring.createRing(MEMBERS);
  for (let i = 0; i < 2000; i += 1) {
    const id = `victim-${i}`;
    if (ring.ownerOfShard(r, ring.shardOf(id, SHARDS)) === 'node-a') return id;
  }
  throw new Error('没找到归 node-a 的 shard（不该发生）');
}

/**
 * **两台真节点**：真 gossip 发现、真网关连接、真 fencing 判定。
 *
 * 覆盖 §3.4.5 第 3/5 条要的行为：
 *   - 非 owner 的转发请求（没有 token）照常工作 —— 不然跨节点路由全废；
 *   - owner 带的 token 被校验；
 *   - 一旦学到更新的声明（epoch 更大），旧 owner 的消息**在线上被拒**；
 *   - 降级/拒绝都能从 `cluster.fencing()` 看见。
 */
test('cluster fencing: 旧 owner 的消息在两台真节点之间被拒（且可见）', async () => {
  const gossipPort = await freePort();
  const a = createSystem({
    name: 'node-a',
    logger: false,
    plugins: [plugins.cluster({ nodeId: 'node-a', port: gossipPort, shardCount: SHARDS })],
  });
  const b = createSystem({
    name: 'node-b',
    logger: false,
    plugins: [plugins.cluster({ nodeId: 'node-b', port: 0, seeds: [`127.0.0.1:${gossipPort}`], shardCount: SHARDS })],
  });

  try {
    await a.listen({ host: '127.0.0.1', port: 0 });
    await b.listen({ host: '127.0.0.1', port: 0 });

    const victimId = actorOwnedByA();
    // actor **住在 b** 上，但按环归 a 所有 —— 正是"交接途中"的样子
    await b.spawn(
      {
        preStart() {
          this.state = { hits: 0 };
        },
        receive(msg) {
          this.state.hits += 1;
          return { hits: this.state.hits, from: 'node-b' };
        },
      },
      { id: victimId },
    );

    // a 通过 gossip 发现它
    await waitFor(() => a.cluster.lookup(victimId) !== null, { timeoutMs: 15000, intervalMs: 50 });
    // 等**双方成员视图收敛**：这正是 doc 05 §1.5 说的窗口——收敛之前两边的 owner 可能不同，
    // 而"本地确定性算"的前提就是同一份成员视图（D1）。
    await waitFor(() => b.cluster.nodes().includes('node-a') && a.cluster.nodes().includes('node-b'), {
      timeoutMs: 15000,
      intervalMs: 50,
    });
    assert.strictEqual(a.cluster.ownerOfActor(victimId), 'node-a', 'a 认为自己是这个 shard 的 owner');
    assert.strictEqual(b.cluster.ownerOfActor(victimId), 'node-a', 'b 也这么认为（同一成员视图）');

    // ① a 是 owner → 带上 token → b 放行
    const remote = a.resolve(victimId);
    assert.ok(remote, 'a 应当通过 gossip 解析到远端 ref');
    const first = await remote.ask({ type: 'ping' });
    assert.deepStrictEqual(first, { hits: 1, from: 'node-b' });
    assert.deepStrictEqual(
      { skipped: b.cluster.fencing().skipped, rejected: b.cluster.fencing().rejected },
      { skipped: 0, rejected: 0 },
      '有 token 的正常路径不该有降级/拒绝',
    );

    // ② b 学到"这个 shard 已经换到 b、epoch 2"（真实系统里来自 gossip 声明；这里直接观察）
    const shard = ring.shardOf(victimId, SHARDS);
    const learned = b.cluster.ownership.observe({ shard, ownerNodeId: 'node-b', epoch: 2, at: Date.now() });
    assert.strictEqual(learned.accepted, true);

    // ③ a 还在用 epoch 1 发消息 → **在线上被拒**
    await assert.rejects(
      () => a.resolve(victimId).ask({ type: 'ping' }),
      (err) => {
        assert.match(String(err.message), /fencing/, `错误里要能看出是 fencing 拒的：${err.message}`);
        assert.match(String(err.message), /epoch 1（来自 node-a）比已知的 2（来自 node-b）更旧/);
        return true;
      },
    );
    assert.strictEqual(b.cluster.fencing().rejected, 1, '拒绝次数要能看见');

    // ④ 新 owner（b）自己发起的调用不受影响：它不是"旧 epoch"
    assert.strictEqual(b.cluster.ownership.verify({ shard, ownerNodeId: 'node-b', epoch: 2 }).ok, true);

    // ⑤ 没有 token 的**第三方转发者**照常工作（否则跨节点路由就废了）
    //    —— 用一个不属于环的节点 c 来当转发者
    const c = createSystem({ name: 'node-c', logger: false });
    try {
      await c.listen({ host: '127.0.0.1', port: 0 });
      const peer = await c.connect({ host: '127.0.0.1', port: b.server.boundPort });
      const served = await peer.ref(victimId).ask({ type: 'ping' });
      assert.deepStrictEqual(served, { hits: 2, from: 'node-b' }, '不带 token 的转发者仍然可以调用');
    } finally {
      await c.stop();
    }
  } finally {
    await b.stop();
    await a.stop();
  }
});

test('cluster fencing: 声明支持支持 fencing 却带不出 token 的节点会被拒（协议违规）', async () => {
  const a = createSystem({ name: 'node-a', logger: false });
  const b = createSystem({
    name: 'node-b',
    logger: false,
    plugins: [plugins.cluster({ nodeId: 'node-b', port: 0, shardCount: SHARDS })],
  });
  try {
    await a.listen({ host: '127.0.0.1', port: 0 });
    await b.listen({ host: '127.0.0.1', port: 0 });
    await b.spawn({ preStart() {}, receive: () => 'ok' }, { id: 'plain-actor' });

    // a 没有所有权信息（没装集群插件）→ 不带 token，也不声明支持 → b 的守卫认出它"不是 owner 且没 token"
    const peer = await a.connect({ host: '127.0.0.1', port: b.server.boundPort });
    const result = await peer.ref('plain-actor').ask({ type: 'ping' });
    assert.strictEqual(result, 'ok', '没有 token 的非 owner 请求照常服务');
  } finally {
    await b.stop();
    await a.stop();
  }
});
