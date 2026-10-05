# M4 实施：集群治理（分片所有权 · 交接 · fencing · singleton）

> 设计草案见 `05-cluster-ops-testkit.md §1`（不变），本文是**实施计划与决策记录**。
> 前置：M3 的数据层（事件日志 + 快照 + 条件写）已经到位——交接要用的"状态导出/恢复"就建立在它上面。

## 1. 现状与缺口（已核实代码，不是推测）

| 能力 | 现状 | 证据 |
|---|---|---|
| 成员发现（gossip） | ✅ LWW + 墓碑 + 心跳 + 节点剔除 | `cluster/gossip.ts`：`info()` 给出 `{nodeId, port, peers, nodes, registrySize}`，`node_timeout` 事件 |
| 按名字寻址 / 跨节点回信 | ✅ | `plugins/cluster.ts` 的 `DiscoveredRef`、网关帧带 sender |
| **分片所有权** | ❌ **一行都没有** | `grep -n "epoch\|fencing\|owner\|shard\|ring\|singleton\|drain" cluster/*.ts plugins/cluster.ts` → 0 命中 |
| **优雅交接** | ❌ | 同上；节点下线 = 它上面的 Actor 全丢 |
| **fencing token** | ❌ | 同上 |
| **singleton** | ❌ | 同上 |
| **少数派拒写** | ❌ | 同上（gossip 是 AP，没有"谁是多数派"的概念） |

## 2. 分步计划（每步独立提交，各自带验收）

| 步 | 内容 | 验收（可跑） | 状态 |
|---|---|---|---|
| **1** | **一致性哈希环 + 所有权计算**：纯函数、确定性、虚拟节点；`ownerOf(actorPath)`；成员变更只影响变更点区间 | 同一成员视图下**所有节点算出同一 owner**；增删一个成员只迁移 ≈1/N 的 shard（迁移量可测） | ⏳ |
| 2 | **所有权守卫 + fencing token**：`shardEpoch`；跨节点消息带 epoch；接收端拒绝旧 epoch（"旧 owner 说的话不算数"） | 旧 epoch 的消息**必被拒**（fencing 测试） | — |
| 3 | **优雅交接**：冻结 → 排空 → 导出（快照 + 事件 offset）→ 在新 owner 上恢复 → epoch+1 → 释放；幂等可重试 | 3 节点：下线一个节点，它的 shard 全部交接**且无消息丢失**（有测试） | — |
| 4 | **Singleton**：`shardCount = 1` 的特例 + 接管延迟语义（尽力而为的单例，不是分布式锁） | 全集群唯一 owner；owner 下线后新 owner 接管（有测试） | — |
| 5 | **少数派拒写 + 脑裂边界**：多数派判据 + 503 + 重试提示；文档写清质量等级 | 少数派拒写、多数派继续服务（有测试） | — |
| 6 | **可迁移性声明 + 指标**：`transferable: false` 的 Actor 在下线时**明确失败**（不假装能迁 socket）；所有权/迁移进 metrics | 不可迁移 Actor 给出明确错误；指标可见 | — |

**doc 06 的 M4 验收**（三条）：① 3 节点下线一个 → shard 全部交接且无消息丢失；② 旧 owner 用旧 epoch 发消息必须被拒；③ 扩缩容迁移量符合预期。第 1 步就把 ③ 的可测基础（环 + 迁移量）建起来。

## 3. 第 1 步详细设计：一致性哈希环与所有权

### 3.1 数据结构（纯数据 + 纯函数，不碰网络）

```ts
interface RingMember { nodeId: string; /* host/port 由 gossip 提供，环不需要 */ }
interface Ring {
  /** 虚拟节点数（默认 64）：越大越均匀，越小越省内存。 */
  virtualNodes: number;
  /** 已排序的 token → nodeId（token 是 32 位无符号整数）。 */
  tokens: { token: number; nodeId: string }[];
}
createRing(members: readonly string[], options?: { virtualNodes?: number }): Ring
ownerOf(ring: Ring, key: string): string | null          // 顺时针第一个 token 的成员
shardOf(actorPath: string, shardCount: number): number    // hash(actorPath) % shardCount
ownerOfShard(ring: Ring, shard: number, shardCount: number): string | null
```

要点：
- **确定性**：`token = sha1(`${nodeId}#${i}`) 的前 4 字节`（用 `node:crypto`，零依赖）；同一成员集合 →
  同一环；`ownerOf` 用二分查找第一个 ≥ token 的位置（回到开头 = 环）。
- **tie-break 必须写死**：token 相同时按 `nodeId` 字典序（否则不同节点可能算出不同 owner）。
  这是"所有节点算出同一 owner"的关键，也是测试要钉的第一条。
