# 自装适配器 / 受管资源（框架没定义的库也能管住）

`@actor/db-core` 把"数据库"拆成两层：

| 层 | 谁提供 | 管什么 |
|---|---|---|
| **适配器** | 你（或 `@actor/db` / `@actor/redis` / `@actor/mongodb`） | 怎么连、怎么用、怎么探活、怎么关 |
| **连接管控** | 框架（`supervise()`） | 建连、状态机、事件、保活、drain、优雅关闭 |

所以：**框架不认识的数据库（消息队列、etcd、对象存储、内部服务…）也能纳入同一套生命周期。**

## 三个层次，按需要选

| 你想要的 | 用什么 | 工作量 |
|---|---|---|
| 只要"连接被管住"+ 客户端注入到控制器 | `defineDatabaseAdapter` + `databaseAdapter` | ~40 行 |
| 连数据库都不是（MQ/etcd/S3） | `defineManagedResource`（同一个契约的语义别名） | 同上 |
| 还要框架的 SQL 仓储/建模能力 | 实现 `DatabaseAdapter` 并额外提供 `Runner` + `DialectSpec`（即"厚层"，见 §4.2 of 设计文档） | 大 |

```js verify
import { defineDatabaseAdapter, supervise } from '@actor/db-core';

// 一个"框架没定义"的库：内存键值（真实场景换成你的驱动即可）
const memory = defineDatabaseAdapter({
  kind: 'memory',
  driverPackage: '(内置)',   // 有 npm 包就写包名：缺失时会提示 `npm i <包名>`
  connectionKind: 'url',
  config: { url: { type: 'string', default: '' } },
  connectionFromUrl: (url) => ({ kind: 'memory', url }),
  describe: (connection) => `memory:${String(connection.url ?? '')}`,
  async connect({ emitDriverEvent }) {
    const data = new Map();
    emitDriverEvent?.('loaded', { keys: 0 }); // 驱动自己的事件：框架**只转发**，不解释
    return {
      client: {
        get: (key) => data.get(key) ?? null,
        set: (key, value) => void data.set(key, value),
        size: () => data.size,
      },
      healthCheck: async () => {},
      keepAlive: async () => {},
      close: async () => data.clear(),
      stats: () => ({ kind: 'memory', keys: data.size }),
    };
  },
});

// 连接管控交给框架：连不上就失败、状态机、事件、drain、关停
const resource = supervise(memory, {
  connection: { kind: 'memory', url: 'memory:' },
  drainTimeoutMs: 1000,
});

await resource.connect();
const client = await resource.acquire();
await client.set('a', 1);
console.log('取回 →', await client.get('a'), '| stats =', JSON.stringify(resource.stats().driver));
await resource.close();
console.log('状态 →', resource.state, '| 关闭后取客户端会快速失败：');
try {
  await resource.acquire();
} catch (err) {
  console.log('  ', err.name, '→', err.message);
}
```

## 接进应用（多实例）

```ts
// app.ts
import { databaseAdapter } from '@actor/db-core';
import { myDbAdapter } from './my-db-adapter.ts';

export default defineApp({
  modules: [myModule],
  plugins: [
    databaseAdapter(myDbAdapter(), { name: 'audit' }),      // → ctx.get('audit')
    databaseAdapter(redisAdapter(), { name: 'cache' }),     // → ctx.get('cache')
  ],
});
```

每个实例是**一个插件名**：配置落 `plugins.<name>.*`（环境变量 `APP_PLUGINS__<NAME>__URL`），
客户端注册成同名服务；连不上或不健康 → **启动失败**；停机 → 优雅关闭（幂等）。

> 配置约定：插件读的键名固定是 **`url`**。自定义的连接形状通过
> `connectionFromUrl(url)`（把 DSN 解析成你的连接对象）或在 `connect()` 里消化 —— 
> 不需要为了适配插件去改配置形状。

## 用框架的契约套件给自己证伪

`@actor/db-core` 把**连接管理契约套件**放在 `src/`（随包发布），所以你能拿它测自己的适配器：

```ts
import { runManagedConnectionContract, supervise } from '@actor/db-core';
import { myDbAdapter } from '../src/my-db-adapter.ts';

runManagedConnectionContract({
  name: 'my-db',
  make: ({ onEvent, drainTimeoutMs }) =>
    supervise(myDbAdapter(), { connection: { kind: 'my-db', url: '…' }, onEvent, drainTimeoutMs }),
  makeFailing: ({ onEvent }) => supervise(myDbAdapter(), { connection: { kind: 'my-db', url: 'bad' }, onEvent }),
});
```

它覆盖：连上/事件、未连接与已关闭时**快速失败**、`close` 幂等、连接失败不假装 ready、
drain（在途归零 + 超时如实上报）、健康失败 → `degraded` → 恢复。跑不过就说明你的适配器
在某个契约上含糊 —— 而不是"能跑就行"。

## 逃生通道

任何一层都留着通道：`client`（适配器自己的客户端）、`raw`（原生句柄）、
`db.withDb(fn)`（MongoDB）、`kv.command([...])`（Redis）、`db.raw(sql, params)`（SQL）。
框架不拦你，也不假装替你封装完。

完整可跑示例：[`examples/app-multi-db`](../../examples/app-multi-db/README.md)
（一个自装适配器 + 两个可选 Redis 实例 + 控制器 `ctx.get(...)`）。
