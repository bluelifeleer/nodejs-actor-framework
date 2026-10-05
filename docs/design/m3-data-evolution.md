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
| **1** | **schema 演进地基**：事件信封 + upcast 注册表（读取期）+ 快照版本策略 + 内核 `evolution` 最小 hook | **v1 数据在 v3 代码下可读**（upcast 链单测 + 真实 Actor 重放集成测试）；旧原始 JSON **不改一行**即可读；快照版本不匹配时迁移或**拒启动**；内核不回归 | ✅ 已完成（§2/§4） |
| **2** | **Aggregate**：命令→事件、`expectedVersion` 乐观并发、快照缓存 + 事件重放（含 offset） | 同一聚合被两个节点同时拥有时，旧 epoch 的写入被拒；崩溃重启后状态一致 | 🚧 **2a 完成**（§3）；2b/2c 待做 |
| 3 | **Repository**：file / memory / SQL 薄适配 + **游标分页**（不用 offset） | 并发写入下游标分页不漏不重；外部 ORM 适配示例可跑 | — |
| 4 | **迁移框架**：版本表 + 幂等 `up/down` + 启动校验 | 中途崩溃可重入；有未应用迁移时默认**拒绝启动** | ✅ 已完成（§8） |
| 5 | **Outbox**：事件与 outbox 同批写入 + dispatcher + 至少一次投递 | 投递至少一次；消费方按 `eventId` 去重有测试；失败进死信、积压进指标 | ✅ 已完成（§9） |
| 6 | **投影**：订阅 / checkpoint / 去重 / 重建 | 从 0 重建**不丢不重**；离线重建 + 原子切换 | ✅ 已完成（§10） |

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

## 3. 第 2 步（2a）：事件溯源聚合 `defineAggregate`

形态选择：**返回内核认识的 handler bag**（`receive` / `applyEvent` / `state`），不是 class。
理由有两条，第二条是这次才发现的（见 §5.3）：

1. 内核的 handler bag 路径把 `this` 绑在 **cell 的实例**上，`this.state` 就是 cell 的状态；
2. 元数据（`evolution` / `registry` / `name` / `events`）可以放在**不可枚举**属性上，
   于是内核的 `unknown-keys` 拼写检查不会被误触发（`Object.keys(aggregate)` 只会有 handler 名）。

```ts
const Order = defineAggregate({
  name: 'Order',
  initialState: () => ({ status: 'created', totalCents: 0, items: 0 }),
  events: [defineEventSchema({ type: 'ItemAdded', version: 2, upcasts: [
    { from: 1, to: 2, up: (e) => ({ ...e, price: (e.price as number) * 100 }) },   // 元 → 分
  ] })],
  // 纯函数：实时处理与重启重放走**同一份**代码
  applyEvent: (state, event) =>
    event.type === 'ItemAdded' ? { ...state, totalCents: state.totalCents + event.price, items: state.items + 1 } : state,
  // 命令只做"校验 + 产出事件"，绝不直接改状态
  commands: {
    addItem: (cmd, state) => {
      if (state.status !== 'created') throw new Error('order already confirmed');
      if (cmd.price <= 0) throw new Error('price must be positive');
      return { type: 'ItemAdded', price: cmd.price };
    },
  },
});

await system.spawn(Order, { id: 'order-1', persistence: { mode: 'events', evolution: Order.evolution } });
// 应用层同理：defineModule({ actors: { Order: { definition: Order, options: { persistence: … } } } })
```

| 约定 | 说明 |
|---|---|
| 命令签名 | `(command, state) => event \| event[] \| void`；**不得改状态**（传入的是顶层冻结副本，改了当场 `TypeError`） |
| 命令返回值 | `receive` 返回**命令执行后的状态浅拷贝**，所以 `await actor.ask({type:'addItem', price:100})` 直接拿到新状态 |
| 命令名来源 | 默认 `msg.command` → `msg.type`；可用 `commandOf` 自定义 |
| 事件要求 | 事件体必须自带字符串 `type`（信封的 `type` 只用于查表，不注入事件体） |
| 版本 | 信封的 `version` 取自 `events` schema 的当前版本；未声明的类型按 `v1` 落盘 |
| 未知命令 | 抛 `UnknownCommandError`（列出已声明命令），走内核真实错误通道 |
| 定义写错 | 构造期抛 `AggregateDefinitionError`（`initialState`/`applyEvent`/`commands` 全部检查） |

**"忘了接 evolution"这条路径被单独照顾**：聚合自己会拆信封，所以当前版本的事件**不接 evolution
也能正确工作**；但如果读到**旧版本**事件而升级链没接上，会抛 `AggregateEvolutionError`
（指名类型与版本，并给出修法），而不是拿旧结构套新代码。

> 第 2b 步（快照缓存 + 按 offset 重放）与第 2c 步（`expectedVersion` 乐观并发）仍未做，
> 见 §1 的计划表与 §5 的进展。

## 4. 第 1 步验收标准

1. **v1 数据在 v3 代码下可读**：真实 Actor 用 `events` 模式落一批 v1 事件（含旧原始 JSON 格式），
   同一 Actor 以 v3 代码重启后 `ref.state()` 等于 v3 期望值（集成测试，不是纯函数自证）；
2. **旧格式零迁移可读**：既有的 `ctx.persist(raw)` 日志（无信封）在新的 registry 下行为不变
   （现有内核测试全绿即是证据，另加一条显式用例）；
3. **链缺口在构造期报错**：`{from:1,to:2}` 而 `version:3` ⇒ `defineEventRegistry` 抛错并指出缺 `2→3`；
4. **快照版本不匹配**：有 `migrate` → 迁移后可用；无 `migrate` → 该 Actor **拒绝启动**且错误信息
   指名 `stateVersion`；
