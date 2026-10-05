# M3 实施：数据层与 schema 演进

> 设计草案见 `04-data-and-evolution.md`（不变），本文是**实施计划与逐步进展**。
>
> **已确认的三个前置决策**（本轮开工前拍板）：
> | # | 决策 | 选择 |
> |---|---|---|
> | A | 第一步做什么 | **schema 演进优先**（doc 04 §4 称其为"当前最大的空白"，也是 M3 验收第一条）|
> | B | 数据层放哪 | **新包 `packages/data`（`@actor/data`）**，内核只加最小 hook |
> | C | 事件/快照盘上格式 | **加信封 + 读取期兼容旧格式**：新写入带 `eventId/type/version/payload`，旧原始 JSON 视为 v1 并走 upcast |

## 1. M3 分步计划（每步独立提交，各自带验收）

| 步 | 内容 | 验收（可跑） | 状态 |
|---|---|---|---|
| **1** | **schema 演进地基**：事件信封 + upcast 注册表（读取期）+ 快照版本策略 + 内核 `evolution` 最小 hook | **v1 数据在 v3 代码下可读**（upcast 链单测 + 真实 Actor 重放集成测试）；旧原始 JSON **不改一行**即可读；快照版本不匹配时迁移或**拒启动**；内核不回归 | ⏳ 本文档 |
| 2 | **Aggregate**：命令→事件、`expectedVersion` 乐观并发、快照缓存 + 事件重放（含 offset） | 同一聚合被两个节点同时拥有时，旧 epoch 的写入被拒；崩溃重启后状态一致 | — |
| 3 | **Repository**：file / memory / SQL 薄适配 + **游标分页**（不用 offset） | 并发写入下游标分页不漏不重；外部 ORM 适配示例可跑 | — |
| 4 | **迁移框架**：版本表 + 幂等 `up/down` + 启动校验 | 中途崩溃可重入；有未应用迁移时默认**拒绝启动** | — |
| 5 | **Outbox**：事件与 outbox 同批写入 + dispatcher + 至少一次投递 | 投递至少一次；消费方按 `eventId` 去重有测试；失败进死信、积压进指标 | — |
| 6 | **投影**：订阅 / checkpoint / 去重 / 重建 | 从 0 重建**不丢不重**；离线重建 + 原子切换 | — |

## 2. 第 1 步详细设计

### 2.1 事件信封（新写入的格式）

```json
{"eventId":"evt-8f3c…","type":"ItemAdded","version":2,"at":1791200000000,"payload":{"price":100,"currency":"CNY"}}
```

| 字段 | 作用 | 备注 |
|---|---|---|
| `eventId` | 全局唯一 | 后面 outbox 去重与投影幂等**必须**有它，所以现在就把位置留出来 |
| `type` | 事件类型（upcast 链按它查找） | 必填 |
| `version` | 该事件的**结构版本**（从 1 开始） | 必填 |
| `at` | 写入时间 | 诊断/审计用；不参与推导 |
| `payload` | 当前版本的事件体 | 内核 `applyEvent` 收到的是它**升级后的形状** |

**只有 `payload` 参与状态推导**：`type/version/at/eventId` 是元数据。这样"升级"就是纯数据变换，
不触碰业务代码。

### 2.2 读取期管线（旧数据兼容的关键）

```
store.loadEvents(path)
  → 每条 raw 进 registry.upcast(raw)：

    ① 有信封（type+version+payload 齐备）
         → type = env.type, version = env.version, event = env.payload
    ② 无信封（M3 之前写入的原始 JSON）
         → 默认：raw 是对象且带字符串 type ⇒ 视为 { type: raw.type, version: 1, event: raw }
         → 否则：**原样透传**（= 今天的行为，零破坏）
    ③ 按 type 取 upcast 链，从 version 逐级升到当前版本
    ④ 未知 type（对端版本更新时可能出现）→ 原样透传（滚动升级不能因"不认识"就崩）
    ⑤ 返回**当前形状**的 event → 内核 applyEvent(event)
```

**事件体自带判别字段**：信封的 `type` 只用于查表，**不会注入**事件体。所以事件体
（`payload`）自己应当带判别字段（doc 04 §3 的聚合示例 `{ type: 'ItemAdded', … }` 就是如此）——
`applyEvent` 收到的永远是"当前形状的事件体"，无论是实时写入还是重放。

