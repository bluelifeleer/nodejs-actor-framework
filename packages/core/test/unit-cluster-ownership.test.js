'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createOwnershipGuard } = require('../src/cluster/ownership.ts');
const { ownerOfShard, createRing } = require('../src/cluster/ring.ts');

const SHARDS = 16;

/** 找到某个成员在给定环上拥有的一个 shard（测试里要"真实存在"的 shard）。 */
function aShardOwnedBy(members, nodeId) {
  const ring = createRing(members);
  for (let shard = 0; shard < SHARDS; shard += 1) if (ownerOfShard(ring, shard) === nodeId) return shard;
  throw new Error(`${nodeId} 在这个环上没有任何 shard`);
}

test('ownership: 只有环上的 owner 才会声明自己（**不自封**）', () => {
  const guard = createOwnershipGuard({ nodeId: 'node-a', shardCount: SHARDS });
  assert.strictEqual(guard.claimFor(0), null, '还没有成员视图时不该声明任何 shard');

  guard.updateRing(['node-a', 'node-b']);
  const mine = aShardOwnedBy(['node-a', 'node-b'], 'node-a');
  const theirs = aShardOwnedBy(['node-a', 'node-b'], 'node-b');

  const claim = guard.claimFor(mine);
  assert.deepStrictEqual(
    { shard: claim.shard, ownerNodeId: claim.ownerNodeId, epoch: claim.epoch },
    { shard: mine, ownerNodeId: 'node-a', epoch: 1 },
  );
  assert.strictEqual(guard.claimFor(theirs), null, '不是自己的 shard 不声明');
  assert.deepStrictEqual(guard.stats(), { nodeId: 'node-a', shards: SHARDS, owned: guard.stats().owned, claims: 1 });
});

test('ownership: observe —— 更高 epoch 换代；同 epoch 换人 = 双主声明（拒绝并报出来）', () => {
  const guard = createOwnershipGuard({ nodeId: 'observer', shardCount: SHARDS });

  assert.strictEqual(guard.observe({ shard: 3, ownerNodeId: 'a', epoch: 1, at: 1 }).accepted, true);
  assert.strictEqual(guard.observe({ shard: 3, ownerNodeId: 'a', epoch: 1, at: 2 }).accepted, false, '幂等重复不算接受');
  assert.strictEqual(guard.observe({ shard: 3, ownerNodeId: 'b', epoch: 1, at: 3 }).accepted, false, '同 epoch 换人必须拒绝');
  assert.match(
    guard.observe({ shard: 3, ownerNodeId: 'b', epoch: 1, at: 4 }).reason,
    /双主声明：shard 3 的 epoch 1 已属于 a/,
  );

  const upgraded = guard.observe({ shard: 3, ownerNodeId: 'b', epoch: 2, at: 5 });
  assert.strictEqual(upgraded.accepted, true, '更高 epoch 才是合法换代');
  assert.deepStrictEqual(guard.bestClaim(3).ownerNodeId, 'b');

  assert.strictEqual(guard.observe({ shard: 3, ownerNodeId: 'a', epoch: 1, at: 6 }).accepted, false, '旧声明被忽略');

  assert.throws(() => guard.observe({ shard: -1, ownerNodeId: 'a', epoch: 1, at: 1 }), /shard 必须是 >= 0/);
  assert.throws(() => guard.observe({ shard: 1, ownerNodeId: '', epoch: 1, at: 1 }), /ownerNodeId 必须是非空/);
  assert.throws(() => guard.observe({ shard: 1, ownerNodeId: 'a', epoch: 0, at: 1 }), /epoch 必须是 >= 1/);
});

