# 数据层与 schema 演进（设计草案）

> 对应开放问题 Q5。立场先说：**不自研 ORM**。自研 ORM 是无底洞，而且与 Actor 模型的优势无关。
> 数据层真正该提供的是三件事：**仓储接口**、**事件溯源聚合**、**schema 演进**。

## 1. 三层职责

| 层次 | 解决什么 | 与现有代码的关系 |
|---|---|---|
| **Repository（仓储）** | 单实体的读写、查询、分页 | 适配 `src/store/backends/*`；SQL/NoSQL 通过适配器接外部库 |
| **Aggregate（事件溯源聚合）** | 状态如何由事件推导、并发如何保证、结构如何演进 | 构建在已有 `persistence: { mode: 'events' }` + `applyEvent` 之上 |
| **Projection（投影/读模型）** | 列表/统计/搜索这类"跨实体"查询 | 新增；订阅事件流维护查询视图 |

**分工原则**：写路径走 Actor（串行、有状态、可事件溯源）；读路径走投影（可水平扩展、可重建）。**不要用 Actor 做列表查询**。

## 2. Repository

```js
/** 仓储契约（数据层提供，具体后端由适配器实现） */
interface Repository<T, Id> {
  findById(id: Id): Promise<T | null>;
  findMany(query: Query): Promise<{ items: T[]; cursor?: string }>;   // 游标分页，不用 offset
  insert(entity: T): Promise<T>;
  update(id: Id, patch: Partial<T>, opts?: { expectedVersion?: number }): Promise<T>;
  delete(id: Id): Promise<boolean>;
  transaction<R>(fn: (tx: Repository<T, Id>) => Promise<R>): Promise<R>;
}
```

**适配器**：
- `@actor/data/repository/file`（复用现有 file store，用于小数据/本地）
- `@actor/data/repository/memory`（测试）
- `@actor/data/repository/sql`（**薄封装**，用户传入自己的 `query` 函数；框架不生成 SQL）
- **外部 ORM 适配**：文档给出 Prisma/Drizzle/Kysely 的 `Repository` 实现示例（约 30 行），明确"框架不接管你的 schema 定义"。

**游标分页而非 offset**：offset 在并发写入下会漏/重，文档要写清这点。

## 3. 事件溯源聚合（差异化能力）

```js
class Order extends Aggregate {
  static initialState() { return { status: 'created', total: 0, version: 0 }; }
  static eventSchema = { version: 1, upcast: { /* 见 §4 */ } };

  // 纯函数：只用事件推导状态，禁止副作用
  applyEvent(state, event) {
    switch (event.type) {
      case 'ItemAdded':  return { ...state, total: state.total + event.price };
      case 'Confirmed':  return { ...state, status: 'confirmed' };
      default:           return state;
    }
  }

  // 命令：校验 → 产出事件（不直接改状态）
  addItem(cmd, state) {
    if (state.status !== 'created') throw new ConflictError('order already confirmed');
    if (cmd.price <= 0) throw new ValidationError('price must be positive');
    return [{ type: 'ItemAdded', price: cmd.price }];
  }
}
```

**并发**：每个聚合由一个 Actor 承载 → 天然串行；同时持久层用 `expectedVersion` 做**乐观并发**双保险（防"同一 Actor 被两个节点同时拥有"这类集群错误）。

**一致性边界**：一个聚合 = 一个 Actor = 一次事务边界。**明确禁止**跨 Actor 事务（那会引入分布式事务）；跨聚合一致性用 **saga/process manager**（一个 Actor 编排补偿）或 **outbox + 幂等消费者**。

**为什么值得做**：这是框架相对"随便写个 Service + ORM"的真正差异点——审计、时间旅行、投影重建、演进能力都从事件日志来。而 kernel 里 `events` 持久化模式已经有了，只差聚合封装与演进。

## 4. schema 演进（当前最大的空白）

现在 `events` 模式把事件原样存 JSON、`snapshot` 存状态原样 JSON——**改结构就是破坏性变更**。设计如下：

### 4.1 事件版本与 upcast

```js
// 事件带版本；读取时按注册的链逐级升级到当前版本
const upcasts = {
  'Order.ItemAdded': [
    { from: 1, to: 2, up: (e) => ({ ...e, currency: e.currency ?? 'CNY' }) },   // 加字段
    { from: 2, to: 3, up: (e) => ({ ...e, price: Math.round(e.price * 100) }) }, // 单位改分
  ],
};
```
- **只增不改**：新事件只加可选字段；语义变化必须新增事件类型（`PriceChangedV2`），不要改老事件含义。
- upcast 是**纯函数链**，必须可单测（给一条 v1 事件断言 v3 输出）。
- **禁止**在 upcast 里访问外部依赖（DB/时间/随机）——那会让重放不可重现。
- 存储层保留原始事件（只存不删），upcast 在**读取时**执行 → 可回滚、可重放。

### 4.2 快照版本与迁移

```
snapshot 文件头：{ snapshotVersion: 3, stateVersion: 12, takenAt, actorPath }
```
- 快照带 `stateVersion`；与当前代码期望不一致时：
  1. 有迁移函数 → 迁移后使用；
  2. 无迁移但能由事件重建 → **丢弃快照，从事件重放**（最安全，也最慢）；
  3. 都没有 → 拒绝启动该 Actor 并明确报错（不静默用错结构）。