5. **不回归**：全量 `npm test` 通过、`npm run typecheck` 0 错误。

## 5. 进展

| 项 | 状态 | 说明 |
|---|---|---|
| **第 1 步：schema 演进** | ✅ | 内核 `evolution` hook + `@actor/data` 信封/注册表/快照策略；集成验证 v1→v3 |
| 测试（第 1 步） | ✅ | `packages/data/test/*` 24 例；真实内核 + 真实文件（旧代码写、新代码读；混合日志重放；拒绝启动不破坏数据） |
| **第 2a 步：聚合基类** | ✅ | `defineAggregate`（命令→事件、纯 `applyEvent`、信封接入、元数据不可枚举）；单元 16 例 + 集成 4 例（内核直连 / 应用层两条路径） |
| **第 2b-① 步：`seq` + 批量读取 hook** | ✅ | 信封加**每聚合单调 `seq`**（聚合写入时发号、重放时把计数器推到同一位置）；注册表新增 `readLog(raws, {fromSeq})` —— 旧日志**按位置补号**、**断号当场报错**；内核 `_restore` 优先走批量 hook |
| **第 2c-① 步：条件写 + 后端能力** | ✅ | `appendEvent(id, event, { expectedVersion })`（不匹配抛 `PersistenceConflictError` 且不写入）；`capabilities().conditionalAppend` = `'atomic' \| 'in-process' \| false`，`file`/`memory` 如实报**仅同进程**；内核自动带上日志版本，聚合因此开箱就有乐观并发 |
| **第 2b-② 步：快照缓存 + 增量重放 + 从事件重建** | ✅ | `mode:'events'` + 可选 `snapshot:{every:N}`；快照带 `atSeq`，恢复时只重放增量；结构对不上时**有日志就丢弃快照重建**（doc 04 §4.2 规则 2）、**没日志才拒绝启动**（规则 3）；未配置时行为与以前逐字节一致 |
| 第 2c 步：`expectedVersion` 乐观并发 | ⏳ | 需要事件日志加**每聚合单调序号** + 条件追加；动手前先把格式决策摆出来 |
| 第 3–6 步 | ⏳ | Repository / 迁移框架 / Outbox / 投影 |

> **一处守卫**：应用层对 class 形态 Actor 的持久化现在会**启动期拒绝**（见 §5.3），
> 因为它此前是"写盘成功但状态恢复不出来"的静默数据错误。

### 5.1 实现中抓出的三个真问题（写在这里，因为它们是"验证反哺设计"的证据）

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

### 5.2 与设计草案（doc 04）的差异

- 快照信封里**没有** `actorPath`：文件名已经由 actor 路径决定（`store/backends/naming.ts`），
  再存一遍只是冗余；`{snapshotVersion, stateVersion, takenAt, state}` 足够。
- doc 04 §4.2 的"无迁移则从事件重建"**仍未实现**（见 §2.4）：它需要"快照 + 事件日志"同时存在，
  而当前内核持久化模式互斥，放到第 2 步（Aggregate）一起做。

### 5.3 已知缺陷：应用层的 class 形态 Actor 不能持久化（本步发现，已加守卫）

**现象（实测复现，不是推测）**：应用层声明一个 `class` Actor 并启用 `persistence: 'events'`，
命令执行后事件**确实写进了盘**，但 `ref.state()` 始终是初始值；重启后状态也恢复不出来。

**根因**：`Application.spawnActor()` 把 class 拆成 handler bag 时，是**new 一个"探测实例"**、
把方法 `bind` 到这个实例上，再把 `instance.state` 作为模板交给内核的 `HandlerActor`
（后者会**再拷一份**）。于是同一个 Actor 有两份状态：

- 用户方法里的 `this` = 探测实例（`this.state` 是它的字段）；
- cell 的 `state` = `HandlerActor` 的那份拷贝（`ref.state()`、快照、`applyEvent` 都作用于它）。

再加上转发白名单里**没有** `applyEvent` / `postRecover`，事件重放根本不会调用用户的重放逻辑。
`examples/app-web` 的 `Room` 之所以"看起来正常"，是因为它把状态放在自己的字段里、且从不使用
持久化或 `ref.state()`。

**本步的处理**（不做半吊子修复，先把静默错误变成明确错误）：

- 应用层在 `start()` 时**拒绝** "class 形态 + `events`/`snapshot` 持久化"的组合，
  错误信息给出出口（改用 handler bag / `defineAggregate`，或不开持久化）；
  内核级默认持久化（`kernel.defaults.persistence`）同样被拦住；
- 聚合因此**返回 handler bag 而不是 class**（见 §3），两条 spawn 路径都验证过；
- 有回归测试钉住（`packages/app/test/app.test.ts`）。

**正确的修法（建议，未实施）**：给内核 `defineActor` 增加"工厂"定义形态
（`{ create: () => new Cls(deps), … }`），让应用层把**真正的类实例**交给内核，
而不是探测实例 + 状态拷贝。这样 `this.state`、`ref.state()`、快照、`applyEvent` 会是同一个对象。
这是一个独立的小里程碑（改内核定义形态 + 应用层装配 + 回归测试），不属于 M3。

## 6. 第 2b / 2c 步：设计（三个决策已确认）