test('ownership: verify —— 旧 owner（旧 epoch）必须被拒（这就是 fencing）', () => {
  const shard = aShardOwnedBy(['a', 'b'], 'a');
  const guard = createOwnershipGuard({ nodeId: 'observer', shardCount: SHARDS });
  guard.updateRing(['a', 'b', 'c']); // 视图里 a 不再是这个 shard 的 owner（c 进来了）

  // a 曾经拥有这个 shard（epoch 1），后来换给了别人（epoch 2）
  guard.observe({ shard, ownerNodeId: 'a', epoch: 1, at: 1 });
  guard.observe({ shard, ownerNodeId: 'b', epoch: 2, at: 2 });

  const stale = guard.verify({ shard, ownerNodeId: 'a', epoch: 1 });
  assert.strictEqual(stale.ok, false, '旧 owner 用旧 epoch 发消息必须被拒');
  assert.match(stale.reason, /epoch 1（来自 a）比已知的 2（来自 b）更旧/);

  const current = guard.verify({ shard, ownerNodeId: 'b', epoch: 2 });
  assert.strictEqual(current.ok, true, '当前 owner 的当前 epoch 通过');

  const spoof = guard.verify({ shard, ownerNodeId: 'c', epoch: 2 });
  assert.strictEqual(spoof.ok, false, '同一个 epoch 换个人也必须拒');
  assert.match(spoof.reason, /epoch 2 已被 b 声明/);
});

test('ownership: verify —— 没有声明时按本地环判断；有更新的声明时接受并学习（视图落后的一侧）', () => {
  const guard = createOwnershipGuard({ nodeId: 'observer', shardCount: SHARDS });
  guard.updateRing(['a', 'b']);
  const shard = aShardOwnedBy(['a', 'b'], 'a');

  // 没有声明：按环判断
  assert.strictEqual(guard.verify({ shard, ownerNodeId: 'a', epoch: 1 }).ok, true);
  const notOwner = guard.verify({ shard, ownerNodeId: 'b', epoch: 1 });
  assert.strictEqual(notOwner.ok, false);
  assert.match(notOwner.reason, /在本地环上的 owner 是 a，不是 b/);

  // 环上还是 a，但学习到 b 用更高 epoch 接管了（本节点视图落后）：接受并学习
  guard.observe({ shard, ownerNodeId: 'b', epoch: 2, at: 2 });
  assert.strictEqual(guard.verify({ shard, ownerNodeId: 'b', epoch: 2 }).ok, true);
  assert.strictEqual(guard.verify({ shard, ownerNodeId: 'a', epoch: 1 }).ok, false, '旧 owner 同时被声明与 epoch 挡住');
});

test('ownership: **挡不住的**——双方视图都还没更新时，本地认不出旧 owner（如实记录，不夸大）', () => {
  // 两个节点都还认为 a 是 owner、epoch 也还是 1（没有任何更新的声明被观察到）
  const guard = createOwnershipGuard({ nodeId: 'observer', shardCount: SHARDS });
  guard.updateRing(['a', 'b']);
  const shard = aShardOwnedBy(['a', 'b'], 'a');

  // a 其实已经被换掉了，但本节点既没更新成员视图、也没收到新声明
  const result = guard.verify({ shard, ownerNodeId: 'a', epoch: 1 });
  assert.strictEqual(result.ok, true, '本地信息不足时只能放行——这是 gossip 未收敛的窗口');
  // 所以 fencing 的作用是**收窄**窗口，不是消灭它；消灭它需要共识（doc 06 明确不做 Raft）
});

test('ownership: 没有成员视图时一律拒绝（宁可拒绝，也不要在"不知道谁拥有"时放行）', () => {
  const guard = createOwnershipGuard({ nodeId: 'observer', shardCount: SHARDS });
  const result = guard.verify({ shard: 0, ownerNodeId: 'a', epoch: 1 });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /还没有成员视图/);
});

test('ownership: 入参校验与 stats', () => {
  assert.throws(() => createOwnershipGuard({ nodeId: '', shardCount: 4 }), /需要 nodeId/);
  assert.throws(() => createOwnershipGuard({ nodeId: 'a', shardCount: 0 }), /shardCount 必须是 >= 1/);

  const guard = createOwnershipGuard({ nodeId: 'a', shardCount: 4, now: () => 12345 });
  guard.updateRing(['a']);
  const claim = guard.claimFor(0);
  assert.strictEqual(claim.at, 12345, '时钟可注入（now）');
  assert.strictEqual(guard.ownsShard(0), true);
  assert.strictEqual(guard.verify({ shard: 0, ownerNodeId: 'a', epoch: 1 }).ok, true);
  assert.strictEqual(guard.verify({ shard: 0, ownerNodeId: 'a', epoch: 0 }).ok, false, 'epoch 必须 >= 1');

  assert.deepStrictEqual(guard.claims().map((c) => c.shard), [...new Set(guard.claims().map((c) => c.shard))]);
});
