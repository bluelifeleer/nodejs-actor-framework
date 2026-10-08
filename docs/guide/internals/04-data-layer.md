# 4. 数据层（@actor/data）

`@actor/data` 只依赖内核的**结构接缝**（不 import 内核，有守卫测试），提供四件事：

| 你需要 | 用什么 | 关键性质 |
|---|---|---|
| 读写实体（列表/详情/搜索） | `createFileRepository` / `createMemoryRepository` / `createSqlRepository` | 游标分页（并发写入下不漏不重）、`version` 乐观锁 |
| 有状态、要审计的写路径 | `defineAggregate` + `mode: 'events'` | 状态只能由事件推导；`expectedVersion` 条件写防并发覆盖 |
| 列表/统计这类读模型 | `createProjectionRunner` | 断点续跑、去重、**可从 0 重建** |
| 结构演进 | `createMigrationRunner` + upcast 注册表 | 默认**拒绝启动**，不猜 |

## 仓储：游标分页 + 乐观锁

```js verify
import assert from 'node:assert';
import { RepositoryConflictError, createMemoryRepository } from '@actor/data';

const notes = createMemoryRepository();
const created = [];
for (const title of ['a', 'b', 'c']) created.push(await notes.insert({ title }));

// 游标分页：并发写入下不会漏也不会重（offest 分页就会）
const page1 = await notes.findMany({ orderBy: 'id', limit: 2 });
assert.strictEqual(page1.items.length, 2);
assert.strictEqual(typeof page1.cursor, 'string');
const page2 = await notes.findMany({ orderBy: 'id', limit: 2, cursor: page1.cursor });
assert.strictEqual(page2.items.length, 1);
assert.strictEqual(page2.cursor, undefined, '最后一页不给游标');
assert.strictEqual(new Set([...page1.items, ...page2.items].map((row) => row.id)).size, 3);

// 乐观锁：version 由适配器维护，update 必须带 expectedVersion
const first = created[0];
const updated = await notes.update(first.id, { title: 'a2' }, { expectedVersion: first.version });
assert.strictEqual(updated.version, first.version + 1);
await assert.rejects(
  () => notes.update(first.id, { title: 'a3' }, { expectedVersion: first.version }),
  (err) => err instanceof RepositoryConflictError,
  '版本过旧必须被拒（把冲突翻译成 HTTP 409 是控制器的事）',
);
console.log('ok');
```

## 聚合：状态只能由事件推导 + 条件写

```js verify
import assert from 'node:assert';
import { createSystem, MemoryPersistence } from 'nodejs-actor-framework';
import { defineAggregate, defineEventSchema } from '@actor/data';

const store = new MemoryPersistence();
const Order = defineAggregate({
  name: 'Order',
  initialState: () => ({ total: 0, status: 'created' }),
  events: [defineEventSchema({ type: 'ItemAdded', version: 1 })],
  applyEvent: (state, event) =>
    event.type === 'ItemAdded' ? { ...state, total: state.total + event.price } : state,
  commands: {
    // 命令只做校验 + 产出事件（状态由 applyEvent 推导）
    addItem: (cmd, state) => {
      if (state.status !== 'created') throw new Error('已确认的订单不能再改');
      if (!(cmd.price > 0)) throw new Error('price 必须为正');
      return { type: 'ItemAdded', price: cmd.price };
    },
    // 想要"用消息查询"，就自己声明一个不产出事件的命令；
    // 但列表/统计这类读路径应该走投影（见下一节），别让 Actor 承担查询
    peek: (_cmd, state) => undefined,
  },
});

const persistence = { mode: 'events', store, evolution: Order.evolution };
const a = createSystem({ logger: false });
const ref = await a.spawn(Order, { id: 'order-1', persistence });
assert.deepStrictEqual(await ref.ask({ type: 'addItem', price: 100 }), { total: 100, status: 'created' });
assert.strictEqual((await store.loadEvents('order-1')).length, 1, '命令产出了一条事件');
await a.stop();

// 重启：状态由**事件重放**得到（不是从快照来）
const b = createSystem({ logger: false });
const again = await b.spawn(Order, { id: 'order-1', persistence });
assert.deepStrictEqual(await again.state(), { total: 100, status: 'created' });

// **两个拥有者同时存活**（同一个日志，各自都以为"日志到第 1 条"）：谁先写谁赢，后写的那次被拒
const c = createSystem({ logger: false });
const other = await c.spawn(Order, { id: 'order-1', persistence });
await again.ask({ type: 'addItem', price: 10 }); // 日志到第 2 条
await assert.rejects(
  () => other.ask({ type: 'addItem', price: 50 }),
  (err) => {
    assert.strictEqual(err.name, 'PersistenceConflictError', `期望条件写冲突，实际 ${err.name}`);
    return true;
  },
  '乐观并发：旧版本号的写入被拒，日志里不会出现重复事件',
);
assert.strictEqual((await store.loadEvents('order-1')).length, 2, '冲突那一次没有写进去');
assert.strictEqual((await again.state()).total, 110);
await Promise.all([b.stop(), c.stop()]);
console.log('ok');
```