> **决策记录（已确认，不再改动）**：
> - **D-2b**：扩展 `events` 模式 —— `persistence: { mode: 'events', snapshot: { every: N } }`，
>   快照只是缓存，真相仍是事件日志；快照不可用时**丢弃并全量重放**；
> - **D-seq**：事件信封**加 `seq`**（每聚合单调序号）—— 快照记 `atSeq`、重放按 `seq > atSeq` 过滤，
>   且断号/错位能当场报错；旧日志在**读取期补号**，不重写盘上数据；
> - **D-2c**：`expectedVersion` = 后端条件写（能真 CAS 的后端如 SQL 走真 CAS）+ 聚合层双保险，
>   并**暴露后端能力**（`file` 后端如实标注为"仅同进程检查"）。

### 6.1 现状与缺口（已核实代码，不是推测）

| 能力 | 现状 |
|---|---|
| 恢复流程 | `ActorCell._restore()` **二选一**：`snapshot` 模式只读快照（完全不读事件日志）；`events` 模式只读事件日志（完全不读快照）。所以"快照是缓存、事件日志是真相"这个组合**今天做不到** |
| 事件日志偏移 | 盘上没有"这个状态已经应用到第几个事件"的信息，所以即使读到了快照也无法只重放增量 |
| 条件写 | `PersistenceAdapter.appendEvent(id, event)` **没有** `expectedVersion` 语义；`FilePersistence` 只是 append（无跨进程 CAS），SQL 那种"真"条件写要适配器自己提供 |
| 快照的"降到事件重建" | doc 04 §4.2 规则 2（快照版本不匹配 → 丢弃快照、从事件重放）需要一个**同时拥有**事件日志与快照的 Actor；当前模式互斥，所以这条尚未实现（§5.2 已标注） |

### 6.2 决策 D-2b：快照与事件日志共存的形态

| 选项 | 说明 | 评价 |
|---|---|---|
| **(a) 扩展 `events` 模式**（`persistence: { mode: 'events', snapshot: { every: N } }`） | 内核在 events 模式里额外读写快照；快照里记"已应用到第几个事件"；恢复时先读快照、再重放增量；快照不可用（版本不匹配）就**丢弃并从 0 重放** | **推荐**。模式语义不变（真相仍是事件日志），`snapshot` 只是"多久存一次缓存" |
| (b) 新增模式 `'events+snapshot'` | 语义更显式，但模式数量变多，且与 `'snapshot'` 的区别要靠文档解释 | 备选 |
| (c) 数据层自己做（内核不参与） | 不行：恢复流程由 `_restore()` 独占，数据层拿不到"重放到一半"的控制权 | 排除 |

**D-2b 已确认 (a)**：`mode: 'events'` + 可选 `snapshot: { every }`（也可以只在 `ctx.saveSnapshot()` 时手动存）。

### 6.3 决策 D-seq：偏移量怎么表示

| 选项 | 说明 | 代价 |
|---|---|---|
| **(a) 只在内核内部计数** | 快照里存"已包含 N 条事件"（内核元数据，写在快照的外层包装里）；重放时 `events.slice(N)`。**盘上事件格式一个字都不用改** | 日志被截断/手工改动后，计数会**静默错位**（读到错的状态） |
| (b) 事件信封加 `seq`（每聚合单调序号） | 快照记 `atSeq`，重放时按 `seq > atSeq` 过滤；错位能**当场发现**（序号不连续即报错）；同时它是 2c 条件追加的基础 | 要再动一次盘上格式（读取期仍可兼容：无 `seq` 的旧日志按顺序补号） |

**D-seq 已确认 (b)**，理由与第 1 步的 `eventId` 相同：**事后加字段会造成第二次格式变更**，而
`seq` 同时服务"快照续跑"与"乐观并发"两件事；且它能把手改日志从"静默错位"变成"明确报错"。
实现上注意：读取期补号需要"看到整段日志"，而当前的 `evolution.upcast` 是**逐条** hook ——
所以要新增一个**批量**读取 hook（`readLog`），内核 `_restore` 优先用它（没有就退回逐条 upcast）。

### 6.4 决策 D-2c：`expectedVersion` 到底在哪儿拦

| 选项 | 说明 | 评价 |
|---|---|---|
| (a) 后端级条件写（`appendEvent(id, event, { expectedSeq })`，由适配器保证原子） | SQL/etcd 这类后端能做**真**CAS；file/memory 只能做**同进程**检查 | 语义最"对"，但必须如实写明 file 后端在跨进程下**不保证**（否则就是假承诺） |
| (b) 只在数据层/Repository 层做实体级乐观锁（实体自带 `version`） | 与事件日志解耦，实现简单，作用域是本进程 + 后端自身能力 | 挡不住"两节点同时拥有同一聚合"（doc 04 §3 想防的正是这个） |
| **(c) (a) + (b)** | 后端能 CAS 就用 CAS；聚合层同时维护 `expectedSeq`，并在不支持的 backend 上**明确记录降级** | **推荐**：不假装 file 后端有跨进程原子性，也不放弃 SQL 上的真保护 |

**D-2c 已确认 (c)**，并且实现时把"当前后端是否支持条件写"作为可查询能力暴露出来
（`adapter.capabilities()` 之类），让"以为有保护、其实没有"这种情况不可能发生。

### 6.5 实施顺序（已定，按此执行）

> 进度：① ✅ ② ✅ ③ ⏳ ④ ⏳（④ 与 ② 是同一件事的两半：② 提供条件写，④ 让聚合把整批事件
> 作为原子批次使用它）

1. ✅ **已完成**：事件信封加 `seq` + 批量读取 hook（`readLog`，读取期给旧日志补号、检查序号连续、
   断号当场报错）；内核 `_restore` 优先用批量 hook；
2. ✅ **已完成**：`appendEvent` 支持条件写（`expectedVersion`）+ 后端能力查询
   （`system.persistenceCapabilities()`）；内核 `persistEvent` 自动带上日志版本；
