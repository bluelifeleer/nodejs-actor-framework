# M7 设计：多数据库支持（Redis / MongoDB / 用户自装适配器）

> 用户需求四条：(1) 加 Redis 适配器；(2) 加 MongoDB 适配器；(3) 支持用户自己安装驱动并接入；
> (4) 支持本框架未定义的其他数据库的**管控**（连接、连接池、连接保持、断开…）。
>
> 本文是**定稿设计**（先设计后实现）。实现计划见 §9，验收见 §12。

## 1. 关键判断：四条需求是同一件事的四个侧面

现在 `@actor/db` 里三件事**焊在一起**：

| 层 | 现状（代码） | 是否 SQL 专有 |
|---|---|---|
| 协议/语义 | `Runner`（`all/run/transaction/insertReturning`）、`DialectSpec` | `Runner` 是 SQL 形状；`DialectSpec` 是 SQL 专有 |
| 连接生命周期 | 驱动懒加载、`PoolOptions` 映射、`healthCheck/close/stats` | **完全不专有**：Redis / Mongo / 任何库都一样 |
| 应用接线 | `databasePlugin`（配置节、注册服务、停机关池） | **完全不专有** |

实测现状：`packages/db/src` 23 个文件、`index.d.ts` **88 条**公开声明；其中真正 SQL 专有的是
`dialects/`（6 文件）+ `model/mapping/repository/schema`，而 `drivers/resolve.ts`（驱动解析）、
`drivers/types.ts`（池形状）、`plugin.ts`（生命周期接线）**与 SQL 无关** —— 这三块正是四条需求要复用的。

**结论**：把"连接管控 + 驱动解析 + 应用接线"提炼成**与数据库无关的核心**，各数据库只提供**协议适配器**：
Redis 是 KV 适配器、MongoDB 是文档适配器、SQL 是"已有方言体系"的适配器，用户自装的就是任意适配器。

## 2. 已定决策（用户已拍板）

| # | 决策 | 影响 |
|---|---|---|
| 1 | 抽 **`@actor/db-core`**，`@actor/db`/`@actor/redis`/`@actor/mongodb` 都依赖它 | 新包 + 一次真搬迁（见 §8 兼容红线） |
| 2 | Redis **同时支持** `redis`(node-redis) 与 `ioredis` | 双驱动 = 双份事件映射与测试（见 §5.1） |
| 3 | MongoDB 要做 **`defineCollection`**（索引 + `$jsonSchema` validator + `sync` 漂移检测） | 与 SQL 的 `defineModel` 体验对齐（见 §6.3） |
| 4 | **要**可选真库测试，并给 pg/mysql/mssql **也补上** | 一套契约两种运行方式（见 §7） |
| 5 | 驱动自带重连 → 框架**只转发事件**，不重复实现 | 框架不接管驱动连接生命周期（见 §4.3） |
| 6 | 允许**多实例**，按 name 注册服务 | `ctx.get('cache')` / `ctx.get('queue')`（见 §4.5） |

## 3. 目标结构

```
packages/db-core/   @actor/db-core   ← 新：契约 + 生命周期 + 驱动解析（零运行时依赖）
  adapter.ts        DatabaseAdapter / ManagedConnection / defineDatabaseAdapter()
  managed.ts        Supervisor 状态机 + 事件 + drain + defineManagedResource()
  resolve.ts        createAppRequire / loadDriverModule（从 @actor/db 搬来）
  connection.ts     NormalizedConnection 通用部分、免密 describe、URL 助手
  pool.ts           PoolOptions 与映射助手

packages/db/        @actor/db        ← SQL：现有能力全部保留，改为依赖 core
  dialects/（DialectSpec，**不动**）· model/ORM/repository/schema/mapping（**不动**）
  sql-adapter.ts    SqlAdapter = DatabaseAdapter + { dialect, runner }
  plugin.ts         databasePlugin（= 通用适配器插件 + SQL 默认实例；**签名不变**）

packages/redis/     @actor/redis     ← 新：只依赖 core（不依赖 @actor/db）
packages/mongodb/   @actor/mongodb   ← 新：只依赖 core
```

