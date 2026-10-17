# M4 实施：集群治理（分片所有权 · 交接 · fencing · singleton）

> **进度标记**：本页的 ✅ 反映**当前实现**（已按代码路径与测试逐条核对），不是"当时计划"。
> 本页不允许再有"未完成"标记；确需新增时，必须同时登记到 `docs/design/progress.json` 的 `openItems`，
> 否则文档门禁会红 —— 这是为了不再出现"文档说没做、代码里其实做了"。最新整体状态见 [m9 交接记录](./m9-scaffold-cli.md)。


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
| **1** | **一致性哈希环 + 所有权计算**：纯函数、确定性、虚拟节点；`ownerOf(actorPath)`；成员变更只影响变更点区间 | 同一成员视图下**所有节点算出同一 owner**；增删一个成员只迁移 ≈1/N 的 shard（迁移量可测） | ✅ `packages/core/src/cluster/ring.ts` + `ownership.ts`；测试 `unit-cluster-ring.test.js` / `unit-cluster-ownership.test.js`（含"增删成员只迁移 ≈1/N"的量化断言） |
| 2 | **所有权守卫 + fencing token**：`shardEpoch`；跨节点消息带 epoch；接收端拒绝旧 epoch（"旧 owner 说的话不算数"） | 旧 epoch 的消息**必被拒**（fencing 测试） | ✅ 完成（§3.3 + §3.4.5；网关侧也有 `unit-gateway-fencing` 端到端用例） |
| 3 | **优雅交接**：冻结 → 排空 → 导出（快照 + 事件 offset）→ 在新 owner 上恢复 → epoch+1 → 释放；幂等可重试 | 3 节点：下线一个节点，它的 shard 全部交接**且无消息丢失**（有测试） | ✅ 完成（`integration-cluster-governance` / `integration-cluster-fencing`；**仅优雅 drain**，崩溃路径不交接，见指南 05） |
| 4 | **Singleton**：`shardCount = 1` 的特例 + 接管延迟语义（尽力而为的单例，不是分布式锁） | 全集群唯一 owner；owner 下线后新 owner 接管（有测试） | ✅ §5.5 |
| 5 | **少数派拒写 + 脑裂边界**：多数派判据 + 503 + 重试提示；文档写清质量等级 | 少数派拒写、多数派继续服务（有测试） | ✅ §5.6 |
| 6 | **可迁移性声明 + 指标**：`transferable: false` 的 Actor 在下线时**明确失败**（不假装能迁 socket）；所有权/迁移进 metrics | 不可迁移 Actor 给出明确错误；指标可见 | ✅ §5.7 |

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

## 3.3 第 2 步（2a）详细设计：所有权守卫与 fencing

**核心问题**：`epoch` 的权威从哪来？如果"消息自己带的 epoch 说了算"，那任何节点都能给自己 +1
然后被接受——fencing 就成了装饰。所以实现里定死两条：

> **epoch 的权威来自"被观察到的声明"，不来自消息本身。**

| 组件 | 职责 |
|---|---|
| `updateRing(members)` | 用成员视图重算环（`ring.ts`，本地确定性） |
| `claimFor(shard)` | 本节点对某 shard 的声明；**只有它在环上确实是 owner 时才给出**（不自封） |
| `observe(claim)` | 学习声明：更高 epoch → 换代；同 epoch 同 owner → 幂等；**同 epoch 换人 → 拒绝并报"双主声明"**；更低 epoch → 忽略 |
| `verify({shard, ownerNodeId, epoch})` | 接收端判决，两条接受规则（见下），否则给出可诊断的拒绝原因 |

**接受规则**（最终版，含两处踩出来的修正）：
1. **与已知最佳声明冲突就拒**：`epoch < best.epoch`，或同 epoch 换人；一致则通过；
2. **本集群成员受环约束**：发送者是本地成员视图里的成员、却不是这个 shard 的环 owner → 拒绝；
3. **非成员（跨集群转发者）不受本地环约束**：环对它没有权威，只在"有更新的声明"时按规则 1 拒绝。