3. ✅ **已完成**：`mode: 'events'` 支持可选快照（`snapshot: { every }`）——恢复时"快照 + 增量重放"
   （用 `readLog({ fromSeq })`），快照不可用时**丢弃并从事件重建**（doc 04 §4.2 规则 2）；
   没有日志可重建时仍然拒绝启动（规则 3）；
4. ⏳ 聚合层把命令产出的整批事件作为一个**原子批次**写入（当前是逐条条件写：一条命令的第二条若冲突，
   第一条已经落盘——日志仍自洽，但不是"命令级原子"）；

### 6.7 可选快照缓存的实现说明（第 2b-② 步）

| 点 | 做法 |
|---|---|
| 谁是真相 | **事件日志**。快照只是缓存，里面记着"这是重放到第几条时的状态"（内核外层包装 `{ __snapshotAtSeq, snapshot }`），恢复时只重放 `seq > atSeq` 的增量 |
| 与数据层格式的分工 | 内核只包"恢复到第几条"，**用户状态仍由数据层的 `encodeSnapshot`/`decodeSnapshot` 决定形状**（两个信封各管一层） |
| 三种恢复结果 | ① 快照可用 → 装状态 + 增量重放；② 快照**不可用**（结构版本对不上等）且**有日志** → 丢弃快照、从 0 全量重放（doc 04 §4.2 规则 2，记一条 `snapshot_unusable` 日志）；③ 不可用且**没有日志** → **拒绝启动**（规则 3） |
| 什么时候存 | `every > 0`：每写 N 条事件自动存一次（**在事件应用到内存状态之后**——否则缓存会记下"已包含这条"却存着不含它的状态）；`every: 0`：只手动 `ctx.saveSnapshot()`；停机时若启用了缓存也会存一次 |
| 自动存失败 | 只记日志（`snapshot_auto_failed`）：事件已经 durable，缓存失败不该让命令失败 |
| 兼容性 | 没配置 `snapshot` 时行为与 M3 之前**逐字节一致**（手工 `ctx.saveSnapshot()` 仍写裸状态，也不会被当成缓存读）——"可选"是真的可选 |
| 聚合侧 | `defineAggregate({ snapshot: { version, migrate } })` 让聚合自己声明状态结构版本；配合快照缓存即可获得"迁移 / 重建 / 拒绝启动"三条策略 |

### 6.6 条件写的实现说明（第 2c-① 步）

| 点 | 做法与理由 |
|---|---|
| "版本"用什么表示 | **已写入的记录条数**，而不是"事件信封里的 `seq`"。理由：后端要保持**格式无关**（它们不认识信封）；而 `readLog` 已保证 `seq` 连续，所以条数 == 最后一条的 `seq` |
| 谁提供期望值 | 内核：`_restore` 时把日志版本记下来（数据层有 `seq` 就用 `lastSeq`，否则用条数），每次成功追加 +1，写入时作为 `expectedVersion` 带上。所以**聚合与普通 Actor 都自动获得**这个保护，不需要业务代码配合 |
| `file` 后端怎么做 | 缓存 `{size, count}`：靠**文件大小**判断有没有别人追加过（同进程里可能有第二个指向同一目录的实例），只解析新增的那段字节。跨进程**不保证**，能力如实报 `'in-process'` |
| 不支持的后端 | 内核不传条件（避免"以为有保护"），并在 spawn 时记一条 `persistence_concurrency_unsupported` 日志；`system.persistenceCapabilities()` 可查 |
| 失败语义 | `PersistenceConflictError`（`PersistenceError` 子类），带 `{ actorId, expectedVersion, actualVersion }`；**不写入**。第二个拥有者必须重新加载后才能继续 |

**边界（写清楚，避免误用）**：这一层挡的是"同一份存储被两个 writer 抢"。它**不是**分布式锁，
也不解决"两个节点都自认为拥有这个聚合"的选主问题（那属于 M4 的分片所有权 + fencing token）。

## 7. 第 3 步：Repository（设计 + 待确认）

### 7.1 接口（doc 04 §2 已定，实现时不变）

```ts
interface Repository<T, Id> {
  findById(id: Id): Promise<T | null>;
  findMany(query: Query): Promise<{ items: T[]; cursor?: string }>;   // 游标分页，不用 offset
  insert(entity: T): Promise<T>;
  update(id: Id, patch: Partial<T>, opts?: { expectedVersion?: number }): Promise<T>;
  delete(id: Id): Promise<boolean>;
  transaction<R>(fn: (tx: Repository<T, Id>) => Promise<R>): Promise<R>;
}
```

**非目标**（doc 06 §3）：不做自研 ORM / 查询构建器；SQL 走"薄适配器 + 用户提供的 `query` 函数"，
外部 ORM（Prisma/Drizzle/Kysely）给约 30 行的实现示例。

### 7.2 已定：游标里必须带 tie-breaker（这条没有别的正确选项）

`cursor` = 不透明编码的 `{ orderBy 值, id }`。只放排序键值的话，"排序键相同的多行"在翻页边界
会被漏掉或重复——而这正是 doc 04 §2 用游标替代 offset 要解决的那类问题。cursor 只由适配器解释，
用户不得依赖其内部结构（换适配器即失效）。

### 7.3 三个决策（已确认）