## 4. `@actor/db-core`：契约与生命周期

### 4.1 适配器契约

```ts
/** 任意数据库适配器：SQL / Redis / MongoDB / 用户自装 都实现它。 */
export interface DatabaseAdapter<C = unknown> {
  readonly kind: string;                 // 'sql' | 'redis' | 'mongodb' | 用户自定义
  readonly driverPackage: string;        // 用户要装什么（错误信息里用）
  readonly connectionKind: 'host' | 'file' | 'url';
  /** 自己的配置节 schema（并入应用配置的 `plugins.<插件名>.*`）。 */
  readonly config?: ConfigSchema;
  connectionFromUrl?(url: string): NormalizedConnection;
  describe(connection: NormalizedConnection): string;      // **永不含密码**
  /** 建连接（框架已经做完了懒加载与错误包装）。 */
  connect(input: AdapterConnectInput): Promise<ManagedConnection<C>>;
}

export interface AdapterConnectInput {
  readonly connection: NormalizedConnection;
  readonly pool: PoolOptions;
  readonly logger?: (event: string, meta?: Record<string, unknown>) => void;
  /** 由框架注入：从**应用根**解析驱动 + 缺失时给 `npm i <pkg>`（复用现有实现）。 */
  readonly load: <T>(specifier: string, packageName?: string) => T;
}

/** 连出来的东西：既能"用"（client/逃生通道），也能"管"。 */
export interface ManagedConnection<C = unknown> {
  readonly client: C;                    // 底层客户端，永远给用户留逃生通道
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  stats?(): Record<string, unknown>;
  keepAlive?(): Promise<void>;           // 驱动自带保活的可以不实现
}
```

### 4.2 SQL 只是其中一个适配器

```ts
export interface SqlAdapter extends DatabaseAdapter<Runner> {
  readonly dialect: DialectSpec;         // 现有方言描述符，一字不改
}
```
`@actor/db` 的 `databasePlugin` 变成"通用适配器插件 + SQL 的 model/repository 扩展"，
**对外签名与配置节（`plugins.db.*`）保持不变** —— 现有使用者无感。

### 4.3 连接管控：Supervisor 状态机

```
idle → connecting → ready ⇄ degraded → (driver_event) → ready … → draining → closed
```

```ts
export type SupervisionEvent =
  | { type: 'connecting'; name: string }
  | { type: 'connected'; name: string; durationMs: number }
  | { type: 'health_failed'; name: string; error: string }
  | { type: 'driver_event'; name: string; driver: string; event: string; detail?: unknown }
  | { type: 'unavailable'; name: string; reason: string }
  | { type: 'draining'; name: string; inFlight: number }
  | { type: 'closed'; name: string };

export interface SupervisionOptions {
  healthCheckIntervalMs?: number;   // 默认 0：不主动打扰，只在拿连接时探活
  keepAliveIntervalMs?: number;     // 可选空闲保活（驱动自带则不用开）
  drainTimeoutMs?: number;          // 停机：先停收新请求，等在途完成
  onEvent?: (event: SupervisionEvent) => void;   // 接日志/指标
}
```

**四条纪律**（都是这个仓库既有的原则，落到连接管理上）：

1. **绝不静默降级**：`state !== 'ready'` 时 `acquire()` **快速失败**（抛 `DbUnavailableError`），
   不排队等死；重连交给驱动，失败信息如实上报 `driver_event`/`unavailable`。
2. **不跟驱动抢重连**（决策 5）：node-redis/ioredis/MongoClient 自带的 `reconnecting/close/error`
   只做**事件转发**；框架不自己再连一套。
3. **stats 如实**：Redis 没有传统连接池 → 就报它的连接状态，**不编造 pool 数字**。
4. **drain 有超时**：等不到在途归零就超时强制关闭，并把"还有几个在途"如实报出来。

### 4.4 `defineManagedResource()`：非数据库也能纳入同一套

第 4 点最宽的解读是"框架未定义的东西也要能管"。所以核心不只服务数据库：

