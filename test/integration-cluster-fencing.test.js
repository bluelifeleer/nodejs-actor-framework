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
    await waitFor(() => a.cluster.lookup(victimId) !== null, { timeout: 15000, interval: 50 });
    // 等**双方成员视图收敛**：这正是 doc 05 §1.5 说的窗口——收敛之前两边的 owner 可能不同，
    // 而"本地确定性算"的前提就是同一份成员视图（D1）。
    await waitFor(() => b.cluster.nodes().includes('node-a') && a.cluster.nodes().includes('node-b'), {
      timeout: 15000,
      interval: 50,
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

    // ② a 的声明**经 gossip 自动传播**到 b（不是测试手工塞进去的）
    const shard = ring.shardOf(victimId, SHARDS);
    await waitFor(
      () => {
        const claim = b.cluster.ownership.bestClaim(shard);
        return claim !== null && claim.ownerNodeId === 'node-a' && claim.epoch >= 1;
      },
      { timeout: 15000, interval: 50 },
    );
    assert.strictEqual(b.cluster.ownership.bestClaim(shard).ownerNodeId, 'node-a', 'b 学到了 a 的声明');

    // 声明是"每节点一条"的映射，而不是"每 shard 一条"：注册表不该因为声明而膨胀
    const registrySize = b.cluster.gossip.info().registrySize;
    assert.ok(registrySize < 20, `注册表条目应当很少（实际 ${registrySize}）——声明走每节点一条映射`);

    // ③ b 学到"这个 shard 已经换到 b、epoch 2"（真实系统里这就是交接的 epoch+1）
    const learned = b.cluster.ownership.observe({ shard, ownerNodeId: 'node-b', epoch: 2, at: Date.now() });
    assert.strictEqual(learned.accepted, true);

    // ④ a 还在用 epoch 1 发消息 → **在线上被拒**
    await assert.rejects(
      () => a.resolve(victimId).ask({ type: 'ping' }),
      (err) => {
        assert.match(String(err.message), /fencing/, `错误里要能看出是 fencing 拒的：${err.message}`);
        assert.match(String(err.message), /epoch 1（来自 node-a）比已知的 2（来自 node-b）更旧/);
        return true;
      },
    );
    assert.strictEqual(b.cluster.fencing().rejected, 1, '拒绝次数要能看见');

    // ⑤ 新 owner（b）自己发起的调用不受影响：它不是"旧 epoch"
    assert.strictEqual(b.cluster.ownership.verify({ shard, ownerNodeId: 'node-b', epoch: 2 }).ok, true);

    // ⑥ 没有 token 的**第三方转发者**照常工作（否则跨节点路由就废了）
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

test('cluster fencing: 跨版本——老节点（不带 token、不声明能力）照常服务，但降级必须可见', async () => {
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

    // a 没有所有权信息（没装集群插件）→ 不带 token，也不声明支持 —— 这就是"老节点/未升级节点"的形态
    const peer = await a.connect({ host: '127.0.0.1', port: b.server.boundPort });
    const result = await peer.ref('plain-actor').ask({ type: 'ping' });
    assert.strictEqual(result, 'ok', '软升级：老节点照常服务（不能因为升级就把老节点踢出去）');
    assert.strictEqual(b.cluster.fencing().skipped, 1, '但降级**必须可见**：计数 +1');
    assert.strictEqual(b.cluster.fencing().rejected, 0, '这不是拒绝，是降级');
  } finally {
    await b.stop();
    await a.stop();
  }
});

test('cluster fencing: 双主声明经 gossip 传播 → 被拒并报出来（不静默覆盖）', async () => {
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

    // a 发布一条声明：shard 7 的 epoch 3 属于 node-a
    a.cluster.gossip.setLocal('shard-claims:node-a', {
      type: 'shard-claims',
      nodeId: 'node-a',
      claims: { 7: 3 },
      ts: Date.now(),
    });
    await waitFor(() => b.cluster.ownership.bestClaim(7)?.ownerNodeId === 'node-a', {
      timeout: 15000,
      interval: 50,
    });

    // a 又发布"同 epoch，但 owner 换成 node-b"——这正是双主的形状（且 ts 更新，LWW 会覆盖）
    a.cluster.gossip.setLocal('shard-claims:node-a', {
      type: 'shard-claims',
      nodeId: 'node-b',
      claims: { 7: 3 },
      ts: Date.now() + 1,
    });
    await waitFor(() => b.cluster.fencing().conflicts === 1, { timeout: 15000, interval: 50 });

    assert.strictEqual(
      b.cluster.ownership.bestClaim(7).ownerNodeId,
      'node-a',
      '冲突被拒之后，已知声明不能被静默覆盖',
    );
  } finally {
    await b.stop();
    await a.stop();
  }
});