> **决策记录（已确认，不再改动）**：
> - **D-repo-1**：`where` **等值过滤** + **单键 `orderBy`** + 游标分页（不做表达式树、不做查询构建器）；
> - **D-repo-3**：`file` 适配器 = **一实体一文件 + 按排序键的追加式索引（含 tombstone）**，
>   索引是缓存、不自洽时以实体文件为准；
> - **D-repo-4**：`version` 由**适配器维护**（`insert`=1、`update` 自增；`expectedVersion` 不匹配抛冲突），
>   并用 `repository.capabilities()` 如实标注 `'atomic'` / `'in-process'`。

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| ~~D-repo-1~~ | 查询表达力（**已确认 (a)**） | (a) `where` 等值过滤 + 单键 `orderBy` + 游标；(b) 支持 `gt/lt/in/prefix` 的小表达式树；(c) 完全不给 `findMany` | **(a)**：DTO 级够用，且**不滑向查询构建器**（非目标）。复杂查询交给 SQL/ORM 适配器 |
| ~~D-repo-3~~ | `file` 适配器形态（**已确认 (a)**） | (a) 一实体一文件 + **按排序键的追加式索引**（含 tombstone）；(b) 一实体一文件，`findMany` 扫目录；(c) 不提供 file 适配器 | **(a)**：`findMany` 不必 O(n)；并写清"索引是缓存，不自洽时以实体文件为准" |
| ~~D-repo-4~~ | `version`（乐观锁）谁维护（**已确认 (a)**） | (a) 适配器维护实体上的 `version`（insert=1、update 自增，`expectedVersion` 不匹配抛冲突）；(b) 用 `updatedAt` 时间戳；(c) 完全交给后端 | **(a)**，并沿用第 2c 步的思路：`repository.capabilities()` 如实说明本适配器的 `expectedVersion` 是 `'atomic'` 还是 `'in-process'`（SQL 可走真 CAS，file 只能同进程） |

定下来之后的实施顺序：① memory 适配器 + 游标分页语义（并发写入下不漏不重的测试）→
② `file` 适配器（索引 + tombstone + 重建索引）→ ③ SQL 薄适配器（用户提供 `query`）+ ORM 示例 →
④ 接入文档与示例（`examples/` 里给一个 CRUD + Actor 的组合）。

### 7.4 实施进展

| 步 | 内容 | 状态 |
|---|---|---|
| ① | **memory 适配器 + 游标分页语义**（它同时是**语义基准**：file / SQL 必须逐条对齐） | ✅ |
| ② | `file` 适配器（一实体一文件 + 追加式索引 + tombstone + 索引重建/压缩） | ✅ |
| ③ | SQL 薄适配器（用户提供 runner）+ 外部 ORM 示例 | ✅ |
| ④ | 示例应用（CRUD + Actor 组合） | ⏳ |

**① 定下的语义（后面两个适配器必须对齐这 7 条）**：

1. `insert`：没有 id 就生成；`version` 由适配器设为 1；重复 id 抛 `RepositoryDuplicateError`（不覆盖）；
2. `findById` / `findMany` 返回**副本**——调用方怎么改都影响不到仓储；
3. `update`：局部 patch；**id 不可改**（否则游标与索引都会失效）；`version` 自增；
   `expectedVersion` 不匹配抛 `RepositoryConflictError`（带 `expectedVersion`/`actualVersion`）且**不写入**；
   实体不存在抛 `RepositoryNotFoundError`；
4. `findMany`：`where` 等值过滤（只接受原始值，`undefined` 明确报错而不是"匹配所有/什么都不匹配"）、
   单键 `orderBy`（默认 id）、`direction`、`limit` 1..1000（默认 50）；
5. 游标 = 不透明 base64(`{排序键值, id}`)，**带 tie-breaker**；翻页判据是"严格排在游标之后"，
   而不是数组下标（下标在并发写入下会漂移）；
6. **多取一条**判断有没有下一页；没有下一页时**不给 `cursor`**（调用方不需要猜）；
7. `transaction`：内存里串行化（并发"读—改—写"不丢更新）；file 是"进程内串行 + 后端各自保证"，
   SQL 交给 `BEGIN/COMMIT`——能力沿用第 2c 步的规矩**如实上报**（`capabilities().conditionalUpdate`）。

**这一条的对照证据**（测试里两条断言并列）：在"边翻页边写入"的模式下，游标分页让原有 100 条
**恰好各出现一次**，而同一模式下的 offset 分页**确实重复了**——这就是仓储只用游标的原因。

### 7.5 第 3 步② 的实现说明（file 适配器）

| 点 | 做法 | 理由 |
|---|---|---|
| 布局 | `<dir>/entities/<id>-<hash>.json`（一实体一文件，**tmp + rename** 原子替换）+ `<dir>/index.jsonl`（追加式） | 实体文件是真相；写完即原子，读到的要么旧版要么新版 |
| 索引到底索引什么 | **按 id**：`{id}` = 存在，`{id, deleted:true}` = tombstone | ⚠️ **与 §7.3 里"按排序键的追加式索引"的措辞有出入**：`orderBy` 是查询参数（任意字段），一个索引不可能服务所有排序键。所以索引服务**默认排序（id）**：`orderBy: id` 时不必读实体文件；**其它排序字段必须读实体文件（O(n)）**——文件后端如实如此，大表请用 SQL/ORM 后端 |
| `update` 与索引 | **完全不碰索引** | id 集合没变 ⇒ "实体写了、索引没写"这个崩溃窗口对更新**根本不存在**（只有 `insert`/`delete` 才追加索引条目） |
| 索引是缓存 | `rebuildIndex()` 以实体文件为准重建；索引文件不存在但实体目录有文件时**自动重建**；索引条目指向的文件不存在时跳过该条 | 手工删过文件、或索引丢了都能自愈 |
| 索引膨胀 | `compactIndex()` 折叠同一 id 的重复条目；条目超过 `compactThreshold`（默认 5000）自动压 | 追加式索引迟早要压 |
| 撕裂尾巴 | 索引解析遇到第一条读不通的行就停（与内核的事件日志同一规则） | 崩溃中断的追加不该让整个仓储读不出来 |
| 契约对齐的方式 | **共享契约测试**（`packages/data/test/repository-suite.ts`）：一份断言跑在两个适配器上 | 抄一遍测试会漂移；共享套件让"对齐"变成机械事实。file 适配器现在还额外验证了"跨实例存在 / 索引丢失后自愈 / 压缩 / 非 id 排序" |