```ts
export const etcd = defineManagedResource({
  kind: 'etcd',
  driverPackage: 'etcd3',
  async connect({ connection, load }) {
    const { Etcd3 } = load('etcd3');
    const client = new Etcd3({ hosts: connection.url });
    return { client, healthCheck: () => client.maintenance.status(), close: () => client.close() };
  },
});
```
消息队列、对象存储、配置中心都能用同一套：懒加载、健康检查、事件、停机 drain、服务注册。

### 4.5 配置与多实例（**不发明第二套配置约定**）

插件配置在这个框架里只有**一个**落点：`PluginSpec.config` → `plugins.<插件名>.*`（环境变量
`APP_PLUGINS__<NAME>__KEY`，双下划线表示层级）。所以：

| 实例 | 插件名 | 配置节 | 环境变量 | 服务名 |
|---|---|---|---|---|
| SQL（默认） | `db` | `plugins.db.*` | `APP_PLUGINS__DB__URL` | `ctx.get('db')` |
| 缓存 | `cache` | `plugins.cache.*` | `APP_PLUGINS__CACHE__URL` | `ctx.get('cache')` |
| 队列 | `queue` | `plugins.queue.*` | `APP_PLUGINS__QUEUE__URL` | `ctx.get('queue')` |
| 文档库 | `mongodb`（默认 = kind） | `plugins.mongodb.*` | `APP_PLUGINS__MONGODB__URL` | `ctx.get('mongodb')` |

```
plugins: [
  dbPlugin({ models: [Note], repositories: { notes: Note } }),   // 现有 API 不变
  databaseAdapter(redisAdapter({ driver: 'ioredis' }), { name: 'cache' }),
  databaseAdapter(mongoAdapter({ collections: [Event] }), { name: 'mongo' }),
]
```

> 我在上一轮口头方案里提过 `databases.<name>.*` —— **纠正**：插件配置没有第二个落点，
> 硬造一套只会让配置来源分裂。统一用 `plugins.<name>.*`，`plugins.db.*` 继续有效（向后兼容）。

### 4.6 兼容红线

搬迁到 `db-core` 的东西必须在 `@actor/db` **原样 re-export**（否则是破坏性变更）：

已逐条核对**确实存在**的 12 个（M7a 开始时以当时实际导出清单为准，不许凭印象列）：

`createAppRequire` / `loadDriverModule` / `DriverResolver` / `Runner` / `PoolOptions` /
`DriverFactory` / `DriverPool` / `Row` / `DbDriverMissingError` / `DbConfigError` / `DbError` /
`DbNotConnectedError`。

**证明方式**（两道）：现有"公开面门禁"（`packages/db/test/surface.test.ts` + 手写 `index.d.ts`）
证明**导出集只增不减、签名不漂移**；724 条测试全绿证明**行为不变**。
搬迁前先把当时的导出清单导出成基线（`index.d.ts` 导出名集合），搬迁后逐条比对。

## 5. `@actor/redis` 设计（需求 1）

### 5.1 双驱动与差异吸收（决策 2）

配置 `driver: 'redis' | 'ioredis'`（**默认 `redis`**；一行可翻转）。

| 维度 | node-redis | ioredis | 适配器怎么做 |
|---|---|---|---|
| 建连 | `createClient(opts)` + `await connect()` | `new Redis(opts)`（自动连） | 分支只在适配器内部（门禁允许 `adapters/` 内部分支） |
| 订阅 | 必须 `duplicate()` 一条独立连接 | `new Redis()` 独立实例 | 适配器自动准备订阅连接 |
| 重连事件 | `ready`/`error`/`reconnecting`/`end` | `connect`/`ready`/`error`/`close`/`reconnecting`/`end` | **各自映射**到统一的 `driver_event`（决策 5） |
| 超时 | socket 选项 | `connectTimeout`/`commandTimeout` | `PoolOptions.connectionTimeoutMs` 映射过去 |

### 5.2 能力面（最小集 + 逃生通道）