## 投影：可从 0 重建，不丢不重

```js verify
import assert from 'node:assert';
import {
  createEventEnvelope,
  createEventRegistry,
  createMemoryOutboxCursor,
  createMemoryRepository,
  createOutboxLogReader,
  createProjectionRunner,
  defineEventSchema,
} from '@actor/data';

const registry = createEventRegistry([defineEventSchema({ type: 'ItemAdded', version: 1 })]);
const records = [];
for (let i = 1; i <= 3; i += 1) {
  records.push(createEventEnvelope({ type: 'ItemAdded', version: 1, seq: i, eventId: `e${i}`, payload: { price: 10 } }));
}

const runner = createProjectionRunner({
  projection: {
    name: 'totals',
    subscriptions: ['ItemAdded'],
    async handle(entry, ctx) {
      const row = await ctx.repository.findById('all');
      const total = Number(row?.total ?? 0) + entry.event.price;
      if (row === null) await ctx.repository.insert({ id: 'all', total });
      else await ctx.repository.update('all', { total }, { expectedVersion: row.version });
    },
  },
  reader: createOutboxLogReader({ loadRecords: async () => records, registry, actorPath: 'cart' }),
  repository: createMemoryRepository(),
  dedupeRepository: createMemoryRepository(),
  cursor: createMemoryOutboxCursor(),
  batchSize: 2,
});

const first = await runner.catchUp();
assert.strictEqual(first.run.processed, 3);
assert.strictEqual((await runner.status()).cursor, 3);

const rebuilt = await runner.rebuild(); // 从 0 重建：读模型、游标、去重集合一起清空
assert.strictEqual(rebuilt.run.processed, 3, '重建会重放全部事件');
console.log('ok');
```

## 迁移：有未应用的迁移就**拒绝启动**

```js verify
import assert from 'node:assert';
import { MigrationPendingError, createMemoryMigrationStore, createMigrationRunner } from '@actor/data';

const store = createMemoryMigrationStore();
const runner = createMigrationRunner({
  store,
  migrations: [
    { version: 1, description: '建表', async up() {} },
    { version: 2, description: '加索引', async up() {} },
  ],
});

// 默认姿态是"拒绝启动"：结构不确定就不要开始服务
await assert.rejects(() => runner.assertApplied(), (err) => err instanceof MigrationPendingError);

const result = await runner.migrate();
assert.deepStrictEqual(result.applied.map((migration) => migration.version), [1, 2]);
const status = await runner.assertApplied(); // 这个返回值就是状态查询
assert.deepStrictEqual(status.applied, [1, 2], '应用过之后就可以启动了');
assert.deepStrictEqual(status.pending, []);

// 迁移必须幂等：中断后会被重跑，所以再跑一次不能有任何副作用
assert.deepStrictEqual((await runner.migrate()).applied, []);
console.log('ok');
```

## outbox：至少一次投递 + 消费幂等

```js verify
import assert from 'node:assert';
import {
  createDedupeSet,
  createEventEnvelope,
  createEventRegistry,
  createIdempotentConsumer,
  createMemoryOutboxCursor,
  createMemoryRepository,
  createOutboxDispatcher,
  createOutboxLogReader,
  defineEventSchema,
} from '@actor/data';

const registry = createEventRegistry([defineEventSchema({ type: 'ItemAdded', version: 1 })]);
const records = [createEventEnvelope({ type: 'ItemAdded', version: 1, seq: 1, eventId: 'e1', payload: {} })];

const delivered = [];
const dispatcher = createOutboxDispatcher({
  reader: createOutboxLogReader({ loadRecords: async () => records, registry, actorPath: 'cart' }),
  cursor: createMemoryOutboxCursor(),
  publish: async (entry) => delivered.push(entry.deliveryId),
});

assert.strictEqual((await dispatcher.drainOnce()).published, 1);
assert.strictEqual((await dispatcher.drainOnce()).published, 0, '已推进的游标不会重投');

// 至少一次语义下，消费方要按 deliveryId 去重（这里用仓储的主键实现）
const handled = [];
const consume = createIdempotentConsumer({
  dedupe: createDedupeSet({ repository: createMemoryRepository() }),
  handle: async (entry) => handled.push(entry.deliveryId),
});
const entry = { seq: 1, eventId: 'e1', deliveryId: 'e1', event: { type: 'ItemAdded' } };
assert.strictEqual(await consume(entry), 'handled');
assert.strictEqual(await consume(entry), 'duplicate');
assert.deepStrictEqual(handled, ['e1'], '业务只跑一次');
console.log('ok');
```

设计与取舍（为什么"事件日志即 outbox"、为什么游标只带 tie-breaker、快照缓存怎么工作）见
[设计文档 M3](../../design/m3-data-evolution.md)；可运行的整体示例见
[`examples/app-data`](../../../examples/app-data/README.md)。

下一步：[集群](./05-cluster.md)。
