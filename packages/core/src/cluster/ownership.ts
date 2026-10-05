/**
 * 分片所有权守卫与 fencing token（M4 第 2 步）。
 *
 * 分工（已确认的 D1/D2）：
 *   - **谁拥有**：由 `ring.ts` 的环在每个节点上**本地确定性算**（不共识）；
 *   - **第几代**：`epoch` 是"这个 shard 被谁声明过几次"的计数器，通过声明（gossip 或直接观察）
 *     传播。**epoch 的权威来自 gossip 学习到的声明**，而不是消息自己说了算——这一点很关键：
 *     否则任何节点都能给自己 +1 然后被接受。
 *
 * 接受规则（`verify`）——挡住"旧 owner 说的话"：
 *   1. **与已知最佳声明冲突就拒绝**：`epoch < best.epoch`，或同 epoch 换人；与最佳声明一致则通过；
 *   2. **本集群成员受环约束**：发送者是本节点成员视图里的成员、却不是这个 shard 的环 owner → 拒绝
 *      （环在本集群内是权威：它不该拥有这个 shard）；
 *   3. **非成员（跨集群转发者）不受本地环约束**：环对它没有权威，只在"有更新的声明"时按规则 1 拒绝。
 *
 * 规则 3 是踩出来的：接入层节点与游戏节点是**两个独立 gossip 组**，接入节点的小环认为"自己拥有
 * 一切"，于是它转发的每个请求都带 token——按"必须等于本地环 owner"去拒，跨集群调用就全断了
 * （`integration-cluster-access` 抓到）。
 *
 * **挡不住的（如实写在文档与测试里）**：双方视图都还没更新时（旧 owner 在接收方眼里仍然是
 * ring owner，且没有更新的声明被观察到），本地无法识别它是旧的——这正是 doc 05 §1.5 说的
 * "gossip 未收敛期间有窗口"。fencing 的作用是**收窄**窗口，不是消灭它；消灭它需要共识（非目标）。
 */

const ring = require('./ring.ts');

/**
 * 环的**结构类型**（与 ring.ts 的形状一致）。
 *
 * 内核是 CJS，不能 `import type`，所以这里不复制常量、只声明形状——守卫只依赖
 * "能交给 ring.ownerOfShard 用"这一点（与数据层对内核的做法一样：只认结构，不认身份）。
 */
interface Ring {
  virtualNodes: number;
  tokens: readonly { token: number; nodeId: string }[];
}

interface ShardClaim {
  shard: number;
  ownerNodeId: string;
  epoch: number;
  at: number;
}

interface VerifyResult {
  ok: boolean;
  reason?: string;
  learned?: ShardClaim;
}

interface OwnershipGuardOptions {
  nodeId: string;
  shardCount: number;
  virtualNodes?: number;
  now?: () => number;
}