`get / set / setEx / del / exists / incr / expire / ttl / mGet / mSet / hGet / hSet / hGetAll /
lPush / lRange / sAdd / sMembers / scan / multi / publish / subscribe` + `raw(command, ...args)`
（任意命令）+ `client`（原生客户端）。

原则与 SQL 侧一致：**常用语义给薄封装，逃生通道永远留着**，不做"假装完备"的 Redis ORM。

### 5.3 配置 / 序列化 / 前缀

- DSN：`redis://`、`rediss://`（TLS）、`/0` 库索引、`?` 参数；字段式 `{ host, port, password, db, tls }`。
- `prefix`：键命名空间（多租户/多环境隔离）。
- `serialize/parse`：默认 JSON，可注入（与 SQL 侧字段钩子同风格）。

### 5.4 与内核结合

`KeyValueClient` 实现现有 `ctx.pubsub` 契约 → 跨节点广播、限流、分布式锁、会话。
这是 Redis 适配器**最有价值**的部分（比"能 get/set"重要得多）。

### 5.5 v1 明确不做

**Cluster / Sentinel 拓扑**（两个驱动的 cluster API 差异大，会显著拉长工期）；
Lua 脚本管理（用 `raw('EVAL', …)`）；RedisJSON/RediSearch 模块（用 `raw`）。

## 6. `@actor/mongodb` 设计（需求 2）

### 6.1 池参数映射（与现有 mysql/pg 同一套写法）

| 框架统一形状 | MongoClient |
|---|---|
| `max` | `maxPoolSize` |
| `min` | `minPoolSize` |
| `idleTimeoutMs` | `maxIdleTimeMS` |
| `connectionTimeoutMs` | `serverSelectionTimeoutMS` |

DSN：`mongodb://` / `mongodb+srv://`；字段式 `{ host, port, database, user, password, authSource, tls }`。

### 6.2 能力面

`collection(name)` 薄封装：`find / findOne / insertOne / insertMany / updateOne / updateMany /
deleteOne / deleteMany / countDocuments / aggregate / createIndex` + 游标（`toArray`/`for await`）
+ `raw(fn)`（原生 `Db`）+ `client`。

游标恰好对上 `@actor/data` 的**游标分页**契约；`withTransaction(fn)` 与 SQL 侧同签名，
业务代码跨库写法一致。

### 6.3 `defineCollection`（决策 3）

```ts
export const Event = defineCollection({
  name: 'events',
  fields: {
    _id: { type: 'objectId' },
    type: { type: 'string', required: true },
    payload: { type: 'object', default: {} },
    at: { type: 'date', auto: 'create' },
    version: { type: 'integer', version: true },
  },
  indexes: [{ fields: ['type', 'at'], unique: false }],
  validator: { strict: true },   // 生成 $jsonSchema，交给 MongoDB 强制
});
```

- `sync()`：缺集合就建（带 `$jsonSchema` validator），缺索引就建；**漂移检测**：缺集合 / 缺索引 /
  validator 不一致 → 明确报错；**自动迁移仍需显式开启**（与 SQL 侧同一纪律）。
- **诚实边界**（必须写进指南）：MongoDB 是 schemaless —— **没有 `$jsonSchema` validator 的集合无法谈字段漂移**，
  那种情况下只能检索引漂移。框架不假装它是关系型。
- 映射约定与 SQL 侧统一：`_id` ↔ `id`、`createdAt/updatedAt`、`version` 乐观锁。

### 6.4 v1 明确不做

Change Streams（可后续作为 `watch()` 加）、分片集群管理、GridFS、聚合管道 DSL（用原生）。

## 7. 真库测试策略（决策 4）

**一套契约断言，两种运行方式**：

```
test/contract/managed-connection.ts     ← 连接管理契约套件
  断言：connect 幂等、healthCheck 语义、close 幂等（二次 close 不抛）、
        事件顺序、未就绪时快速失败、drain 语义、stats 形状
        ├── 离线：喂假驱动（CI 无库也全绿）
        └── 真库：环境变量存在才跑（否则 skip，并在输出里说明跳过了什么）
              ACTOR_TEST_REDIS_URL / ACTOR_TEST_IOREDIS_URL
              ACTOR_TEST_MONGO_URL
              ACTOR_TEST_PG_URL / ACTOR_TEST_MYSQL_URL / ACTOR_TEST_MSSQL_URL
```

