/**
 * 一致性哈希环与分片所有权（M4 第 1 步）。
 *
 * 纯数据 + 纯函数：不碰网络、不碰存储，所以它可以在任何地方被算出**同一个结果**——
 * 这正是"所有权不需要共识"的前提（已确认的 D1）。
 *
 * 三条不变量（都有测试钉住）：
 *   1. **确定性**：环只依赖成员的**集合**（与顺序无关），同一集合 ⇒ 同一个环 ⇒ 同一个 owner；
 *   2. **tie-break 写死**：token 相同时按 `nodeId` 字典序 —— 否则不同节点可能算出不同 owner；
 *   3. **迁移量 ≈ 1/N**：成员变更只影响变更点之后的区间（虚拟节点让分布更均匀）。
 */

const { createHash } = require('node:crypto');

/** 每个成员的虚拟节点数：越大越均匀、越费内存。 */
const DEFAULT_VIRTUAL_NODES = 64;

interface RingToken {
  /** 32 位无符号 token（sha1 前 4 字节）。 */
  token: number;
  nodeId: string;
}

interface Ring {
  virtualNodes: number;
  /** 按 (token, nodeId) 升序 —— 顺序是环语义的一部分。 */
  tokens: readonly RingToken[];
}

/** 稳定的 32 位哈希（`node:crypto`，零依赖）。 */
function hash32(value: unknown): number {
  return createHash('sha1').update(String(value), 'utf8').digest().readUInt32BE(0);
}

/**
 * 建环。成员是 nodeId 的**集合**：重复、空串会被忽略，顺序不影响结果。
 * 空成员集合 ⇒ 空环（`ownerOf` 返回 `null`）——调用方自己决定"没有成员时怎么办"。
 */
function createRing(members: readonly string[], options: { virtualNodes?: number } = {}): Ring {
  const virtualNodes = options.virtualNodes ?? DEFAULT_VIRTUAL_NODES;
  if (!Number.isInteger(virtualNodes) || virtualNodes < 1) {
    throw new TypeError(`virtualNodes 必须是 >= 1 的整数（当前 ${String(virtualNodes)}）`);
  }
  const nodeIds = [...new Set((members ?? []).filter((id) => typeof id === 'string' && id.length > 0))];
  const tokens: RingToken[] = [];
  for (const nodeId of nodeIds) {
    for (let index = 0; index < virtualNodes; index += 1) {
      tokens.push({ token: hash32(`${nodeId}#${index}`), nodeId });
    }
  }
  // tie-break 写死：token 相同按 nodeId 字典序（不写死就可能算出不同 owner）
  tokens.sort((a, b) => a.token - b.token || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return Object.freeze({ virtualNodes, tokens: Object.freeze(tokens) });
}

/** 顺时针第一个 token 的成员；空环返回 `null`。 */
function ownerOf(ring: Ring, key: string): string | null {
  const count = ring.tokens.length;
  if (count === 0) return null;
  const token = hash32(key);
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = ring.tokens[mid] as RingToken;
    if (candidate.token >= token) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return (ring.tokens[found === -1 ? 0 : found] as RingToken).nodeId; // 绕回环首
}

/**
 * Actor 落在哪个 shard：对**路径**哈希（同一实体永远同一个 shard）。
 *
 * `shardCount` 是运维常量（doc 05 §1.2）：改它等于全量重分布。
 */
function shardOf(actorPath: string, shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new TypeError(`shardCount 必须是 >= 1 的整数（当前 ${String(shardCount)}）`);
  }
  return hash32(actorPath) % shardCount;
}

/** 某个 shard 的 owner（`shardCount` 不参与：shard id 本身就是 key）。 */
function ownerOfShard(ring: Ring, shard: number): string | null {
  if (!Number.isInteger(shard) || shard < 0) {
    throw new TypeError(`shard 必须是 >= 0 的整数（当前 ${String(shard)}）`);
  }
  return ownerOf(ring, `shard:${shard}`);
}

/** 每个 shard 的 owner（升序）。没成员时全是 `null`。 */
function shardOwners(ring: Ring, shardCount: number): (string | null)[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new TypeError(`shardCount 必须是 >= 1 的整数（当前 ${String(shardCount)}）`);
  }
  return Array.from({ length: shardCount }, (_, shard) => ownerOfShard(ring, shard));
}

/** 变更 owner 的 shard 列表（升序）——运维最关心的就是这些。 */
function changedShards(before: Ring, after: Ring, shardCount: number): number[] {
  const previous = shardOwners(before, shardCount);
  const next = shardOwners(after, shardCount);
  const changed: number[] = [];
  for (let shard = 0; shard < shardCount; shard += 1) {
    if (previous[shard] !== next[shard]) changed.push(shard);
  }
  return changed;
}

/** 迁移量 = 变更 owner 的 shard 占比（0..1）。 */
function migrationRatio(before: Ring, after: Ring, shardCount: number): number {
  return changedShards(before, after, shardCount).length / shardCount;
}

/** 对照用：`shard % 成员数` 这种朴素分片（示例里曾经这么写）的 owner 表。 */
function moduloOwners(members: readonly string[], shardCount: number): (string | null)[] {
  const list = [...new Set(members)];
  if (list.length === 0) return Array.from({ length: shardCount }, () => null);
  return Array.from({ length: shardCount }, (_, shard) => list[shard % list.length] as string);
}

/** 对照用：朴素分片在两次成员集合之间的迁移量。 */
function moduloMigrationRatio(
  before: readonly string[],
  after: readonly string[],
  shardCount: number,
): number {
  const previous = moduloOwners(before, shardCount);
  const next = moduloOwners(after, shardCount);
  let changed = 0;
  for (let shard = 0; shard < shardCount; shard += 1) if (previous[shard] !== next[shard]) changed += 1;
  return changed / shardCount;
}

module.exports = {
  DEFAULT_VIRTUAL_NODES,
  hash32,
  createRing,
  ownerOf,
  shardOf,
  ownerOfShard,
  shardOwners,
  changedShards,
  migrationRatio,
  moduloOwners,
  moduloMigrationRatio,
};
