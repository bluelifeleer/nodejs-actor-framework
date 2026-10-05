import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSystem, MemoryPersistence, plugins, ring } from 'nodejs-actor-framework';
import _helpers from '../packages/core/test/helpers.js';

const { freePort, waitFor } = _helpers;

const SHARDS = 256;
const MEMBERS = ['node-a', 'node-b', 'node-c'];

function actorOwnedBy(nodeId, members = MEMBERS) {
  const r = ring.createRing(members);
  for (let i = 0; i < 4000; i += 1) {
    const id = `mover-${i}`;
    if (ring.ownerOfShard(r, ring.shardOf(id, SHARDS)) === nodeId) return id;
  }
  throw new Error(`没找到归 ${nodeId} 的 shard`);
}

/** 三节点集群（真 gossip + 真网关），返回停机用的清理器。 */
async function withCluster(specs) {
  const gossipPort = await freePort();
  const systems = specs.map((spec) =>
    createSystem({
      name: spec.id,
      logger: false,
      plugins: [
        plugins.cluster({
          nodeId: spec.id,
          port: spec.seed ? 0 : gossipPort,
          shardCount: SHARDS,
          intervalMs: 100,
          peerTimeoutMs: spec.peerTimeoutMs || 1500,
          ...(spec.seed ? { seeds: [`127.0.0.1:${gossipPort}`] } : {}),
          ...(spec.cluster || {}),
        }),
      ],
    }),
  );
  for (const sys of systems) await sys.listen({ host: '127.0.0.1', port: 0 });
  return {
    systems,
    byId: Object.fromEntries(systems.map((sys, i) => [specs[i].id, sys])),
    async stop() {
      for (const sys of [...systems].reverse()) await sys.stop();
    },
  };
}

test('handover: 接管——新 owner 按定义重建 Actor，状态从共享存储恢复（不丢不重）', async () => {
  const sharedStore = new MemoryPersistence();
  const cluster = await withCluster([{ id: 'node-a' }, { id: 'node-b', seed: true }, { id: 'node-c', seed: true }]);
  const { byId } = cluster;
  const a = byId['node-a'];
  const c = byId['node-c'];

  try {
    await waitFor(() => cluster.systems.every((sys) => sys.cluster.nodes().length === 3), { timeout: 20000, interval: 50 });

    const actorId = actorOwnedBy('node-a');
    const definition = {
      preStart() {
        this.state = { hits: 0 };
      },
      receive() {
        this.state.hits += 1;
        return this.state.hits;
      },
    };
    await a.spawn(definition, { id: actorId, persistence: { mode: 'snapshot', store: sharedStore } });

    await waitFor(() => c.resolve(actorId) !== null, { timeout: 15000, interval: 50 });
    assert.strictEqual(await c.resolve(actorId).ask({ type: 'hit' }), 1, '先正常服务一次');

    // 让**每个**节点都知道"路径 → 定义"（真实系统里这是应用层的模块信息）
    for (const sys of cluster.systems) {
      sys.ownership.recreate = (actorPath) =>
        actorPath === actorId
          ? { definition, options: { persistence: { mode: 'snapshot', store: sharedStore } } }
          : null;
    }

    const summary = await a.cluster.drain({ timeoutMs: 2000 });
    const heirId = summary.shards.find((entry) => entry.shard === ring.shardOf(actorId, SHARDS)).to;
    assert.ok(['node-b', 'node-c'].includes(heirId));
    const heir = byId[heirId];

    // 新 owner 把 Actor 重建出来了（用同一个定义 + 同一份存储）
    await waitFor(() => heir.cells.has(actorId), { timeout: 20000, interval: 50 });
    assert.ok(heir.cluster.metrics().adoption.adopted >= 1, '接管计数可见');

    // ---- doc 06 的"无消息丢失"：接着上一次的状态继续，而不是从 0 重来、也不是重复处理 ----
    await waitFor(() => heir.resolve(actorId) !== null, { timeout: 15000, interval: 50 });
    const remote = c.resolve(actorId);
    assert.ok(remote, 'c 应当解析到新 owner 上的同一个 Actor');
    assert.strictEqual(await remote.ask({ type: 'hit' }), 2, '状态从共享存储恢复：1 之后是 2');

    // 旧 owner 已经彻底出局：即使有人直接连它，也只会得到"重定向"而不是被服务
    const direct = await c.connect({ host: '127.0.0.1', port: a.server.boundPort });
    await assert.rejects(
      () => direct.ref(actorId).ask({ type: 'hit' }),
      (err) => {
        assert.match(String(err.message), /正在离场/);
        return true;
      },
    );
  } finally {
    await cluster.stop();
  }
});