- 真库跑的是**同一套断言**，避免"契约测试很漂亮、真库各说各话"。
- 附 `scripts/dev-databases.mjs`（docker compose 起 redis/mongo/pg/mysql/mssql）方便本地/CI 验。
- **诚实声明**：本仓库所在环境**离线且无 docker**，真库路径**在这里无法验证**；能保证的是
  "契约套件离线全绿 + 真库只差一个 URL"，真连库那一步必须在你的机器/CI 上见结果。
  因此真库用例的**跳过**必须显式（测试输出里能看到"跳过了 6 条真库用例"），不许静默绿灯。

## 8. 用户自装适配器（需求 3 + 4）

**薄层**（只要连接管控）：

```ts
export const myDb = defineDatabaseAdapter({
  kind: 'my-db',
  driverPackage: 'my-db-driver',
  config: { url: { type: 'string', default: '' }, poolMax: { type: 'number', default: 10 } },
  async connect({ connection, pool, load }) {
    const { Client } = load('my-db-driver');
    const client = await new Client({ url: connection.url, pool });
    return { client, healthCheck: () => client.ping(), close: () => client.end(), stats: () => client.poolStats() };
  },
});
// plugins: [ databaseAdapter(myDb(), { name: 'audit' }) ]   → ctx.get('audit').client
```

**厚层**（还要框架的查询/建模能力）：实现 `SqlAdapter`（提供 `DialectSpec` + `Runner`）或 KV/文档能力接口。
用户也可以发布 `@actor/db-xxx` 这种第三方适配器包 —— 这正是包结构选 C（core 独立）的目的。

**门禁**（否则扩展点会烂）：

1. `packages/*/src/adapters/` **之外**不得按 `kind` 分支（与现有"`dialects/` 之外 0 处方言分支"同构）；
2. 每个适配器（含用户自装示例）必须能过**连接管理契约套件** —— 这是"接口自足"的可证伪证据；
3. 新包必须进 `npm test`/typecheck 矩阵、公开面/成员级门禁、示例冒烟。

## 8.5 实施进度

### M7a（进行中）：抽 `@actor/db-core`（第一部分已完成）

已完成：
- 新建 `packages/db-core`（`@actor/db-core`，ESM、零运行时依赖、手写 `src/index.d.ts`）：
  - **搬移**：错误基类（`DbError`/`DbConfigError`/`DbConnectionError`/`DbDriverMissingError`/
    `DbNotConnectedError`/`DbConflictError`/`DbNotFoundError`）+ 新增 `DbUnavailableError`（快速失败用）、
    驱动解析（`createAppRequire`/`loadDriverModule`/`DriverResolver`）、池与运行契约
    （`Row`/`Runner`/`PoolOptions`/`BaseConnection` + `mapPoolOptions` 映射助手 + 通用的
    `DriverPool`/`DriverFactory`）。
  - **新增**：`DatabaseAdapter`/`ManagedConnection`/`AdapterConnectInput`/`defineDatabaseAdapter`、
    `defineManagedResource`、以及连接管控 `supervise()`
    （状态机 idle→connecting→ready⇄degraded→draining→closed、事件、`track()` 在途计数 + drain、
    定时健康检查/保活、`stats` 如实、驱动事件只转发）。
- `@actor/db` 改为依赖 `@actor/db-core`：删除本地 `drivers/resolve.ts`，`errors.ts` 改为再导出，
  `Row`/`Runner`/`PoolOptions` 收敛到 core 单一来源（SQL 侧的 `DriverPool`/`DriverFactory` 保留），
  `index.ts` 原样 re-export 搬走的名字。
- **公开面红线**：新增 `packages/db/test/public-surface-baseline.test.ts`（把 44 个运行时导出钉成基线，
  只增不减 + 可证伪）—— 现有 surface 门禁只保证"导出有声明"，发现不了"导出消失"，这个洞补上了。