- 快照是**缓存**，不是事实来源：这条原则让演进简单很多，文档要从一开始就讲清。

### 4.3 兼容策略表（写进贡献指南）

| 变更 | 兼容性 | 处理 |
|---|---|---|
| 事件加可选字段 | ✅ 兼容 | 新版本号 + 默认值 |
| 字段重命名 | ⚠️ 需要映射 | upcast 里映射 |
| 字段类型/单位变化 | ⚠️ 需要换算 | upcast 里换算 + 双读期 |
| 删除字段 | ⚠️ 先停止写入，等老数据过保留期再删 | 两阶段 |
| 改事件语义 | ❌ 不兼容 | 新增事件类型，老类型保留只读 |
| 聚合边界变化 | ❌ 高风险 | 视为新聚合 + 数据回填，别原地改 |

### 4.4 回填（backfill）

结构变化常需要历史数据转换。设计一个**回填执行器**：按聚合分片、限速、断点续跑、可重放、可并行（不阻塞在线写），并把进度暴露给 `/metrics`（复用现有指标）。

## 5. 迁移（Migration）

```js
// migrations/0007-order-currency.js
module.exports = {
  version: 7,
  description: 'order events gain currency',
  async up({ stores, logger }) { /* 幂等，可重复执行 */ },
  async down({ stores }) { /* 可选：能回滚就写 */ },
};
```
- **版本表**记录已应用迁移（存在数据层自己的 store 里）；启动时校验：有未应用迁移 → 默认**拒绝启动**（防止用旧结构跑新代码）。
- 迁移必须**幂等 + 可重入**（中途崩溃能续跑）。
- 迁移与回填分开：迁移改结构，回填搬数据（大表回填要能在线跑）。
- CLI：`actor migrate status | up | down`（doc 06）。

## 6. Outbox（原子地"改状态 + 发消息"）

**问题**：Actor 存了事件，还要通知投影/其他聚合；如果先存再发，中间崩溃就丢消息。

**设计**：
1. 事件与 outbox 记录在**同一次写入**里落盘（同一 store 事务/同一 append 批）。
2. 一个 dispatcher Actor 持续读未投递记录 → 发消息（pubsub/集群）→ 标记已投递。
3. 投递语义是**至少一次** → 消费方必须幂等（消息带 `eventId`，消费方自己去重）。
4. 失败重试 + 死信 + 积压指标（复用内置信箱/死信/指标）。

**为什么必须有**：这是"最终一致读模型"能不丢数据的前提；没有它，投影就只能靠"定期全量重建"。

## 7. 投影 / 读模型

```js
class UserListView extends Projection {
  static subscriptions = ['UserCreated', 'UserRenamed'];   // 事件类型
  async handle(event, ctx) {                                // 幂等
    await ctx.repo.upsert('user_list', event.aggregateId, { name: event.name });
    await ctx.checkpoint(event.offset);                      // 记录进度，支持断点续跑
  }
}
```
- **存在意义**：列表/搜索/统计无法用 Actor 做（Actor 是单实体串行）；投影用普通仓储 + 索引实现。
- **重建**：`actor projection rebuild user_list --from 0`（离线重建到新表，再原子切换，避免重建期间不可用）。
- **一致性**：最终一致；给 API 提供 `version` 字段，前端可判断"读到的是否够新"；需要"读己之写"时用会话级等待（响应里带上投影已追到的 offset，客户端轮询直到追上）。
- **去重**：outbox 至少一次 → 投影按 `eventId` 去重。

## 8. 与 Actor 内核的接口

| 数据层概念 | 内核能力 |
|---|---|
| 聚合状态恢复 | `persistence: { mode: 'events' }` + `applyEvent` |
| 快照 | `persistence: { mode: 'snapshot' }` + `ctx.saveSnapshot()` |
| 事件落盘 | 现有 store 适配器（file/level/memory，可扩展 SQL） |
| 至少一次投递 | outbox + 幂等消费（新增） |
| 反压/重试/死信 | ✅ 已有 |
| 定时回填/刷写 | 需要内核定时器（doc 01 §3.1） |

结论：**数据层几乎不需要改内核**，主要是在其上加聚合、演进、outbox、投影四件事。

## 9. 本节待决策

| # | 问题 | 建议 |
|---|---|---|
| D1 | 主线是"仓储优先（CRUD）"还是"事件溯源优先" | 两条都提供；文档以事件溯源为主叙事（差异化），CRUD 作为轻量路径 |
| D2 | Repository 是否自带 SQL 实现 | 不自带；给"薄适配器 + 外部 ORM 示例" |
| D3 | 快照结构不兼容时的默认行为 | 能从事件重建就重建；不能则拒绝启动并报错 |
| D4 | 迁移未应用时是否拒绝启动 | 默认拒绝（可显式覆盖，仅限开发环境） |
| D5 | 投影重建是否需要停机 | 不需要（离线重建 + 原子切换） |
| D6 | 是否提供多租户隔离 | 提供"每租户一个 store 前缀/库"的约定，不做框架级租户上下文 |