### 7.6 第 3 步③ 的实现说明（SQL 薄适配器）

**"薄"到什么程度**：框架只发固定形状的 CRUD（`SELECT` / `INSERT` / `UPDATE … WHERE version = ?` /
`DELETE`），**连接数据库的能力全部由你提供**（`SqlRunner`：`all` / `run` / 可选 `transaction`）。
不接管 schema、不引驱动、不做查询构建器——`fields` 白名单就是"你的表长什么样"的唯一声明。

```ts
const runner: SqlRunner = {
  all: async (sql, params) => (await pool.query(sql, params)).rows,          // pg
  run: async (sql, params) => (await pool.query(sql, params)).rowCount,
  transaction: async (fn) => { /* 见下：必须把事务范围的 runner 交给回调 */ },
};
const repo = createSqlRepository<Order>({ runner, table: 'orders', fields: ['id', 'version', 'total', 'status'] });
```

| 点 | 做法与理由 |
|---|---|
| 乐观锁 | **真 CAS**：`UPDATE … SET version = version + 1 WHERE id = ? AND version = ?`；受影响行数为 0 时再回查一次，以区分"版本冲突"与"实体不存在"。所以 `capabilities().conditionalUpdate === 'atomic'`——三个适配器里唯一的一档 |
| 事务 | `SqlRunner.transaction` **必须把"事务范围的 runner"交给回调**。这一点是必须的：仓储内部的语句走 runner，如果事务只是"你自己 BEGIN 了一下"，仓储的语句仍然走连接池，根本不在那个事务里——那样 `transaction: 'database'` 就是假承诺。有测试专门钉住这件事（事务内的读与写必须落在事务 runner 上） |
| 标识符 | 白名单：表名/列名是**配置**（构造期校验为简单标识符），`where`/`orderBy`/patch 里的字段必须在 `fields` 内，否则抛 `RepositoryQueryError` |
| 值 | **永远参数化**（含 `LIMIT` 与 keyset 参数）。有一条测试往 `owner` 里塞 `"'; DROP TABLE docs; --"`，断言表还在、查询照常 |
| NULL | `where: {field: null}` 生成 `IS NULL`（SQL 里 `= NULL` 永远不成立）；**cursor 的排序键是 null 时直接拒绝**——SQL 的 NULL 比较恒为 NULL，键值分页在这里会静默漏行 |
| 类型守卫 | `orderBy` 的比较交给数据库，所以"混合类型当场报错"这条守卫（memory/file 在 JS 里比较时有）在 SQL 上不成立——这是**真实差异**，写进契约测试的 `features` 而不是假装三个后端一样 |
| 唯一约束 | insert 撞 id 的判定由你给（`isUniqueViolation`）：驱动各不相同，框架不猜。给了它就会抛 `RepositoryDuplicateError`（与 memory/file 一致） |

**参考 runner（本仓库**真的跑过**的那个）**：`packages/data/test/repository-sql.test.ts` 用 Node 24
内置的 `node:sqlite` 包了一个 runner（零依赖，与框架"不引驱动"的取向一致），SQL 适配器的**共享契约
测试就是跑在真 SQL 上的**：

```ts
function makeRunner(): SqlRunner {
  const db = new DatabaseSync(':memory:');
  const scoped: SqlRunner = {
    all: async (sql, params) => db.prepare(sql).all(...params),      // 单连接：事务内外的 runner 相同
    run: async (sql, params) => Number(db.prepare(sql).run(...params).changes),
  };
  return {
    ...scoped,
    transaction: async (fn) => {
      db.exec('BEGIN');
      try { const r = await fn(scoped); db.exec('COMMIT'); return r; }
      catch (err) { db.exec('ROLLBACK'); throw err; }
    },
  };
}
```

**外部 ORM 示意**（doc 04 §2 承诺的"约 30 行、框架不接管你的 schema"）。下面这段是**示意代码**：
本仓库没有 Prisma 依赖，所以它没有测试覆盖——但形状就是这么简单，`all` / `run` / `transaction`
三个方法包一层即可：

```ts
// Prisma（示意）
const repo = createSqlRepository<Order>({
  table: 'Order',
  fields: ['id', 'version', 'total', 'status'],
  runner: {
    all: (sql, params) => prisma.$queryRawUnsafe(sql, ...params),
    run: async (sql, params) => Number(await prisma.$executeRawUnsafe(sql, ...params)),
    transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn({
          all: (sql, params) => tx.$queryRawUnsafe(sql, ...params),
          run: async (sql, params) => Number(await tx.$executeRawUnsafe(sql, ...params)),
        }),
      ),
  },
});
```

任何驱动（pg / mysql2 / better-sqlite3 / Drizzle / Kysely）同理——**关键是事务里要把
"事务范围的 runner"交给回调**，否则仓储的语句会跑到连接池上。

> 反面例子（**别这么做**）：把 `Repository` 做成"隐藏 SQL 的魔法层"，或让框架去猜你的表结构。
> doc 06 §3 把"自研 ORM / 查询构建器"列为不做的事，这里的每条设计都在守那条线。

## 8. 第 4 步：迁移框架（已实现）

三条纪律，实现都围绕它们（doc 04 §5）：