- core 自带公开面门禁（`packages/db-core/test/surface.test.ts`，含证伪用例）。
- 矩阵接线：`packages/db-core` 进 `npm test` 工作区矩阵、`tsconfig.json` include、
  `tools/docs-site.mjs` 的 PACKAGES（API 页已收录 `supervise`/`defineDatabaseAdapter`）。
- **验证**：全量 **738/738**（724 原有 + core 12 + 基线 2）、typecheck 0（源码 + 声明面）、文档站 41 页。

尚未完成（M7a 第二部分）：把 SQL 侧连接生命周期（`database.ts`/`plugin.ts`）**接到 `supervise()` 上**。

**顺序决定（值得记下来）**：SQL 侧现在的 `connect/close/healthCheck/stats` 其实**就是** supervisor 的原型
——它是先有 SQL 实现、再提炼成通用管控的。所以"接上去"本身不产生新的对外行为，风险却全在**等价性**上：

| 现有 SQL 行为（必须保住） | supervisor 缺什么 |
|---|---|
| `connect()` 失败时：`DbError` 原样抛、其它包成 `DbConnectionError`、失败后关掉半开的池 | 需要在 **SQL 适配器**的 `connect()` 里做同样的包装（supervisor 不管错误语义） |
| 未连接时抛 **`DbNotConnectedError`**（既有测试依赖这个类型） | supervisor 抛的是 `DbUnavailableError` → 需要在边界翻译 |
| `logger` 事件串（`db_connected` / `db_closed` / `db_close_failed`） | supervisor 发的是自己的事件名 → 需要按事件回译，否则会改变日志观测 |
| `close()` 吞掉关闭错误并只记日志 | supervisor 会把错误抛出来 → 需要在边界 catch |

结论：**先把 M7b 的"连接管理契约套件"做出来，再接线** —— 这样"SQL 接上 supervisor 后行为等价"是可**被测试
证明**的（同一套断言同时跑 fake 适配器与 SQL 适配器），而不是靠人肉对比。顺序：M7a（已完成）→ M7b（契约套件）
→ 接线（SQL 走同一条路）→ M7c（Redis）。

### M7b（进行中）：连接管理契约套件

已完成：
- **契约套件进 src**（`packages/db-core/src/testing.ts`，随 `@actor/db-core` 发布）：
  `runManagedConnectionContract({ name, make, makeFailing?, supportsKeepAlive?, supportsDrain?, counters?, setHealthy? })`。
  为什么放 `src/` 而不是 `test/`：适配器包**与用户自装的适配器**都要能 import 它自证合规，而
  发布出去的包只带 `src/`。
  套件覆盖（四条纪律的可执行版本）：connect→ready 与事件、未连接/已关闭**快速失败**、close 幂等、
  连接失败如实抛出且不假装 ready、健康失败→degraded→恢复（含 `lastHealthError` 清空）、
  drain（在途归零 + 超时如实上报在途数）、**关闭后定时健康检查/保活必须停止**（用调用方提供的
  `counters` 观察真实计数，而不是空断言）。
- **跳过必须可见**：目标没提供 `makeFailing`/`setHealthy`/`counters` 时，套件用 `test(name, { skip })`
  注册**显式跳过**（测试输出里能看到 skip 的数量），不许静默少测。
- core 自己的测试改为**套件驱动**（假适配器 + 计数器 + 可切换健康状态），另保留 5 条适配器/工具专属用例
  （驱动事件原样转发、适配器 close 只调一次、`defineManagedResource` 走真实懒加载安装提示、
  `mapPoolOptions`、`loadDriverModule` 安装提示）。
- 补完 M7a 的两处遗留：`NormalizedConnection` 改为 `BaseConnection & { dialect }`（连接字段单一来源在 core）；
  新增 **kind 门禁**（`packages/db-core/test/kind-gate.test.ts`）：`<package>/src/adapters/` 之外不得按
  适配器 kind 分支（redis/ioredis/mongodb），带证伪用例 —— 与既有"方言门禁"同构的对偶门禁。