**规则 3 是踩出来的**：接入层节点与游戏节点是**两个独立 gossip 组**，接入节点的小环认为"自己拥有
一切"，于是它转发的每个请求都带 token；按"必须等于本地环 owner"去拒，跨集群调用**全断**
（`integration-cluster-access` 抓到）。修正后语义更准：**环只对本集群成员有权威**，而真正的
fencing 是 epoch 比较。

其余一律拒绝。这样"旧 owner 用旧 epoch 发消息"在两种情况下都会被挡：
- 接收方已经学到了新声明（规则 1 生效）；
- 接收方的环已经变了（规则 2 生效）。

**挡不住的（如实写进测试与文档，不夸大）**：双方视图都还没更新时（旧 owner 在接收方眼里仍是
ring owner，且没有更新的声明被观察到），本地**无法**识别它是旧的——有专门的测试把这条"放行"
断言下来，免得以后误以为 fencing 是绝对保证。这与 doc 05 §1.5 一致：fencing 的作用是**收窄**
窗口；消灭窗口需要共识（doc 06 明确不做 Raft）。第 5 步的少数派拒写与第 3 步的交接协议各堵一部分。

**本步范围**：纯逻辑组件（零网络、零格式改动）。把它接进**网关帧 + gossip 声明**是 2b——
那会动线格式，要单独做并单独验（含跨版本兼容）。

## 3.4 第 2b 步（接网关）：线格式兼容策略

### 3.4.1 先看事实（读代码得到，不是猜）

| 事实 | 依据 | 对兼容策略的意义 |
|---|---|---|
| 帧布局 = `uint32_be 长度 \| uint8 codec \| body`，**codec 每帧自带** | `framing.ts` | JSON(0) 与 Protobuf(1) 永远双向互通，**不需要协商**；但**两条编码路径都得写新字段**，否则 JSON 模式带、proto 模式丢 |
| 解码器**跳过未知字段** | `proto.ts` 的 `decodeMessage`（`skipField(...); continue;`） | **加字段是向后兼容的**：旧节点读到新字段直接忽略，不会抛错 |
| 网关帧字段**已经追加过 5 次**（10-14：timeoutMs / senderPath / trace / senderHost / senderPort） | `GATEWAY_FRAME_SCHEMA` 的注释与定义 | "追加字段"是这个协议的**既有演进方式**，不是我发明的新机制 |
| `hello { id, nodeId, codec }` 握手已存在；TLS + verifyNodeId 时**没握手不许发数据** | `gateway.ts` 顶部注释 + `requireHello` | **能力交换有现成的地方**：hello 里多带一个能力/参数即可 |
| gossip 的注册表 map 走 **JSON bytes**，key 任意（已有 `subs:<nodeId>` 这种非 actor key） | `actor-proto.proto` 的 `RegistryEntry`/`dataJson` | **声明（shard → owner/epoch）的传播零格式改动**：加 `shard:<id>` 条目即可 |
| `.proto` 参考文档**已经过期**：只写到字段 9，实际到 14，且它自称"与 proto.js 完全一致" | `actor-proto.proto` vs `proto.ts` | 2b 必须**顺手修掉**这个文档谎报（否则下一个人照着它改字段号）

### 3.4.2 fencing 到底要在线上加什么（能省的都省掉）

| 需要的东西 | 是否要新字段 | 理由 |
|---|---|---|
| `shard` | **不要** | 接收方本地算：`shardOf(targetActorId, shardCount)`。**前提是两边 `shardCount` 一致**（见 3.4.3 的决策） |
| `ownerNodeId` | **不要** | 用**连接上已验证的身份**（TLS 握手的 nodeId / hello 的 nodeId），比让发送方自称更强 |
| `epoch` | **要**：网关帧新字段 `shardEpoch`（no. 15） | 它才是"第几代"的信息，两边都推不出来 |
| 声明传播（谁在第几代拥有哪个 shard） | **不要** | 走 gossip 注册表的 `shard:<id>` JSON 条目（零格式改动） |
| 能力/参数交换（是否支持 fencing、`shardCount`） | **不要**（复用 hello 的既有字段位） | hello 已经在交换 nodeId/codec |