test('singleton: 全集群只有一个实例；owner 离场后由接任者接管（仍然只有一个）', async () => {
  const cluster = await withCluster([{ id: 'node-a' }, { id: 'node-b', seed: true }, { id: 'node-c', seed: true }]);
  const { byId } = cluster;
  try {
    await waitFor(() => cluster.systems.every((sys) => sys.cluster.nodes().length === 3), { timeout: 20000, interval: 50 });

    const definition = {
      preStart() {
        this.state = { ticks: 0 };
      },
      receive() {
        this.state.ticks += 1;
        return this.state.ticks;
      },
    };
    // 每个节点都登记（真实系统的启动流程就是这么写的）：只有 owner 真的运行
    const results = [];
    for (const sys of cluster.systems) results.push(await sys.cluster.spawnSingleton(definition, { id: 'leader' }));
    assert.strictEqual(results.filter((r) => r.local).length, 1, '全集群只有一个实例在跑');
    const firstOwner = results.find((r) => r.local).owner;

    let running = cluster.systems.filter((sys) => sys.cluster.singletons()[0].local);
    assert.strictEqual(running.length, 1, 'singletons() 也要如实报告只有一个是本地实例');

    // owner 优雅离场 → 接任者接管
    const ownerSystem = byId[firstOwner];
    await ownerSystem.cluster.drain({ timeoutMs: 2000 });
    // 等到"接力棒交到别人手里"（不能只看数量：离场方停掉之前也可能正好是 1 个）
    await waitFor(
      () => {
        const locals = cluster.systems.filter((sys) => sys.cluster.singletons()[0].local);
        return locals.length === 1 && locals[0].name !== firstOwner;
      },
      { timeout: 20000, interval: 50 },
    );
    running = cluster.systems.filter((sys) => sys.cluster.singletons()[0].local);
    assert.strictEqual(running.length, 1, '接管之后仍然只有一个');
    assert.notStrictEqual(running[0].name, firstOwner, '接任者是别的节点');
    assert.strictEqual(running[0].cluster.singletons()[0].local, true);
  } finally {
    await cluster.stop();
  }
});

test('quorum: 少数派拒绝写入（503 语义），多数派继续服务', async () => {
  const cluster = await withCluster([
    { id: 'node-a' },
    { id: 'node-b', seed: true },
    { id: 'node-c', seed: true, cluster: { enforceQuorum: true } },
  ]);
  const { byId } = cluster;
  const a = byId['node-a'];
  const b = byId['node-b'];
  const c = byId['node-c'];
  try {
    await waitFor(() => cluster.systems.every((sys) => sys.cluster.nodes().length === 3), { timeout: 20000, interval: 50 });
    assert.deepStrictEqual(c.cluster.quorum(), { live: 3, highWater: 3, ok: true }, '三人齐全时是多数派');

    // 一个"第三方"直接连 c（不参与 gossip，模拟分区外的客户端）
    const outsider = createSystem({ name: 'outsider', logger: false });
    await outsider.listen({ host: '127.0.0.1', port: 0 });
    try {
      await c.spawn({ preStart() {}, receive: () => 'ok' }, { id: 'guarded' });
      const peer = await outsider.connect({ host: '127.0.0.1', port: c.server.boundPort });
      assert.strictEqual(await peer.ref('guarded').ask({ type: 'ping' }), 'ok', '多数派时正常服务');

      // 把另外两个节点停掉 → c 变成少数派
      await b.stop();
      await a.stop();
      await waitFor(() => c.cluster.quorum().ok === false, { timeout: 15000, interval: 50 });
      const state = c.cluster.quorum();
      assert.strictEqual(state.live, 1, '只剩自己');
      assert.strictEqual(state.highWater, 3, '高水位记住了"我们曾经是 3 个"');
      assert.throws(() => c.cluster.assertWritable(), /少数派/);

      const second = await outsider.connect({ host: '127.0.0.1', port: c.server.boundPort });
      await assert.rejects(
        () => second.ref('guarded').ask({ type: 'ping' }),
        (err) => {
          assert.match(String(err.message), /quorum：本节点处于少数派/);
          assert.match(String(err.message), /503|重试/, '要给出可重试的语义，而不是含糊的失败');
          return true;
        },
        '少数派必须拒写（宁可拒绝，也不要在可能双主的情况下继续接受写入）',
      );
    } finally {
      await outsider.stop();
    }
  } finally {
    await cluster.stop();
  }
});