- **验证**：全量 **742/742**、typecheck 0、文档站 41 页。

### M7a 第二部分（已完成）：SQL 接到 `supervise()` 上

- 新增 `packages/db/src/sql-adapter.ts`：`createSqlAdapter({ dialect, driver })` 把既有的 `DriverFactory`
  包成 core 的 `DatabaseAdapter`。SQL 侧的语义在这里**原样保住**：`DbError` 原样抛、
  其它包成 `DbConnectionError`、建连失败时**关掉半开的池**（不泄漏连接）。
- `database.ts` 的生命周期改为走 `supervise()`；边界翻译（设计文档早先列的四处风险逐个处理）：
  - supervisor 的 `DbUnavailableError` → 翻译回 **`DbNotConnectedError`**（既有使用者依赖这个类型，
    并保留 `(already closed)` 这两种消息形态）；
  - `logger` 事件串保持 `db_connected` / `db_closed` / `db_close_failed`（关闭失败仍然只记日志，不炸停机流程）；
  - `stats()` 如实透传驱动统计，驱动没给就是 `null`；
  - 适配器从**方言描述符**取 `driverPackage`/`connectionKind`（见下）。
- **等价性证明**：新增 `packages/db/test/sql-adapter-contract.test.ts` —— 用**同一套契约断言**跑 SQL 适配器
  （假 SQL 驱动）7 条全绿，另有 4 条 SQL 专属断言（错误包装、半开池必关、`DbNotConnectedError` 翻译、
  stats 如实）。也就是说"接上 supervisor 后行为等价"是**被测试证明**的，不是人肉对比。
- **门禁抓到我自己**：`sql-adapter.ts` 初版写了 `dialect === 'sqlite' ? 'file' : 'host'` —— 直接被
  M7a 新加的"方言门禁"拦下（`dialects/` 之外不得按方言名分支），改为读方言描述符的 `connectionKind`
  能力位。这条门禁当场证明了它的价值。
- **验证**：全量 **753/753**、typecheck 0、文档站 41 页、`dialects/` 之外方言名分支 **0**。

尚未完成（M7b 剩余）：
1. **真库用例**：`ACTOR_TEST_REDIS_URL` / `ACTOR_TEST_IOREDIS_URL` / `ACTOR_TEST_MONGO_URL` /
   `ACTOR_TEST_PG_URL` / `ACTOR_TEST_MYSQL_URL` / `ACTOR_TEST_MSSQL_URL` 环境开关 + `scripts/dev-databases.mjs`
   （docker 起库）；SQL 三家的真库用例跑**同一套契约断言**（适配器已就位，只差环境）。

## 9. 分期路线

| 期 | 内容 | 验收 |
|---|---|---|
| **M7a** | 抽 `@actor/db-core`（契约/生命周期/驱动解析），`@actor/db` 改依赖 + re-export | 724+ 全绿；surface 门禁证明导出只增不减；`packages/db-core` 进 test/typecheck 矩阵 |
| **M7b** | 契约套件 + 真库开关 + docker 脚本；给 pg/mysql/mssql 补真库测试 | 离线全绿（真库用例显式 skip）；有 URL 时同一套断言通过 |
| **M7c** | `@actor/redis`（双驱动、多实例、pubsub 结合） | 契约套件 × 2 驱动；真库用例；示例冒烟 |
| **M7d** | `@actor/mongodb`（连接 + collection + raw + `defineCollection`/`sync`/漂移） | 契约套件；真库用例；`sync` 幂等 + 漂移拒绝 + validator 用例；示例冒烟 |
| **M7e** | 用户自装适配器：`defineDatabaseAdapter`/`defineManagedResource` + 示例 `examples/app-multi-db` + 设计/指南/API 文档 | 自装适配器示例冒烟；§8 的三条门禁 |