**结论：线格式的净增量只有一个可选字段。** 兼容策略因此只围绕"**这条帧上没有 epoch 时怎么判**"。

### 3.4.3 三个候选策略

| 策略 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 软升级（推荐默认）** | `hello` 里带上能力与参数；帧上 `shardEpoch` 是**可选**字段。收到**没有 epoch** 的帧时：对端**声明支持 fencing** → **拒绝**（它知道规则却没带 = 协议违规/状态错乱）；对端**不支持** → **放行**并记一条 `fencing_skipped` 日志 + 计数 | 滚动升级不中断；降级**可见**（日志/指标），不会"以为有保护"；与仓库一贯的"如实上报"一致 | 混布期间旧节点的写入不受 fencing 约束（就是"收窄窗口"的诚实延续） |
| **B. 硬门（可作为可选开关）** | `hello` 交换协议版本，不一致 → **握手失败** | 语义干净：绝不在无保护下服务 | 滚动升级必须全体同时升级，否则集群裂成两个互不相连的集合——对默认太激进；适合 `cluster.requireFencing: true` 的部署 |
| C. 双写过渡 | 新旧字段同时写、读时优先新的 | 适合"**改**已有字段语义" | 我们只是**加**字段，不改旧语义，用不上；列出来是为了说明为什么不选更重的方案 |

**字段纪律（不论选哪个都要遵守）**：编号只追加（15、16…）**永不重用/改号**；`.proto` 参考文档
与 `proto.ts` 同步更新（含把 10–14 补上）；JSON 与 proto 两条编码路径都要写/读新字段；
每次加字段都要有一条"**旧节点 ↔ 新节点**"的兼容测试（旧帧可被新节点接受、新帧被旧解码器忽略）。

### 3.4.4 决策（已确认）

> **决策记录（已确认）**：
> - **D5**：**A 软升级为默认 + B 硬门作为可选开关**（`cluster.requireFencing: true`）。
>   默认不中断滚动升级；对端不支持 fencing 时的放行**必须可见**（`fencing_skipped` 日志 + 指标）；
> - **D6**：`hello` 交换 `shardCount`，**不一致就拒绝连接**并给出明确错误——算错 shard 比拒绝连接
>   危险得多（会静默放行/拒绝错误的帧），而 `shardCount` 本就是运维常量，不一致属于配置事故。

### 3.4.5 2b 进展（协议半边已完成）

| # | 改动 | 状态 |
|---|---|---|
| 1 | `proto.ts`：字段 15 `shardEpoch`（另加 16 `capsJson`、17 `shardCount`）；`.proto` 参考文档补到 17 并加"字段只追加"纪律 | ✅ |
| 2 | `gateway.ts`：出站 tell/stop/deliver 带 `shardEpoch`（拿不到就**不带**字段）；hello **双向**交换 `caps`/`shardCount`；不一致或硬门不满足 → 明确拒绝；`verifyOwnership` 钩子 | ✅ |
| 3 | `plugins/cluster.ts`：接守卫、成员视图喂环、`system.ownership`（`epochFor` / `verifyIncoming`）、`cluster.ownership`、**声明自动走 gossip** | ✅ |
| 4 | 能力可见性：`cluster.fencing()`（`skipped` / `rejected` / `conflicts`） | ✅（按对端列出能力还没做） |
| 5 | 两节点端到端：声明自动传播、旧 epoch 被拒、非成员转发仍可用、双主声明被拒 | ✅（3 个用例，见 `test/integration-cluster-fencing.test.js`） |

### 3.4.6 声明的传播：每节点一条映射，按需发布

注册表是**整体复制**的（每轮 gossip 带上整个 map），所以"一个 shard 一条条目"会把 256 个 shard
变成 256 条记录、每轮都传。取舍如下：