test('transferable: 声明不可迁移的 Actor 在离场时**明确失败**，并且不会被接管', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-cluster-untransferable-'));
  const sharedStore = new MemoryPersistence();
  const cluster = await withCluster([{ id: 'node-a' }, { id: 'node-b', seed: true }, { id: 'node-c', seed: true }]);
  const { byId } = cluster;
  const a = byId['node-a'];
  try {
    await waitFor(() => cluster.systems.every((sys) => sys.cluster.nodes().length === 3), { timeout: 20000, interval: 50 });

    // 找**两个**都归 node-a 的路径：一个可迁移（会被接管），一个声明不可迁移（谁也别想接）
    const r = ring.createRing(MEMBERS);
    const ownedByA = [];
    for (let i = 0; i < 4000 && ownedByA.length < 2; i += 1) {
      const id = `mover-${i}`;
      if (ring.ownerOfShard(r, ring.shardOf(id, SHARDS)) === 'node-a') ownedByA.push(id);
    }
    const [movableId, stubbornId] = ownedByA;
    await a.spawn({ preStart() {}, receive: () => 'ok' }, { id: movableId, persistence: { mode: 'snapshot', store: sharedStore } });
    await a.spawn({ preStart() {}, receive: () => 'ok' }, { id: stubbornId, transferable: false });

    for (const sys of cluster.systems) {
      sys.ownership.recreate = (actorPath) =>
        actorPath === movableId
          ? {
              definition: { preStart() {}, receive: () => 'ok' },
              options: { persistence: { mode: 'snapshot', store: sharedStore } },
            }
          : null; // 不可迁移的那个没有定义可重建（就算有也不该被接）
    }

    const summary = await a.cluster.drain({ timeoutMs: 2000 });
    assert.deepStrictEqual(summary.untransferable, [stubbornId], '不可迁移的要被明确列出来');
    assert.ok(!summary.actors.includes(stubbornId), '不给它存快照（存了也没人能恢复 socket）');

    // 接管方不会去碰它（注册表里带着 transferable: false）
    const skippedTotal = cluster.systems.reduce((sum, sys) => sum + (sys.cluster.metrics().adoption.skipped || 0), 0);
    await waitFor(() => skippedTotal > 0 || cluster.systems.some((sys) => sys.cluster.metrics().adoption.skipped > 0), {
      timeout: 15000,
      interval: 50,
    });
    for (const sys of cluster.systems) {
      assert.strictEqual(sys.cells.has(stubbornId), false, '没人假装能接管它');
    }
  } finally {
    await cluster.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics: 所有权/降级/接管/单例/多数派能在一处读到（第 6 步）', async () => {
  const cluster = await withCluster([{ id: 'node-a' }, { id: 'node-b', seed: true }]);
  const a = cluster.byId['node-a'];
  try {
    await waitFor(() => a.cluster.nodes().length === 2, { timeout: 15000, interval: 50 });
    const metrics = a.cluster.metrics();
    assert.deepStrictEqual(Object.keys(metrics).sort(), ['adoption', 'fencing', 'ownership', 'quorum', 'singletons']);
    assert.deepStrictEqual(Object.keys(metrics.fencing).sort(), [
      'conflicts',
      'handedOver',
      'promoted',
      'rejected',
      'skipped',
    ]);
    assert.strictEqual(metrics.ownership.shards, SHARDS);
    assert.ok(metrics.ownership.owned > 0 && metrics.ownership.owned < SHARDS, '两个节点时大致一半');
    assert.deepStrictEqual(metrics.quorum, { live: 2, highWater: 2, ok: true });
  } finally {
    await cluster.stop();
  }
});