- **环只依赖成员集合**（不依赖顺序、不依赖 host:port）：`createRing(['a','b'])` 与 `createRing(['b','a'])` 等价。
- **`shardCount` 是运维常量**（doc 05 §1.2 已写死这条）：改它等于全量重分布，所以环按 shard 归属
  计算，而不是按 Actor —— `shard = hash(actorPath) % shardCount`，`owner(shard)` 由环决定。
- **不迁移量**：`migrationRatio(before, after) = 变更 owner 的 shard 数 / 总 shard 数`，
  作为纯函数暴露（**可测**：256 shard 下增删一个成员的迁移量应落在 `1/N ± 容差`）。

### 3.2 为什么不用"房间号 % 节点数"（示例里的写法）

第 1 步的测试把两者并排断言，用的是**实测值**（256 shard）：

| 成员数变化 | 取模分片 | 一致性哈希环 |
|---|---|---|
| 3 → 4 | **74.2%** | **28.9%** |
| 64 → 65 | **75.0%** | **2.3%** |

结论要比"取模几乎全量重分布"更准确一点：**取模的迁移量不随成员数改善（这个场景下稳定在 3/4），
环会（≈1/N）**。"N/(N+1) 逼近全量"那个推导只在对"key 空间远大于周期"时成立，256 个 shard 下
并不成立——所以文档里写实测值，不写推导值。这也正是 M3 里"游标 vs offset"的同一手法：
**不做没有对照证据的性能宣称**。

## 4. 决策（已确认）

> **决策记录（已确认，不再改动）**：
> - **D1**：所有权**每个节点本地、确定性地算**（用 gossip 的成员视图；不共识、不落盘；分歧窗口靠 fencing 兜）；
> - **D2**：fencing token = `(shard, ownerNodeId, epoch)`，**epoch 随所有权变更 +1**，
>   在**网关（跨节点入口）与本地派发两处**校验，旧 epoch 一律拒绝；
> - **D3**：交接的状态转移**复用持久化**（快照 + 事件 offset）——交接 = 在新 owner 上 spawn 并从存储恢复；
>   因此**只有持久化过的 Actor 可迁移**，没持久化的必须声明 `transferable: false`；
> - **D4**：少数派拒写用**简单多数**判据（`2 * live > known` 才允许写，否则 503 + 重试提示）。


| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| **D1** | 所有权怎么产生 | (a) **每个节点用 gossip 的成员视图本地、确定性地算**（不共识、不落盘；分歧窗口靠 fencing 兜）；(b) 所有权写进 gossip 注册表（LWW 合并，写冲突要自己解决）；(c) 外部协调（etcd/consul） | **(a)**：确定性哈希 + fencing 是这套模型的正解；引入共识就变成"自己写 Raft"（doc 06 明确不做） |
| **D2** | fencing token 形态与校验点 | (a) `(shard, ownerNodeId, epoch)`，**epoch 随所有权变更 +1**；跨节点消息带 epoch，接收端在**网关与本地路由两处**校验；(b) 全局单调 token（需要发号器）；(c) 只靠租约/时间戳 | **(a)**：doc 05 §1.3 已定"时间戳在时钟漂移下不可靠"；校验点选网关（跨节点入口）+ 本地派发（防自己人用旧 view 乱转） |
| **D3** | 交接的状态怎么转移 | (a) **复用持久化**（快照 + 事件 offset）：交接 = 在新 owner 上 spawn 并从存储恢复（因此只有**持久化过的** Actor 可迁移）；(b) 走集群消息把**内存状态**推过去（快，但新格式 + 分块 + 幂等都要自己做）；(c) (a) 为默认，(b) 留作后续优化 | **(a)**：零新格式、直接用 M3 的成果；代价与边界（未持久化的 Actor 必须声明 `transferable: false`）写清楚 |
| **D4** | 少数派拒写的判据 | (a) 简单多数：`2 * liveMembers > knownMembers` 才允许写，否则 503 + 重试提示；(b) 按所有权覆盖率判断；(c) 不拒写（纯 AP） | **(a)**：判据越简单越不容易在分区里产生"两边都以为自己是多数派"的错觉；配合 doc 05 §1.5 的表 |

已定（doc 05 已写死，不再问）：`shardCount` 是运维常量；交接**幂等可重试**；故障路径**没有交接**
（靠状态恢复 + 业务幂等）；singleton 是"尽力而为的单例"，不是分布式锁；`transferable: false` 的
Actor 明确失败而不是假装能迁移。

## 5. 实施顺序与停止条件

1. 环 + 所有权（纯函数，含迁移量对照）→ 2. 守卫 + fencing → 3. 优雅交接（3 节点端到端）→
4. singleton → 5. 少数派拒写 → 6. 可迁移性声明 + 指标。

**每步都要**：全量 `npm test` + 严格 typecheck 通过、测试落在可观察行为上（迁移量、拒绝、无消息丢失），
并按仓库惯例提交。**第 3 步（交接）之前不开"自动 rebalance"**——doc 06 §3 明确把自动弹性伸缩列为不做。