| # | 纪律 | 落实方式 |
|---|---|---|
| 1 | **版本表是真相** | `MigrationStore`（memory / file / sql 三个适配器）记 `{version, status, description, at}`；SQL 版只建框架自己的账本表（`schema_migrations`），**业务 schema 仍然是你的事** |
| 2 | **默认拒绝启动** | `assertApplied()` 在三种"结构不确定"下都抛错：① 有未应用迁移 → `MigrationPendingError`（列出 v 号）；② 上次执行中断 → `MigrationInterruptedError`；③ **数据里的版本比代码还新** → `MigrationVersionError`（"请先升级代码"，绝不降级跑） |
| 3 | **幂等 + 可重入** | 每个迁移**先记 `started`、成功后再记 `completed`**。跑一半崩了，版本表里留的是 `started`——框架能**指出是哪一个**，`migrate()` 下次会重跑它（所以 `up()` 必须幂等）。有测试用"第一次必抛错"的迁移证明：v1 保持 completed、v2 留 started、重跑时 v2 再执行一次并继续 v3（调用序列 `[1,2,2,3]`） |

```ts
const runner = createMigrationRunner({
  store: createFileMigrationStore({ dir: './data' }),      // 或 memory / sql
  migrations: [
    { version: 7, description: 'order events gain currency',
      async up({ store, log }) { /* 幂等 */ },
      async down({ store }) { /* 能回滚就写 */ } },
  ],
  log: (message, meta) => console.log(message, meta),
});

await runner.assertApplied();            // 启动时：不允许"结构不确定"，默认拒绝启动
const { applied } = await runner.migrate();
await runner.rollback({ to: 6 });        // 按版本降序执行 down()；缺 down 的迁移明确报错
const status = await runner.status();    // { applied, pending, interrupted, unknown }
```

**边界**：`rollback` 只做"回滚迁移"（改结构）；doc 04 §5 说的"回填搬数据"是另一件事
（大表、要能在线跑），不在本步。**CLI**（`actor migrate status|up|down`）属 M5（doc 06）——
本步只提供可编程 API，CLI 到时候接上去即可。

**与仓储/聚合的关系**：迁移改的是存储结构（表、列、索引），聚合与仓储只是它的使用者。
所以迁移测试不依赖内核：`store` 就是版本表，`up({ store })` 里可以拿任意数据层能力去做事。

## 9. 第 5 步：Outbox（已实现）

### 9.1 关键设计选择：**事件日志本身就是 outbox**

doc 04 §6 要求"事件与 outbox 记录在**同一次写入**里落盘"，因为"先存再发、中间崩溃就丢消息"。
如果把 outbox 做成**另一张表 / 另一个文件**，就又要面对两次写入之间的崩溃窗口（还得为此造一个
分布式事务）。而事件日志本身就是原子写入的记录：

> **事件落盘 = outbox 记录落盘**（同一次 append），投递进度只需要一个**游标**。

于是不需要新格式、不需要双写、也不需要在第 1 步的信封上再加字段——`seq`/`eventId` 已经够用
（这正是第 1 步把它们留出来的原因）。

### 9.2 语义（每条都有测试）

| 语义 | 实现 | 证据 |
|---|---|---|
| **至少一次** | **发布成功之后才推进游标**。崩溃在"已发布、未推进"之间 → 下次重发 | 注入一个"写完游标前必崩"的游标：投递序列变成 `[evt-1, evt-1, evt-2, evt-3]`——第一条确实发了两次 |
| **保序** | 一条失败就停在这一条（后面的先不发） | 第二条失败时，游标停在 1、第三条不投 |
| **毒消息不堵死** | 重试到 `maxAttempts`（默认 3）后进死信并**跳过**它，继续后面的 | 第二条永远失败 → 第二次 drain 时进死信、第三条照常投递 |
| **消费幂等** | `createDedupeSet({ repository })`：**直接复用第 3 步的仓储**——`insert` 撞主键就是"重复投递" | memory / file / **SQL（主键约束，真去重）**三种仓储都验过：同一 `deliveryId` 三次投递 → `handled / duplicate / duplicate`，业务只跑一次 |
| **可过滤** | `select(entry)` 决定哪些事件要投；被过滤的也**推进游标**（否则每轮都要重读） | 只投 `ItemAdded`：`skipped=1`，游标推到 3 |
| **游标可持久** | memory / file（原子写、跨实例）/ SQL（自动建表）三个适配器 | 跨实例读取、损坏时明确报错 |

```ts
const dispatcher = createOutboxDispatcher({
  reader: createOutboxLogReader({ loadRecords: () => store.loadEvents('order-1'), registry: Order.registry, actorPath: 'order-1' }),
  cursor: createFileOutboxCursor({ dir: './data' }),
  publish: (entry) => pubsub.publish('orders', entry.event),          // 你的投递通道
  select: (entry) => (entry.event as { type: string }).type !== 'Internal',
  onDeadLetter: (entry, err) => deadLetters.add(entry, err),          // 接内核的死信/指标
  log: (message, meta) => console.log(message, meta),
});

await dispatcher.drainOnce();                 // 手动跑一轮（测试/运维都方便）
dispatcher.start({ intervalMs: 1000 });       // 或起轮询
await system.spawn(dispatcher.asActor(), { id: 'outbox' });   // 或当 Actor 用
```

### 9.3 如实记录的两处边界

1. **轮询用的是 `setInterval`**：内核还没有可注入时钟/定时器（M0.2 的原语尚未实现，见
   `docs/design/m0/02-primitives.md`），所以 dispatcher 自己用 `setInterval` + `postStop` 清理 +
   `unref()`（不钉住进程）。内核定时器到位后，这里换成 `ctx.schedule(...)` 即可——接口不用变。