| 点 | 决定 |
|---|---|
| 载体 | **每节点一条**：`shard-claims:<nodeId>` = `{ claims: { [shard]: epoch } }`（JSON，零格式改动） |
| 发布时机 | **按需**：本节点真的要为某个 shard 声明所有权时（即 `epochFor` 被调用时）才把它写进映射并发布 |
| 效果 | 声明数量被"实际用到的 shard"自然限制；测试断言注册表条目数 < 20（而不是 ~256） |
| 换代 | 新 epoch 覆盖（LWW + 每 shard 取最大）；同 epoch 换人 = **双主声明** → 拒绝 + `conflicts` 计数 + 日志 |
| 观测 | 对端条目到达时逐条 `guard.observe`；冲突**必须报出来**，不允许静默覆盖 |

**残余的两处诚实边界**（都在这里写清，避免以后被误当成"已解决"）：
1. **故障接管的 epoch 归属未定**：节点失联后新 owner 该用第几代，需要"知道旧 owner 的声明"才好
   +1；若那条声明从未复制过来，新 owner 只能从 1 开始，而见过旧声明的对端会拒它。这个策略属于
   **第 3 步（优雅交接）**——那里 epoch+1 是显式协议的一部分；故障路径按 doc 05 §1.3 本就是
   "无交接、靠状态恢复"的低一档质量。现在**只发布与观察，不做自动接管加代**。
2. **`observe` 不校验声明者的身份**：声明里声称的 owner 与本节点环不一致时仍然接受（否则接管会被
   挡住）。也就是说，集群内一个错误/恶意节点能抬高某个 shard 的 epoch，让真 owner 的消息被拒。
   这正是"gossip 是信任域内协议"的边界：身份由 TLS/成员准入负责，`shard-claims` 不做签名。
   要更强保证就得引入共识或签名声明——都不在本里程碑范围内（doc 06 已把"不做 Raft"列为非目标）。

**第二个踩出来的 bug（值得记）**：出站帧是由 `Peer` 自己创建的**客户端网关**发出去的，而我只给
服务端网关装了所有权选项——于是"发帧的网关不带 token、收帧的网关却要求 token"，跨节点调用被**自己
人**拒掉。修法是把所有权选项抽成 `ownershipOptions(system, { inbound })`，两条构造都用它。教训：
**同一份策略只要有两个构造点，就一定会有一个被漏掉。**

**协议半边的三条判定规则**（`Gateway._checkOwnership`，都有测试）：
1. 帧上**有** `epoch` → 交给 `verifyOwnership` 钩子判（旧 epoch 被拒）；
2. 帧上**没有** `epoch` 但对端**声明支持** fencing → **拒绝**（协议违规：它知道规则却没带）；
3. 帧上**没有** `epoch` 且对端**不支持** → 放行 + `fencing_skipped` 事件（软升级，但降级**可见**）。

**能力默认值必须诚实**：`caps` 只在真的装了 `epochFor`（能产出 token）时才包含 `fence`。
第一版把默认写成"永远声明支持"，结果**没装守卫的节点也宣称支持却带不出 epoch** → 每条帧都被
判成协议违规，`unit-tls` 的"滚动升级"用例当场抓到（真实回归）。这条与 §3.4.3 的"降级必须可见"
是一体两面：**不能声明自己做不到的事**。

**编码路径的坑（我自己踩了）**：protobuf 编码器只写 schema 里登记过的字段，**没登记就被静默丢弃**
（JSON 路径照带）。第一版只往帧对象里加了 `caps`/`shardCount`，于是 proto 模式下 hello 的能力信息
凭空消失——正是 §3.4.1 里我自己写下的那条规则。现在 16/17 已登记，并有测试同时验两条编码路径。

### 3.4.7 2b 实施清单（原始，供对照）

