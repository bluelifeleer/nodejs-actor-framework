# Redis（@actor/redis）

`@actor/redis` 是 Redis 适配器：连接生命周期（建连/探活/保活/事件转发/drain/关闭）由
[`@actor/db-core`](../design/m7-multi-database.md) 的 `supervise()` 统一提供，这一层只管"怎么用 Redis"。

## 装驱动（二选一，或都要）

| 驱动 | 装什么 | 说明 |
|---|---|---|
| `redis`（默认） | `npm i redis` | 官方 node-redis |
| `ioredis` | `npm i ioredis` | 用 `driver: 'ioredis'` 切换 |

驱动是**懒加载**的，并且从**你自己项目的 node_modules** 解析（pnpm 严格布局也没问题）；
没装时的报错会直接写清楚 `npm i redis` / `npm i ioredis`。

```js verify
import { describeRedis, parseRedisUrl, resolveRedisDriver } from '@actor/redis';

// 不需要 Redis 服务器就能验证的部分：DSN 解析、免密描述、驱动注册表
const connection = parseRedisUrl('rediss://user:secret@cache.internal:6380/3');
console.log('连接 →', describeRedis(connection));           // redis://… （**不含密码**）
console.log('TLS  →', connection.tls, '| 库索引 =', connection.database);
if (describeRedis(connection).includes('secret')) throw new Error('描述里泄漏了密码');
if (resolveRedisDriver('ioredis').packageName !== 'ioredis') throw new Error('驱动注册表不对');
console.log('默认驱动 →', resolveRedisDriver('redis').packageName);
```

## 连接与使用

```ts
import { redisAdapter } from '@actor/redis';
import { supervise } from '@actor/db-core';

const cache = supervise(redisAdapter({ driver: 'ioredis', prefix: 'app:' }), {
  connection: { url: 'redis://127.0.0.1:6379/0' },
  // 可选：定时探活/保活（驱动自带重连时框架**只转发事件**，不自己重连）
  healthCheckIntervalMs: 30_000,
  onEvent: (event) => console.log('[redis]', event.type, event),
});

await cache.connect();          // 连不上就在这里失败（不静默降级）
const kv = await cache.acquire();

await kv.set('session:1', 'x', { ttlMs: 60_000 });
await kv.get('session:1');      // → 'x'
await kv.incr('counter');
await kv.setJson('profile', { name: 'a' });
await kv.getJson('profile');    // → { name: 'a' }

const off = await kv.subscribe('news', (message, channel) => console.log(channel, message));
await kv.publish('news', 'hello');   // 订阅会自动**另开一条连接**（订阅态不能发普通命令）
await off();

await cache.close();            // 幂等；会等在途工作结束（drain）
```

**双驱动的差异由适配器吸收**（使用方无感）：建连方式、订阅要独立连接、重连事件名、
超时字段名 —— 都封在 `src/adapters/` 里；驱动自带的重连/错误事件被**原样转发**成
`driver_event` 事件（框架不自己再连一套，避免两套重连打架）。

## 能力面（薄封装 + 逃生通道）

| 类别 | 方法 |
|---|---|
| 字符串 | `get` / `set`（`ttlMs`、`ifNotExists`）/ `setEx` / `del` / `exists` / `incr` / `expire` / `ttl` |
| 批量 | `mGet` / `mSet` |
| 哈希 | `hGet` / `hSet` / `hGetAll` |
| 列表 | `lPush` / `lRange` |
| 集合 | `sAdd` / `sMembers` |
| 扫描 | `scan(cursor, { match, count })`（结果会自动**剥掉** `prefix`） |
| 发布订阅 | `publish` / `subscribe` |
| 流水线 | `pipeline()`（**只是流水线，不是 MULTI/EXEC 事务**） |
| JSON | `getJson` / `setJson`（`serialize`/`parse` 可注入） |
| **逃生通道** | `kv.command(['DBSIZE'])` 发任意命令；`kv.raw` 直接拿原生客户端 |

> 明确不做"假装完备"的 Redis ORM：常用语义给薄封装，其余走 `command()`/`raw`。

## 多实例

同一应用里可以起多个 Redis（缓存/队列/会话各一个），各自独立配置与生命周期：

```ts
// app.ts
import { databaseAdapter } from '@actor/db-core';
import { redisAdapter } from '@actor/redis';

export default defineApp({
  modules: [myModule],
  plugins: [
    databaseAdapter(redisAdapter(), { name: 'cache' }),
    databaseAdapter(redisAdapter({ driver: 'ioredis', prefix: 'queue:' }), { name: 'queue' }),
  ],
});
```

每个实例是**一个插件名**：配置落 `plugins.cache.*` / `plugins.queue.*`（环境变量
`APP_PLUGINS__CACHE__URL` / `APP_PLUGINS__QUEUE__URL`），客户端注册成同名服务 ——
控制器里 `ctx.get('cache')` / `ctx.get('queue')` 直接拿到，停机时各自优雅关闭。
连接后不健康、或连不上，都会**启动失败**（不会出现"应用起来了但 Redis 没连上"）。

## v1 明确不做

**Cluster / Sentinel 拓扑**（两个驱动的 cluster API 差异大，会显著拉长工期）。需要时用
`clientOptions` 透传，或直接用 `raw` 逃生通道。

## 真库测试

```bash
node scripts/dev-databases.mjs up redis
eval "$(node scripts/dev-databases.mjs env)"
npm test        # 真库用例这时才真的跑（否则输出里能看到 skipped）
```

真库用例跑的是**同一套**连接管理契约断言（`runManagedConnectionContract`），不是另写一套宽松断言；
两个驱动各一组，环境变量分别是 `ACTOR_TEST_REDIS_URL` 与 `ACTOR_TEST_IOREDIS_URL`。
