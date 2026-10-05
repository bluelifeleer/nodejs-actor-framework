import { test } from 'node:test';
import assert from 'node:assert';
import { createSystem, plugins } from 'nodejs-actor-framework';
import _helpers from '../packages/core/test/helpers.js';

const { freePort, waitFor } = _helpers;

/**
 * 成员视图必须**收敛**（M4 的前提）。
 *
 * 这条曾经真的是坏的：gossip 只学"把消息发给我的人"，所以种在同一个节点上的 N 个节点
 * 永远只认识种子 —— B 看到 `[b, a]`、C 看到 `[c, a]`、A 看到 `[a, b, c]`。而所有权是
 * "成员视图的纯函数"（D1），视图不一致 ⇒ 三个节点算出三个不同的 owner ⇒ fencing 互相打架。
 * 修法是让一轮 gossip 带上**发送方已知的其它节点地址**（`peersJson`，字段 6，只追加）。
 */
test('cluster membership: 三个节点种在一起时，成员视图最终收敛到同一集合', async () => {
  const gossipPort = await freePort();
  const mk = (id, extra = {}) =>
    createSystem({
      name: id,
      logger: false,
      plugins: [plugins.cluster({ nodeId: id, port: 0, shardCount: 256, intervalMs: 100, ...extra })],
    });
  const a = mk('node-a', { port: gossipPort });
  const b = mk('node-b', { seeds: [`127.0.0.1:${gossipPort}`] });
  const c = mk('node-c', { seeds: [`127.0.0.1:${gossipPort}`] });

  try {
    for (const sys of [a, b, c]) await sys.listen({ host: '127.0.0.1', port: 0 });

    await waitFor(
      () => [a, b, c].every((sys) => sys.cluster.nodes().length === 3),
      { timeout: 20000, interval: 50, message: '三个节点互相认识' },
    );

    // 每个节点的成员集合必须**完全相同**（顺序无关）——所有权计算就靠这个
    const sets = [a, b, c].map((sys) => [...sys.cluster.nodes()].sort().join(','));
    assert.deepStrictEqual(sets, ['node-a,node-b,node-c', 'node-a,node-b,node-c', 'node-a,node-b,node-c']);

    // 而且各自都把对方**当作可拨号的 peer**（不只是"听说过"）：这是下一轮发现的基础
    for (const sys of [a, b, c]) {
      const peers = sys.cluster.peers();
      assert.strictEqual(peers.length, 2, `${sys.name} 应当有 2 个 peer，实际 ${peers.length}`);
      for (const peer of peers) assert.strictEqual(peer.failures, 0, `${sys.name} 的 peer 不应有失败拨号`);
    }
  } finally {
    for (const sys of [c, b, a]) await sys.stop();
  }
});