| # | 改动 | 验收 |
|---|---|---|
| 1 | `proto.ts`：`GATEWAY_FRAME_SCHEMA` 追加 `shardEpoch`（**no. 15**），encode/decode 两处都接；**同步修 `.proto` 参考文档**（补 10–15，删掉"与 proto.js 完全一致"的过期声明） | 单测：新字段往返；**旧帧（无 15）解码不报错** |
| 2 | `gateway.ts`：deliver / stop 帧带上 `shardEpoch`（有则带）；`hello` 带 `caps` 与 `shardCount`；`shardCount` 不一致 → 明确拒绝连接；注入 `verifyOwnership(frame, peerNodeId)` 钩子（网关不认识守卫，只调钩子） | 单测：缺 epoch 的帧按"对端能力"分流；`shardCount` 不一致拒绝并给出原因 |
| 3 | `plugins/cluster.ts`：建守卫、把成员视图喂给 `updateRing`、把 `shard:<id>` 声明发到 gossip 注册表、观察对端声明；把 `verifyOwnership` 接到网关上；`system.cluster.ownership` 暴露出来 | 集成：**两台真节点**——旧 epoch 的消息被拒；新声明经 gossip 传播后旧 owner 立刻失效 |
| 4 | 能力可见性：`system.cluster.fencing()` 给出 `{ supported, peers: { nodeId: boolean } }`；降级时计数并暴露 | 单测 + 文档：**"以为有保护、其实没有"不可能发生** |
| 5 | 跨版本兼容测试（**必须有**）：旧节点发的不带 epoch 的帧、新节点发的带 epoch 的帧被旧解码器忽略 | 真实双节点下互发 |

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

## 5. 第 3 步：优雅交接（3a 已完成）

### 5.1 前提：成员视图必须先收敛（已修）

交接（以及整个 D1）建立在"所有节点看到同一份成员视图"之上。实测发现 gossip **只学主动来找它的
节点**：三个节点种在同一个节点上时是 `A:[a,b,c] B:[b,a] C:[c,a]`——B 和 C 永远不认识彼此。
两个节点时看不出问题（互相都拨过对方），三个节点立刻暴露。

修法：一轮 gossip 带上发送方已知的其它节点地址（`peersJson`，字段 6，只追加，旧对端跳过未知字段），
收到即采纳为可拨号 peer（上限 64）。回归测试断言三个节点的成员集合**完全相同**、peer 均 0 失败。

### 5.2 drain 协议（已实现）

`system.cluster.drain({ timeoutMs, stopActors })` —— 对照 doc 05 §1.3 的七步：

| doc 05 的步骤 | 本实现 |
|---|---|
| 1 冻结 | 发布 `leaving:<self>` → **所有节点（含自己）立刻把它从环里去掉**；本节点从此不为任何 shard 背书（`epochFor` 返回 null），入站帧一律拒并**明确告诉对端该找谁**（重定向，不是静默丢弃） |
| 2 排空 | 等网关的**在途请求计数**归零（有上限）；超时就如实报告 `timedOut: true`，不假装干净 |
| 3 导出 / 4 转移 / 5 装载 | **复用持久化**（已确认的 D3）：离场前给这些 shard 上的本地 Actor 存快照，新 owner 用**同一份存储**恢复。因此**前提是存储共享**（SQL / 共享文件系统）；节点本地存储上的 Actor 无法交接，必须声明 `transferable: false`（第 6 步） |
| 6 切换 | 新 owner 观察到环变化后**自动加代**：`epoch = 已知最大 + 1`，并写进自己的声明映射发布出去（这就是 2b 里记为"未定"的接管 epoch 归属） |
| 7 释放 | 停掉这些 Actor（`ref.stop()`），本地不再持有 |

**离开用一条注册表标记表达**（`leaving:<nodeId>`），所以"我要走了"这件事在**所有节点上确定性可见**，
不必等心跳超时——这是"优雅"与"崩溃"两种质量等级的分界（崩溃没有交接，靠状态恢复 + 业务幂等）。

### 5.3 验收（已有测试）

`test/integration-cluster-fencing.test.js` 的交接用例（三节点 + 共享存储 + 真 gossip + 真网关）：
摘要给出交出的 shard 与**接手方**；`timedOut === false`；离场前快照**确实落盘**（断言从存储里读得回来）；
本地 Actor 已释放；**新 owner 自动加代且计数可见**；离场节点对旧 shard 的请求给出**带接手方名字的
重定向**。