**关键取舍**：旧格式**不做物理迁移**。读取期解释的代价是每次重放多跑几个纯函数，
换来的是"可回滚、可重放、可双读期"——这正是 doc 04 §4.1 要的性质。

### 2.3 upcast 注册表

```ts
const schema = defineEventSchema({
  type: 'ItemAdded',
  version: 3,
  upcasts: [
    { from: 1, to: 2, up: (e) => ({ ...e, currency: e.currency ?? 'CNY' }) },   // 加可选字段
    { from: 2, to: 3, up: (e) => ({ ...e, price: Math.round(e.price * 100) }) }, // 单位改分
  ],
});
```

**构造期就报错**（不是运行到那条数据才发现）：
- `version >= 1`；`type` 非空；`up.from >= 1` 且 `to > from`；
- 同一个 `from` 不能有两条 upcast（歧义）；同一 type 不能重复注册；
- **链必须能覆盖 1 → version 的每一步**（允许一跳，如 `{from:1,to:3}`）：从 1 出发逐段前进，
  找不到下一段且还没到 version ⇒ 报"链有缺口"，并指出缺哪一段。

**纯函数约束（机械保证的部分）**：upcast 拿到的输入是**顶层冻结**的对象，改写输入会抛错
（非严格模式静默失败，但冻结后的赋值在 ESM/严格模式下 `TypeError`）。时间/随机/IO 无法机械
禁止，写进贡献指南 + 单测里用"跑两次结果相同"兜底。

**未知类型不是错误**：滚动升级期间老代码会读到新事件类型，必须放行（否则一升级就崩）。

### 2.4 快照版本策略

盘上格式（M3 起）：

```json
{"snapshotVersion":1,"stateVersion":3,"actorPath":"/user/order-1","takenAt":1791200000000,"state":{…}}
```

读取规则（`decodeSnapshot`）：

| # | 情况 | 行为 |
|---|---|---|
| 1 | `stateVersion === 代码期望` | 直接用 |
| 2 | 不匹配 + 注册了 `migrate` | 迁移后用（`migrate(state, { from, to })`） |
| 3 | 不匹配 + 无 `migrate` | **抛 `StateEvolutionError`**：拒绝启动该 Actor 并说明"缺哪个版本的迁移"，绝不静默用错结构 |
| 4 | 无信封（M3 之前的快照） | 视为 `stateVersion: 1`，落回 1/2/3 |

> doc 04 §4.2 的"无迁移但能由事件重建 → 丢弃快照重放"需要"快照 + 事件日志"同时存在，
> 当前内核的持久化模式是**互斥**的（`events` 模式完全不读快照）。这一条放到第 2 步
> （Aggregate 同时拥有事件日志与快照缓存）一起做，本文档如实标注为**未实现**。

### 2.5 内核最小 hook：`persistence.evolution`

内核**不认识信封**，只提供一个格式无关的接缝（不配置时行为与今天完全一致）：

```js
system.spawn(Order, {
  id: 'order-1',
  persistence: {
    mode: 'snapshot',
    evolution: {
      upcast: (raw) => currentShapeEvent,   // events 模式：每条事件在 applyEvent 之前调用
      decodeSnapshot: (raw) => state,       // snapshot 模式：读取时校验版本/迁移；抛错 = 拒绝启动
      encodeSnapshot: (state) => stored,    // snapshot 模式：写入时套信封
    },
  },
});
```

- 三个 hook 都是**可选**且默认恒等 ⇒ 现有用户零感知、内核测试零改动；
- hook 由数据层（`@actor/data`）产出，内核不 import 数据层（依赖方向仍然是 data → app → core，
  而 core 只认结构不认类型）；
- `decodeSnapshot` 抛错会沿 `_init → spawn` 冒泡 ⇒ `spawn` 失败并报出原因（这就是"拒绝启动"）；
- **写入期也走同一条 `upcast` 管线**（`persistEvent` 里调用）：否则实时写入会把**信封**喂给
  `applyEvent`，而重启重放时同一个事件到达的是**payload**——同一个事件两种形状，内存状态会漂移。
  这条不变量有测试（写入期与重放期结果必须一致）。

### 2.6 包结构与边界