2. **死信与指标只给钩子**：数据层不依赖内核，所以 `onDeadLetter` / `stats()` 是回调与数字；
   接到内核的 `deadLettersPlugin` / `metricsPlugin` 是**应用层**的事（上面注释里的那一行）。
   跨节点投递同理：`publish` 由你用 pubsub/集群实现，本步不做。

**证据（测试）**：`packages/data/test/outbox.test.ts` 8 例，含"至少一次"的注入式崩溃、
"毒消息跳过"、"三种仓储的去重"、以及**用真内核 spawn `asActor()` 轮询投递 / 停掉后不再投**。

## 10. 第 6 步：投影 / 读模型（已实现）

**为什么需要**：列表 / 搜索 / 统计用 Actor 做不了（Actor 是单实体串行）。写路径走 Actor，
读路径走投影（普通仓储 + 索引）。

**它几乎不用新地基**——第 5 步的三件东西正好复用：

| 复用 | 作用 |
|---|---|
| `OutboxCursorStore`（游标） | **断点续跑**：崩了从上次处理到的序号继续 |
| `createDedupeSet`（仓储主键） | **恰好一次**：至少一次投递下的去重 |
| `registry.readEntries` + `createOutboxLogReader` | 事件来源（含升级与序号连续性检查） |

```ts
const runner = createProjectionRunner({
  projection: {
    name: 'user-list',
    subscriptions: ['UserCreated', 'UserRenamed'],       // 不订阅的也会推进游标
    async handle(entry, ctx) {                            // 必须幂等
      const e = entry.event as { userId: string; name?: string };
      const row = await ctx.repository.findById(e.userId);
      if (row === null) await ctx.repository.insert({ id: e.userId, name: e.name, events: 1 });
      else await ctx.repository.update(e.userId, { name: e.name, events: Number(row.events) + 1 },
                                      { expectedVersion: Number(row.version) });
    },
  },
  reader, repository: userListRepo, dedupeRepository: dedupeRepo, cursor: createFileOutboxCursor({ dir }),
});

await runner.catchUp();          // 从断点追到最新
await runner.waitFor(offset);    // "读己之写"：等追到某个序号（**超时报错**，不无限等）
await runner.rebuild();          // 从 0 重建（也可 rebuild({ repository: shadow }) 灌影子读模型）
await system.spawn(runner.asActor(), { id: 'user-list' });
```

### 10.1 三个容易踩的点（都写进了实现与测试）

1. **重建必须同时清空去重集合**。只清读模型的话，重放会被自己的去重记录全部挡成"重复"，
   结果读模型是空的——所以 `rebuild()` 默认清三样：读模型、游标、去重集合
   （`keepDedupe: true` 可以保留，但你要知道自己在干什么）。
2. **handler 失败时要撤掉那条去重记录**。否则"失败 → 游标不推进 → 下次重试"会变成
   "下次被当成重复而**永久跳过**"——那才是真正的丢数据。测试专门验了这条：
   失败一次的事件在重试时**确实会再执行**。
3. **`backlog` 必须是真实总量**。第一版用"读一批的条数"当积压，于是 batchSize=2 时积压永远
   ≤2——`status()` 会骗人。测试抓到后改成按批读到尾（`status()` 是诊断调用，不在热路径上），
   outbox 的 `stats()` 同样修了。

### 10.2 与 doc 04 §7 的对应

| doc 04 §7 的要求 | 本步的做法 |
|---|---|
| 投影用普通仓储 + 索引 | `ctx.repository` 就是第 3 步的任意仓储（memory/file/**SQL**） |
| 按 `eventId` 去重 | `deliveryId`（= `eventId`，老事件回退到 `path#seq`）→ 仓储主键 |
| `checkpoint(event.offset)` | runner 在 handler 成功后推进游标（ctx.checkpoint 也开放给用户） |
| `rebuild --from 0` | `rebuild()`；**离线重建 + 原子切换**用 `rebuild({ repository: shadow })`，指针切换由调用方做（数据层不假设你的"表"怎么切） |
| 最终一致 + 读己之写 | 默认最终一致；`waitFor(offset)` 给需要"读己之写"的接口用 |
| 一致性字段 | 读模型行自带 `version`（仓储维护），接口可以把它返回给前端 |

## 11. M3 验收对照（doc 06 的三条，逐条给证据）

| doc 06 的验收 | 证据 |
|---|---|
| **改一次状态结构的真实演习：v1 数据在 v3 代码下可读（有 upcast 单测）** | §2/§4 的 upcast 链单测 + **真实内核 + 真实文件**的集成测试（旧代码写 v1 原始 JSON → 新代码读出 6000 分，且盘上日志一字节不改）；聚合侧还有 v1→v2 的端到端（`items=1` 只可能来自事件重放，证明状态不是从旧快照来的） |
| **投影可从 0 重建且不丢不重（带去重用例）** | §10 的 `rebuild()` 用例：重建前后读模型**逐行一致**，每个事件只计一次；另有"游标回退后重放被去重挡住"的用例（业务恰好一次） |
| **outbox 至少一次 + 消费幂等有测试** | §9：注入"发布成功但游标未落盘"的崩溃 → 投递序列出现重复（`[evt-1, evt-1, …]`）；三种仓储（memory/file/**SQL 主键**）的去重用例都在 |

**M3 六步全部完成**：schema 演进 → 聚合 → 仓储 → 迁移 → outbox → 投影。数据层只依赖内核的
**结构型**接缝（`persistence.evolution`），`packages/data/src` 里没有一行 `import` 内核或 app
（有守卫测试钉住）。