每期都按仓库纪律：**先写会失败的测试 → 实现 → 全量 `npm test` + `npm run typecheck` + `docs:build` 全绿 → 提交**。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| M7a 是真搬迁（不是加文件），可能破坏公开面 | 单独一期、只看"公开 API 与 724 测试是否不变"、surface 门禁兜底、re-export 清单化（§4.6） |
| 双 Redis 驱动 = 双份事件映射与测试 | v1 明确不碰 Cluster/Sentinel；事件映射写成表 + 表驱动测试 |
| 真库用例在本环境**无法验证** | 契约套件离线可跑；真库只差 URL；跳过必须显式；文档如实标注 |
| Mongo `defineCollection` 的漂移语义容易被误解 | 文档写死边界（无 validator 只能检索引漂移）；测试覆盖"无 validator 时不报字段漂移" |
| 多实例带来配置/服务名冲突 | 服务名重复直接报错（应用层 `provide` 已有此行为）；示例演示 cache/queue 两个 Redis |
| core 抽象过度（为想象需求造接口） | 接口只描述四个真实适配器（sql/redis/mongodb/自装示例）需要的东西；不过早加 cluster/change stream |

## 11. 明确不做（本轮）

- Redis Cluster / Sentinel；MongoDB Change Streams / 分片管理 / GridFS。
- 跨数据库的**分布式事务**（两阶段提交/ Saga 编排）—— 这是另一个量级的题目。
- 把 `@actor/data` 的 outbox/投影语义复制到 Redis/Mongo（需要时另立设计）。
- 改变 SQL 侧现有行为（本次只是把它变成"适配器之一"）。

## 12. 验收清单

- [ ] `@actor/db-core` 独立成包，零运行时依赖，进 test/typecheck 矩阵。
- [ ] `@actor/db` 公开面**只增不减**（surface 门禁 + 724 测试）。
- [ ] 连接管理契约套件：离线（假驱动）+ 真库（env 开关）两种运行方式，同一套断言。
- [ ] Redis：双驱动、多实例、`raw()`、pubsub 可用；契约 + 真库用例。
- [ ] MongoDB：池映射、collection 薄封装、`defineCollection` 的 sync/漂移/validator；契约 + 真库用例。
- [ ] 用户自装适配器：`defineDatabaseAdapter` + 示例 + 文档；过契约套件。
- [ ] 门禁三条（§8）全绿：`adapters/` 之外无 kind 分支、适配器都过契约套件、新包进矩阵。
- [ ] 文档：设计（本文）+ 用户指南（Redis/Mongo/自装三篇或一篇三节）+ API 页覆盖。

## 13. 加一个"非 SQL 适配器"的 checklist（下次照着做）

1. `packages/<name>/src/adapter.ts`：实现 `DatabaseAdapter`（TypeScript 会逐项提示）。
2. `packages/<name>/src/client.ts`：薄封装 + `raw()` 逃生通道（**不要**做"假装完备"的 ORM）。
3. 驱动从**应用根**懒加载：`connect({ load })` 里 `load('驱动包')`（缺失自动给 `npm i` 提示）。
4. 事件映射表：驱动自带的重连/错误事件 → `driver_event`（**不要**自己实现重连）。
5. 过连接管理契约套件（离线假驱动 + 真库 env 开关两条路径）。
6. `databaseAdapter(adapter, { name })` 装载；多实例用不同 name。
7. 文档：指南加一节 + 类型/能力对照表；API 页由 `tools/docs-site.mjs` 自动收录。
8. 门禁：新包进矩阵；`adapters/` 之外不出现 kind 分支。

## 14. 开放问题（实现前需要定，或实现中给出理由）

1. **Redis 默认驱动**：本文定 `redis`（官方）为默认、`ioredis` 可选。若你的存量项目以 ioredis 为主，可一行翻转。
2. **`ctx.pubsub` 改造时机**：M7c 里用 Redis 实现现有 pubsub 契约（不新增 API），还是等 M7e 统一？
3. **真库测试的自动拉起**：`scripts/dev-databases.mjs` 用 docker compose（需要 docker），
   是否也为 CI 提供 GitHub Actions service 配置（本仓库目前没有 CI 配置）。
