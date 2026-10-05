'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createRing,
  ownerOf,
  ownerOfShard,
  shardOf,
  shardOwners,
  changedShards,
  migrationRatio,
  moduloMigrationRatio,
  DEFAULT_VIRTUAL_NODES,
} = require('../src/cluster/ring.ts');

const SHARDS = 256;
const members = ['node-a', 'node-b', 'node-c'];

test('ring: 确定性——成员集合相同就得到同一个环（与传入顺序无关）', () => {
  const a = createRing(members);
  const b = createRing([...members].reverse());
  assert.deepStrictEqual(a.tokens, b.tokens);
  assert.deepStrictEqual(shardOwners(a, SHARDS), shardOwners(b, SHARDS));

  // 重复成员被忽略；空串被忽略
  assert.deepStrictEqual(createRing(['a', 'a', '', 'b']).tokens, createRing(['a', 'b']).tokens);
  assert.strictEqual(a.virtualNodes, DEFAULT_VIRTUAL_NODES);
});

test('ring: tokens 按 (token, nodeId) 升序 —— 顺序是环语义的一部分', () => {
  const ring = createRing(['x', 'y'], { virtualNodes: 8 });
  for (let i = 1; i < ring.tokens.length; i += 1) {
    const previous = ring.tokens[i - 1];
    const current = ring.tokens[i];
    assert.ok(
      previous.token < current.token || (previous.token === current.token && previous.nodeId <= current.nodeId),
      `第 ${i} 个 token 破坏排序不变量`,
    );
  }
});

test('ring: 同一成员视图下，所有节点算出同一 owner（这是"所有权不需要共识"的前提）', () => {
  // 两个"节点"各自本地算环（拿到的是同一份成员视图，只是顺序不同）
  const onA = createRing(['node-a', 'node-b', 'node-c']);
  const onB = createRing(['node-c', 'node-a', 'node-b']);
  for (const path of ['room-1', 'room-2', 'player_007', '/user/order-42']) {
    const shard = shardOf(path, SHARDS);
    assert.strictEqual(ownerOfShard(onA, shard), ownerOfShard(onB, shard), `${path} 的 owner 必须一致`);
  }
  // 同一个 key 反复算结果稳定
  assert.strictEqual(ownerOf(onA, 'stable-key'), ownerOf(onA, 'stable-key'));
});

test('ring: 分布均匀（256 shard / 4 成员，每人拿到大约 1/4）', () => {
  const ring = createRing(['a', 'b', 'c', 'd']);
  const owners = shardOwners(ring, SHARDS);
  const counts = new Map();
  for (const owner of owners) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  assert.strictEqual(counts.size, 4, '四个成员都应当分到 shard');
  for (const [owner, count] of counts) {
    assert.ok(count > SHARDS / 4 - SHARDS * 0.15 && count < SHARDS / 4 + SHARDS * 0.15, `${owner} 分到 ${count} 个，偏离过大`);
  }
});

test('ring: 成员变更只迁移 ≈1/N；**对照**：取模分片几乎全量迁移', () => {
  const before = createRing(['a', 'b', 'c']);
  const after = createRing(['a', 'b', 'c', 'd']);
  const ringRatio = migrationRatio(before, after, SHARDS);
  assert.ok(
    ringRatio > 0.1 && ringRatio < 0.4,
    `环扩容 3→4 的迁移量应当 ≈1/4，实际 ${(ringRatio * 100).toFixed(1)}%`,
  );

  // 对照（**实测值**，不是推导值）：
  //   取模 3→4 = 74.2%，取模 64→65 = 75.0%（256 个 shard 下几乎不变）
  //   环   3→4 = 28.9%，环   64→65 = 2.3%（成员越多越好）
  // 所以正确的说法不是"取模几乎全量"（小 N 下是 3/4），而是"**取模不随 N 改善，环会**"。
  const modulo3to4 = moduloMigrationRatio(['a', 'b', 'c'], ['a', 'b', 'c', 'd'], SHARDS);
  assert.ok(
    modulo3to4 > 0.6 && modulo3to4 > ringRatio * 2,
    `取模 3→4 实测 ${(modulo3to4 * 100).toFixed(1)}%，环只有 ${(ringRatio * 100).toFixed(1)}%`,
  );
  const many = Array.from({ length: 64 }, (_, i) => `node-${i}`);
  const modulo64to65 = moduloMigrationRatio(many, [...many, 'node-64'], SHARDS);
  const ring64to65 = migrationRatio(createRing(many), createRing([...many, 'node-64']), SHARDS);
  assert.ok(modulo64to65 > 0.6, `取模 64→65 实测 ${(modulo64to65 * 100).toFixed(1)}%（并没有更好）`);
  assert.ok(
    ring64to65 < 0.1,
    `环 64→65 实测 ${(ring64to65 * 100).toFixed(1)}%：成员越多，环的迁移量越小`,
  );

  // 缩容同理
  const shrink = migrationRatio(after, before, SHARDS);
  assert.ok(shrink > 0.1 && shrink < 0.4, `环缩容 4→3 的迁移量应当 ≈1/4，实际 ${(shrink * 100).toFixed(1)}%`);

  // changedShards 与 migrationRatio 一致
  assert.strictEqual(changedShards(before, after, SHARDS).length / SHARDS, ringRatio);
});

test('ring: 单成员 / 空成员 / 参数校验', () => {
  const single = createRing(['only']);
  assert.deepStrictEqual([...new Set(shardOwners(single, SHARDS))], ['only']);

  const empty = createRing([]);
  assert.strictEqual(ownerOf(empty, 'anything'), null);
  assert.deepStrictEqual(shardOwners(empty, 4), [null, null, null, null]);
  assert.strictEqual(ownerOfShard(empty, 0), null);

  assert.throws(() => createRing(['a'], { virtualNodes: 0 }), /virtualNodes 必须是 >= 1/);
  assert.throws(() => shardOf('x', 0), /shardCount 必须是 >= 1/);
  assert.throws(() => ownerOfShard(single, -1), /shard 必须是 >= 0/);
  assert.throws(() => shardOwners(single, 1.5), /shardCount 必须是 >= 1/);
});

test('ring: shardOf 对同一路径稳定；不同路径分布开来', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const shard = shardOf(`player_${i}`, SHARDS);
    assert.strictEqual(shard, shardOf(`player_${i}`, SHARDS), '同一路径必须落在同一 shard');
    assert.ok(shard >= 0 && shard < SHARDS);
    seen.add(shard);
  }
  // 200 次投进 256 个桶：期望的不同桶数 ≈ 256*(1-(1-1/256)^200) ≈ 139（生日问题），
  // 所以断言放"明显铺开"而不是"接近 256"。
  assert.ok(seen.size > 120, `200 个路径应当铺开到大多数 shard（实际 ${seen.size} 个，期望 ≈139）`);
});
