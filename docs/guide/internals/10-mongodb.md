# MongoDB（@actor/mongodb）

`@actor/mongodb` 是 MongoDB 适配器：连接生命周期（建连/探活/保活/事件转发/drain/关闭）由
[`@actor/db-core`](../../design/m7-multi-database.md) 的 `supervise()` 统一提供；
这一层管"怎么用集合"，外加一个**声明式集合**（`defineCollection`）。

```bash
npm i mongodb        # 驱动是懒加载的，从你自己项目的 node_modules 解析
```

## 连接与使用

```ts
import { mongoAdapter } from '@actor/mongodb';
import { supervise } from '@actor/db-core';

const mongo = supervise(mongoAdapter(), {
  connection: { url: 'mongodb://127.0.0.1:27017/app' },
  onEvent: (event) => console.log('[mongo]', event.type, event),
});

await mongo.connect();        // 连不上就在这里失败（不静默降级）
const db = await mongo.acquire();

await db.collection('events').insertOne({ type: 'created', at: new Date() });
await db.collection('events').findOne({ type: 'created' });
await db.collection('events').countDocuments({ type: 'created' });

// 逃生通道：原生 db / 原生客户端
const raw = await db.withDb((native) => native.collection('events').countDocuments({}));
console.log(raw, db.raw);

// 事务（与 SQL 侧同签名）
await db.transaction(async (scoped) => {
  await scoped.collection('events').insertOne({ type: 'in-tx' });
});

await mongo.close();
```

池参数按 MongoDB 官方字段名映射（写在明面上，便于对照）：

| 框架统一形状 | MongoDB |
|---|---|
| `max` | `maxPoolSize` |
| `min` | `minPoolSize` |
| `idleTimeoutMs` | `maxIdleTimeMS` |
| `connectionTimeoutMs` | `serverSelectionTimeoutMS` |

## `defineCollection`：声明式集合

```js verify
import { defineCollection, describeMongo, parseMongoUrl } from '@actor/mongodb';

const Event = defineCollection({
  name: 'events',
  description: '领域事件',
  fields: {
    _id: { type: 'objectId' },
    type: { type: 'string', required: true, description: '事件类型' },
    payload: { type: 'object' },
    tags: { type: 'array', items: 'string' },
    at: { type: 'date', auto: 'create' },
    version: { type: 'integer', version: true },
  },
  indexes: [{ fields: ['type', 'at'] }, { fields: ['version'], unique: true }],
  validator: { strict: true },   // → additionalProperties: false
});

// 不需要 MongoDB 服务器就能验证的部分：$jsonSchema 生成、索引名、DSN 解析
console.log(JSON.stringify(Event.jsonSchema, null, 2));
console.log('索引名 →', Event.indexes.map((index) => index.name).join(', '));
if (Event.indexes[0].name !== 'events_type_at') throw new Error('索引名必须是确定性的');

const connection = parseMongoUrl('mongodb+srv://user:secret@cluster.example.net/app?authSource=admin');
console.log('连接 →', describeMongo(connection));   // **不含密码**
if (describeMongo(connection).includes('secret')) throw new Error('描述里泄漏了密码');
if (connection.tls !== true) throw new Error('mongodb+srv 应当是 TLS');
```

类型映射（`$jsonSchema` 的 `bsonType`）：

| 声明 | `bsonType` | 说明 |
|---|---|---|
| `objectId` / `string` / `boolean` / `date` / `object` / `binary` | `objectId` / `string` / `bool` / `date` / `object` / `binData` | |
| `integer` | `int` 或 `long` | MongoDB 的整数有两种宽度 |
| `double` | `double` / `int` / `long` / `decimal` | 声明 double 却存了 int 不该算漂移 |
| `array` | `array` + `items` | 用 `items` 声明元素类型 |
| 非必填字段 | 追加 `null` | MongoDB 里 null 是常态 |

`sync()` 的行为（与 SQL 侧同一纪律）：

| 情况 | 行为 |
|---|---|
| 集合不存在 | **建**（带 `$jsonSchema` validator）+ 建缺失索引 |
| 索引缺失 | **建**（补齐不算改结构） |
| validator 与声明不一致 | **报漂移**；要改就显式 `mongoAdapter({ collections, auto: true })`（走 `collMod`） |

> ⚠️ **诚实边界**：MongoDB 是 schemaless —— **没有 `$jsonSchema` validator 的集合无法谈字段漂移**。
> 遇到这种集合（别人建的），框架**不擅自加** validator，只在 `syncCollections()` 的
> `fieldDriftUnavailable` 里如实说明"这个集合检不了字段漂移"，能检的只有索引。

## 能力面

`collection(name)` 是**薄封装**（直接转调原生集合）：`find`（原生游标）/ `findOne` / `insertOne` /
`insertMany` / `updateOne` / `updateMany` / `deleteOne` / `deleteMany` / `countDocuments` / `aggregate` /
`createIndex` / `listIndexes` / `drop`；逃生通道是 `collection(name).raw`、`db.withDb(fn)`、`db.raw`。

**明确不做**：Change Streams、GridFS、分片集群管理、聚合管道 DSL（用原生）。

## v1 不做 / 后续可能加

- `mongoose` 之类的 ODM 包装（本包只做薄封装 + 声明式集合）；
- 其它驱动（驱动注册表 `resolveMongoDriver` 已经留好位置，加一行即可）。

## 真库测试

```bash
node scripts/dev-databases.mjs up mongo
eval "$(node scripts/dev-databases.mjs env)"
npm test        # 真库用例这时才真的跑（否则输出里能看到 skipped）
```

真库用例（`ACTOR_TEST_MONGO_URL`）跑的是**同一套**连接管理契约断言 + 一次
`defineCollection` 的 sync + CRUD 往返 + 清理。
