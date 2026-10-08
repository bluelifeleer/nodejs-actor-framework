# 2. 持久化与恢复

两种模式，**先想清楚你要哪一种**：

| 模式 | 存什么 | 恢复方式 | 适合 |
|---|---|---|---|
| `none`（默认）/ `snapshot` | 定期/显式存整个状态 | 读最后一个快照 | 状态小、可整体覆盖 |
| `events` | 只追加事件流 | 重放事件（可选用快照做缓存） | 要审计、要时间旅行、状态大 |
| `mailbox` | **未确认的消息** | 入队即落盘、处理完才 ack；重放未确认的部分 | 特殊场景（见设计文档） |
| `none` | 不存 | — | 纯无状态 |

## 快照模式

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSystem, FilePersistence } from 'nodejs-actor-framework';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-snapshot-'));
const store = new FilePersistence({ baseDir: dir });

const definition = {
  preStart() {
    this.state = { count: 0 };
  },
  async receive(msg, ctx) {
    if (msg.type === 'add') {
      this.state.count += 1;
      await ctx.saveSnapshot(); // 显式存（存全量状态；也可以在 stop 时自动存，见下）
      return this.state.count;
    }
    return this.state.count;
  },
};

const a = createSystem({ logger: false });
const ref = await a.spawn(definition, { id: 'box', persistence: { mode: 'snapshot', store } });
await ref.ask({ type: 'add' }); // 这条内部显式存了快照
await ref.ask({ type: 'add' }); // 这条没存……
await a.stop(); // ……但**停止时会自动存一次**（见内核的 onStop 快照），所以状态不会丢

// 重启：新的系统 + 同一份存储 → 状态回来
const b = createSystem({ logger: false });
const again = await b.spawn(definition, { id: 'box', persistence: { mode: 'snapshot', store } });
assert.strictEqual(await again.ask({ type: 'get' }), 2, '状态从快照恢复（含停止时自动存的那一次）');
await b.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok');
```

## 事件模式（事件溯源）

关键是**状态只能由事件推导**：`applyEvent` 既是"实时处理"也是"重放"的那份代码。

```js verify
import assert from 'node:assert';
import { createSystem, MemoryPersistence } from 'nodejs-actor-framework';

const store = new MemoryPersistence();
const definition = {
  preStart() {
    this.state = { total: 0, items: 0 };
  },
  // 状态唯一的变化途径
  applyEvent(event) {
    if (event.type === 'ItemAdded') {
      this.state.total += event.price;
      this.state.items += 1;
    }
  },
  // 命令：只做校验 + 产出事件
  async receive(msg, ctx) {
    if (msg.type === 'add') {
      if (msg.price <= 0) throw new Error('price 必须为正');
      await ctx.persist({ type: 'ItemAdded', price: msg.price });
      return { ...this.state };
    }
    return { ...this.state };
  },
};

const a = createSystem({ logger: false });
const ref = await a.spawn(definition, { id: 'cart', persistence: { mode: 'events', store } });
assert.deepStrictEqual(await ref.ask({ type: 'add', price: 100 }), { total: 100, items: 1 });
assert.deepStrictEqual(await ref.ask({ type: 'add', price: 50 }), { total: 150, items: 2 });
await a.stop();

// 重启：事件流重放（不是从快照来）
const b = createSystem({ logger: false });
const again = await b.spawn(definition, { id: 'cart', persistence: { mode: 'events', store } });
assert.deepStrictEqual(await again.ask({ type: 'state' }), { total: 150, items: 2 }, '重放得到同样的状态');
await b.stop();
console.log('ok');
```

## 快照只是缓存（推荐组合）

`mode: 'events'` 配 `snapshot: { every: N }`：每 N 个事件存一次快照，恢复时读快照 + 只重放增量。
**快照结构对不上时会被丢弃并从事件重建**（不会因为换了状态结构就起不来）。

```js verify
import assert from 'node:assert';
import { createSystem, MemoryPersistence } from 'nodejs-actor-framework';

const store = new MemoryPersistence();
const definition = {
  preStart() {
    this.state = { items: 0 };
  },
  applyEvent(event) {
    if (event.type === 'ItemAdded') this.state.items += 1;
  },
  async receive(msg, ctx) {
    if (msg.type === 'add') {
      await ctx.persist({ type: 'ItemAdded' });
      return this.state.items;
    }
    return this.state.items;
  },
};

const a = createSystem({ logger: false });
const options = { id: 'with-cache', persistence: { mode: 'events', store, snapshot: { every: 2 } } };
const ref = await a.spawn(definition, options);
for (let i = 0; i < 5; i += 1) await ref.ask({ type: 'add' });
assert.strictEqual(await ref.ask({ type: 'state' }), 5);
await a.stop();

// 日志长度就是真相：5 条事件
assert.strictEqual((await store.loadEvents('with-cache')).length, 5);

const b = createSystem({ logger: false });
const again = await b.spawn(definition, options);
assert.strictEqual(await again.ask({ type: 'state' }), 5, '快照 + 增量重放');
await b.stop();
console.log('ok');
```

> 事件结构要改怎么办：见 [数据层指南](./04-data-layer.md) 的 upcast 注册表（读取时升级旧事件，
> **盘上的日志不动**）。

下一步：[HTTP 应用](./03-http-app.md)。