function createOwnershipGuard(options: OwnershipGuardOptions) {
  const nodeId = String(options?.nodeId ?? '');
  if (nodeId.length === 0) throw new TypeError('ownership guard 需要 nodeId');
  const shardCount = options?.shardCount;
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new TypeError(`shardCount 必须是 >= 1 的整数（当前 ${String(shardCount)}）`);
  }
  const now = options.now ?? (() => Date.now());

  let currentRing: Ring | null = null;
  /** shard -> 已知的最高声明（epoch 最大；同 epoch 只认同一个 owner）。 */
  const claims = new Map<number, ShardClaim>();

  function updateRing(members: readonly string[]): Ring {
    currentRing = ring.createRing(members ?? [], {
      virtualNodes: options.virtualNodes ?? ring.DEFAULT_VIRTUAL_NODES,
    }) as Ring;
    return currentRing;
  }

  function ownerOf(shard: number): string | null {
    if (currentRing === null) return null;
    return ring.ownerOfShard(currentRing, shard);
  }

  function ownsShard(shard: number): boolean {
    return ownerOf(shard) === nodeId;
  }

  function bestClaim(shard: number): ShardClaim | null {
    return claims.get(shard) ?? null;
  }

  /** 本节点对某 shard 的声明；只有它确实是（本地环上的）owner 时才给出。 */
  function claimFor(shard: number): ShardClaim | null {
    const owner = ownerOf(shard);
    if (owner !== nodeId) return null;
    const previous = claims.get(shard);
    // 只有出现在环上（且没有更高的已知声明）才声明自己：**不自封**
    if (previous !== null && previous !== undefined && previous.ownerNodeId !== nodeId) return null;
    const epoch = previous === null || previous === undefined ? 1 : previous.epoch;
    const claim = { shard, ownerNodeId: nodeId, epoch, at: now() };
    claims.set(shard, claim);
    return claim;
  }

  /**
   * 学习一条声明（来自 gossip 或直接观察）。
   *
   * - 更高 epoch → 接受（所有权换代了）；
   * - 同 epoch 同 owner → 接受（幂等重复）；
   * - 同 epoch 不同 owner → **拒绝**（同一个 epoch 出现两个 owner = 双主声明，必须报出来）；
   * - 更低 epoch → 忽略（陈旧声明）。
   */
  function observe(claim: ShardClaim): { accepted: boolean; reason?: string; learned?: ShardClaim } {
    if (!claim || !Number.isInteger(claim.shard) || claim.shard < 0) {
      throw new TypeError('claim.shard 必须是 >= 0 的整数');
    }
    if (typeof claim.ownerNodeId !== 'string' || claim.ownerNodeId.length === 0) {
      throw new TypeError('claim.ownerNodeId 必须是非空字符串');
    }
    if (!Number.isInteger(claim.epoch) || claim.epoch < 1) {
      throw new TypeError(`claim.epoch 必须是 >= 1 的整数（当前 ${String(claim.epoch)}）`);
    }
    const previous = claims.get(claim.shard) ?? null;
    if (previous !== null) {
      if (claim.epoch < previous.epoch) return { accepted: false, reason: 'epoch 更旧，忽略' };
      if (claim.epoch === previous.epoch && claim.ownerNodeId !== previous.ownerNodeId) {
        return {
          accepted: false,
          reason: `双主声明：shard ${claim.shard} 的 epoch ${claim.epoch} 已属于 ${previous.ownerNodeId}，又来了 ${claim.ownerNodeId}`,
        };
      }
      if (claim.epoch === previous.epoch && claim.ownerNodeId === previous.ownerNodeId) {
        return { accepted: false, reason: '重复声明（幂等）' };
      }
    }
    const learned = { shard: claim.shard, ownerNodeId: claim.ownerNodeId, epoch: claim.epoch, at: claim.at ?? now() };
    claims.set(claim.shard, learned);
    return { accepted: true, learned };
  }

  /** 接收端校验：这条带 fencing token 的消息算不算数。 */
  function verify(incoming: { shard: number; ownerNodeId: string; epoch: number }): VerifyResult {
    if (!incoming || !Number.isInteger(incoming.shard) || incoming.shard < 0) {
      return { ok: false, reason: 'incoming.shard 必须是 >= 0 的整数' };
    }
    if (!Number.isInteger(incoming.epoch) || incoming.epoch < 1) {
      return { ok: false, reason: `incoming.epoch 必须是 >= 1 的整数（当前 ${String(incoming.epoch)}）` };
    }
    if (currentRing === null) {
      // 没有成员视图 = 谁拥有什么都不知道。**宁可拒绝**，也不要在这种状态下让远端驱动本地 Actor。
      return { ok: false, reason: `fencing：还没有成员视图，无法确认 shard ${incoming.shard} 的 owner` };
    }
    const best = bestClaim(incoming.shard);
    const ringOwner = ownerOf(incoming.shard);

    // **环与声明都只对本集群成员有权威**：非成员（跨集群转发者、别的 gossip 组里的节点）
    // 的 epoch 与我们的 epoch 是两套互不相干的计数器，拿它比较只会互相误伤
    // （真实回归：接入层与游戏层各自从 1 开始，同一个 shard 上"撞号"，跨集群调用全断）。
    if (!isMember(incoming.ownerNodeId)) return { ok: true };

    // 成员之间：先比声明（epoch 才是真正的 fencing）
    if (best !== null) {
      if (incoming.ownerNodeId === best.ownerNodeId && incoming.epoch === best.epoch) return { ok: true };
      if (incoming.epoch < best.epoch) {
        return {
          ok: false,
          reason:
            `fencing：shard ${incoming.shard} 的 epoch ${incoming.epoch}（来自 ${incoming.ownerNodeId}）` +
            `比已知的 ${best.epoch}（来自 ${best.ownerNodeId}）更旧，拒绝`,
        };
      }
      if (incoming.epoch === best.epoch) {
        return {
          ok: false,
          reason: `fencing：shard ${incoming.shard} 的 epoch ${incoming.epoch} 已被 ${best.ownerNodeId} 声明，拒绝 ${incoming.ownerNodeId}`,
        };
      }
      // epoch 更高 = 它宣称自己是新一轮 owner → 继续用环确认（下面）
    }

    if (ringOwner === null) {
      return { ok: false, reason: `fencing：还没有成员视图，无法确认 shard ${incoming.shard} 的 owner` };
    }
    if (incoming.ownerNodeId === ringOwner) return { ok: true };
    return {
      ok: false,
      reason:
        `fencing：shard ${incoming.shard} 在本地环上的 owner 是 ${ringOwner}，不是 ${incoming.ownerNodeId}` +
        (best === null ? '' : `（已知声明：${best.ownerNodeId}@epoch ${best.epoch}）`),
    };
  }

  /** 这个 nodeId 是否在本节点的成员视图里（环与声明只对本集群成员有权威）。 */
  function isMember(candidate: string): boolean {
    if (currentRing === null) return false;
    return currentRing.tokens.some((token) => token.nodeId === candidate);
  }

  function claimsSnapshot(): ShardClaim[] {
    return [...claims.values()].sort((a, b) => a.shard - b.shard);
  }

  function stats(): { nodeId: string; shards: number; owned: number; claims: number } {
    let owned = 0;
    for (let shard = 0; shard < shardCount; shard += 1) if (ownsShard(shard)) owned += 1;
    return { nodeId, shards: shardCount, owned, claims: claims.size };
  }

  return {
    nodeId,
    shardCount,
    updateRing,
    ring: () => currentRing,
    ownerOf,
    ownsShard,
    claimFor,
    observe,
    verify,
    isMember,
    bestClaim,
    claims: claimsSnapshot,
    stats,
  };
}

module.exports = { createOwnershipGuard };