/** 找一个"按环归指定节点"的 actor id。 */
function actorOwnedBy(nodeId, memberIds) {
  const r = ring.createRing(memberIds);
  for (let i = 0; i < 4000; i += 1) {
    const id = `mover-${i}`;
    if (ring.ownerOfShard(r, ring.shardOf(id, SHARDS)) === nodeId) return id;
  }
  throw new Error(`没找到归 ${nodeId} 的 shard`);
}

test('cluster handover: 节点优雅离场——冻结/重定向、新 owner 自动加代、状态落盘后释放', async () => {
  const { MemoryPersistence } = await import('nodejs-actor-framework');
  const sharedStore = new MemoryPersistence(); // 共享存储：交接靠它转移状态（D3）
  const gossipPort = await freePort();
  const mkSystem = (id, extra = {}) =>
    createSystem({
      name: id,
      logger: false,
      plugins: [plugins.cluster({ nodeId: id, port: 0, shardCount: SHARDS, intervalMs: 100, ...extra })],
    });

  const a = mkSystem('node-a', { port: gossipPort });
  const b = mkSystem('node-b', { seeds: [`127.0.0.1:${gossipPort}`] });
  const c = mkSystem('node-c', { seeds: [`127.0.0.1:${gossipPort}`] });

  try {
    for (const sys of [a, b, c]) await sys.listen({ host: '127.0.0.1', port: 0 });
    const members = ['node-a', 'node-b', 'node-c'];
    await waitFor(() => [a, b, c].every((s) => s.cluster.nodes().length === 3), { timeout: 20000, interval: 50 });

    const actorId = actorOwnedBy('node-a', members);
    const shard = ring.shardOf(actorId, SHARDS);
    await a.spawn(
      {
        preStart() {
          this.state = { hits: 0 };
        },
        receive() {
          this.state.hits += 1;
          return this.state.hits;
        },
      },
      { id: actorId, persistence: { mode: 'snapshot', store: sharedStore } },
    );

    // 先正常服务一次（会发布 a 的声明并让状态变脏）
    await waitFor(() => c.resolve(actorId) !== null, { timeout: 15000, interval: 50 });
    const remote = c.resolve(actorId);
    assert.ok(remote, 'c 应当能解析到 a 上的 Actor');
    assert.strictEqual(await remote.ask({ type: 'hit' }), 1);
    await waitFor(() => c.cluster.ownership.bestClaim(shard)?.ownerNodeId === 'node-a', {
      timeout: 15000,
      interval: 50,
    });
    const epochBefore = c.cluster.ownership.bestClaim(shard).epoch;

    // ---- 优雅离场 ----
    const summary = await a.cluster.drain({ timeoutMs: 2000 });
    assert.strictEqual(summary.nodeId, 'node-a');
    assert.ok(summary.shards.length > 0, '应当交出它拥有的 shard');
    const moved = summary.shards.find((entry) => entry.shard === shard);
    assert.ok(moved, `shard ${shard} 应当在交接清单里`);
    assert.ok(['node-b', 'node-c'].includes(moved.to), `应当交给 b 或 c，实际 ${moved.to}`);
    assert.strictEqual(summary.timedOut, false, '没有超时的排空');
    assert.deepStrictEqual(summary.actors, [actorId], '离场前给这个 Actor 存了快照');
    assert.strictEqual(a.cluster.fencing().handedOver, true);

    // 状态确实落盘了（新 owner 靠它恢复）
    const snapshot = await sharedStore.loadSnapshot(actorId);
    assert.ok(snapshot !== undefined && snapshot !== null, '快照必须落盘（否则"状态转移"就是空话）');

    // 本节点已经释放：本地不再有它
    assert.strictEqual(a.resolve(actorId), null, '离场后本地 Actor 已释放');

    // 新 owner 自动加代：epoch 变大，且它自己成为声明者
    const heir = moved.to === 'node-b' ? b : c;
    await waitFor(() => heir.cluster.ownership.bestClaim(shard)?.epoch >= epochBefore + 1, {
      timeout: 20000,
      interval: 50,
    });
    assert.strictEqual(heir.cluster.ownership.bestClaim(shard).ownerNodeId, moved.to, '新 owner 自己声明');
    assert.ok(heir.cluster.fencing().promoted > 0, '接管计数可见');

    // 冻结：离场节点不再服务这些 shard，但给出的是**重定向**而不是静默丢弃
    const toA = await c.connect({ host: '127.0.0.1', port: a.server.boundPort });
    await assert.rejects(
      () => toA.ref(actorId).ask({ type: 'hit' }),
      (err) => {
        assert.match(String(err.message), /正在离场/, `要给出去哪儿的提示：${err.message}`);
        assert.match(String(err.message), new RegExp(moved.to));
        return true;
      },
    );
  } finally {
    for (const sys of [c, b, a]) await sys.stop();
  }
});