```
packages/data/
  src/events.ts    信封 + upcast 注册表 + 旧格式兼容
  src/snapshot.ts  快照信封 + 版本策略
  src/evolution.ts defineEvolution(...) → 内核 hook 对象（结构类型，不 import 内核）
  src/index.ts
  test/*.test.ts
```

`@actor/data` 第 1 步**零依赖**（纯函数 + 结构类型），因此它既不依赖内核也不依赖 app，
依赖方向不会出现环；`test/unit-app-boundary.test.js` 的守卫思路同样适用于新示例。

## 3. 第 1 步验收标准

1. **v1 数据在 v3 代码下可读**：真实 Actor 用 `events` 模式落一批 v1 事件（含旧原始 JSON 格式），
   同一 Actor 以 v3 代码重启后 `ref.state()` 等于 v3 期望值（集成测试，不是纯函数自证）；
2. **旧格式零迁移可读**：既有的 `ctx.persist(raw)` 日志（无信封）在新的 registry 下行为不变
   （现有内核测试全绿即是证据，另加一条显式用例）；
3. **链缺口在构造期报错**：`{from:1,to:2}` 而 `version:3` ⇒ `defineEventRegistry` 抛错并指出缺 `2→3`；
4. **快照版本不匹配**：有 `migrate` → 迁移后可用；无 `migrate` → 该 Actor **拒绝启动**且错误信息
   指名 `stateVersion`；
5. **不回归**：全量 `npm test` 通过、`npm run typecheck` 0 错误。

## 4. 进展（第 1 步已完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 设计（本文档） | ✅ | 决策 A/B/C 已确认 |
| 内核 `evolution` hook | ✅ | `persistence.evolution = {upcast, decodeSnapshot, encodeSnapshot}`；默认恒等 |
| `@actor/data` 事件信封 + 注册表 | ✅ | 构造期校验链缺口/歧义/未来版本；顶层冻结输入；旧格式与未知类型原样透传 |
| `@actor/data` 快照策略 | ✅ | 四条读取规则 + `legacyVersion`；无迁移时**拒绝启动** |
| 集成验证（v1→v3） | ✅ | 真实内核 + 真实文件：旧代码写、新代码读；混合日志重放；拒绝启动不破坏数据 |
| 测试 | ✅ | `packages/data/test/*` 24 例；全量 383/383 通过；严格 typecheck 0 错误 |

### 4.1 实现中抓出的三个真问题（写在这里，因为它们是"验证反哺设计"的证据）

1. **实时写入与重放不是同一形状**（设计缺陷，本步修掉）：最初 `persistEvent` 直接把传入对象
   交给 `applyEvent`，于是新代码写信封时内存拿到的是**信封**，而重启重放时拿到的是**payload**。
   测试里表现为"写入后与重启后数字对不上"。修法：写入期也走同一条 `upcast` 管线。
2. **启动失败会覆盖数据**（数据安全缺陷，本步修掉）：快照版本不匹配导致 `_init` 抛错后，
   该 cell 仍在 `system.cells` 里；`system.stop()` 时 `_handleStop` 看到 `mode === 'snapshot'`
   就把**preStart 默认状态**存回去，覆盖掉那个"拒绝对待"的旧快照。
   修法：`_handleStop` 增加 `this.started` 守卫——只有成功启动过的 incarnation 才有资格写盘。
3. **`.gitignore` 把新包整个吃掉了**（工程陷阱）：根因是规则 `data/` 没有锚定，
   于是 `packages/data/` 被忽略——`git status` 看起来"很干净"，**新包一个文件都提交不进去**。
   修法：锚定为 `/data/`，并加守卫测试（`git check-ignore`）让这类静默失效当场失败；
   同一条守卫还顺手修掉了"按字符串扫 import 时把注释当成代码"的假失败。

### 4.2 与设计草案（doc 04）的差异

- 快照信封里**没有** `actorPath`：文件名已经由 actor 路径决定（`store/backends/naming.ts`），
  再存一遍只是冗余；`{snapshotVersion, stateVersion, takenAt, state}` 足够。
- doc 04 §4.2 的"无迁移则从事件重建"**仍未实现**（见 §2.4）：它需要"快照 + 事件日志"同时存在，
  而当前内核持久化模式互斥，放到第 2 步（Aggregate）一起做。