### 5.4 3b：新 owner 上重建 Actor（已实现）

**权威信号是"环把我提升为这个 shard 的 owner"，不是"清单到了"**。流程：

1. 离场方在 drain 里发布**接管清单**（`adopt:<nodeId>` = `[{path, shard, to, transferable}]`）——
   为什么不让接手方去读注册表？因为 Actor 条目在离场时会变成 tombstone，和清单抢同一轮 gossip，
   靠"猜"会漏（第一版就是这么错的）；
2. 接手方收到清单 → 先 `refreshRing()`（谁接手取决于环更新之后的结果）→ 把条目放进待接管队列；
3. 环真的把它提升为 owner 时，才用 `recreate(path)` 拿定义 + spawn（状态由 D3 从共享存储恢复）；
   这一轮还没轮到它的条目**留在队列里**，等下一次提升（不丢）。

`recreate` 由**应用层**提供（"路径 → 定义"是应用层的知识：模块的 `actors:` 声明 + 依赖注入）：
`@actor/app` 在 spawn 时记账 `path → {definition, options}`，并在 `listening` 时把它装到
`system.ownership.recreate` 上（插件的 setup 发生在内核 init 时，装早了会静默失效——真踩过）。

**doc 06 的"无消息丢失"因此端到端可验**：Actor 在 A 上处理 1 条消息 → A 优雅离场 → 接手节点按定义
重建 → 客户端继续问它，返回 **2**（状态从共享存储恢复，既不是从 0 重来，也不是重复处理）。

### 5.5 Singleton（第 4 步）

`cluster.spawnSingleton(definition, { id })`：**每个节点都调用**（通常在各节点启动流程里），只有
单例 shard（0 号）的 owner 真的运行。环变化时重新判断——**既有提升也有降级**（离场时失去 owner
身份必须停掉本地实例，否则会出现两个实例，这也是踩出来的）。语义照 doc 05 §1.4：**尽力而为的单例，
不是分布式锁**；接管有延迟。测试断言"全集群只有一个"并且 owner 离场后"仍然只有一个，且换人了"。

### 5.6 少数派拒写（第 5 步）

判据（已确认的 D4）：`2 * live > highWater`，其中 `highWater` 是**本节点见过的最多成员数**——
"我们曾经是 3 个，现在只剩我 1 个"会被判成少数派，而刚启动只见过自己的节点不会误判。
`enforceQuorum: true` 时入站请求被拒（503 语义 + 重试提示），应用层也可以用
`cluster.quorum()` / `cluster.assertWritable()` 自己决定怎么返回。

### 5.7 可迁移性声明与指标（第 6 步）

`spawn(def, { transferable: false })`：持有 socket / 文件句柄的 Actor 在 drain 时**明确失败**——
列进 `summary.untransferable`、**不存快照**（存了也没人能恢复 socket）、日志给出"客户端重连"的提示；
`transferable` 随注册表传播，接手方据此**跳过**它（`adoption.skipped` 可见）。绝不假装能迁 socket。

`cluster.metrics()` 一处读到：`ownership`（shards/owned/claims）、`fencing`（skipped/rejected/
conflicts/promoted/handedOver）、`adoption`（adopted/skipped/failed）、`singletons`、`quorum`。

### 5.8 本步踩到的两个真问题（都是"有实现、但没接上"）

1. **`pruneStaleNodes()` 没有生产调用点**（见提交 d927e49）：过期成员永不剔除 → 多数派判据永远
   认为人还齐 → 少数派拒写形同虚设，`node_timeout` 与故障接管也永不发生。现在每轮 gossip 前先剔除。
2. **接管顺序**：清单与离场标记常常同一轮到达，先处理清单时环里还有离场者 → 判定"不归我"就丢掉。
   现在"先刷新环、再由**环提升**驱动接管"，未轮到的条目留队列。
