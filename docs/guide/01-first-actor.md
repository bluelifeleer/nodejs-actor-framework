# 1. 第一个 Actor

Actor 是**有身份、单线程串行**的处理单元：同一个 Actor 的消息一条一条处理，不会并发进入。

## 最小可运行

```js verify
import assert from 'node:assert';
import { createSystem } from 'nodejs-actor-framework';

const system = createSystem({ logger: false });

// 一个 Actor 定义就是"生命周期回调 + 一个 receive"
const counter = {
  preStart() {
    // this 就是 Actor 实例；state 可以随便叫，这里用 this.count
    this.count = 0;
  },
  receive(msg) {
    if (msg.type === 'add') this.count += msg.by ?? 1;
    if (msg.type === 'get') return this.count;
    return this.count; // receive 的返回值就是 ask 的回复
  },
  postStop() {
    this.stopped = true; // 清理钩子：停掉时调用
  },
};

const ref = await system.spawn(counter, { id: 'counter' });

// ask = 有回复（默认有超时）；tell = 发完不管
assert.strictEqual(await ref.ask({ type: 'add', by: 2 }), 2);
ref.tell({ type: 'add', by: 3 });
assert.strictEqual(await ref.ask({ type: 'get' }), 5, 'tell 也会被处理，只是没有回复');

await ref.stop();
await system.stop();
console.log('ok');
```

要点：**`receive` 的返回值就是 `ask` 的回复**；`tell` 没有回复通道（内部出错会走日志与事件，不会静默）。

## 同一个 Actor 的消息是串行的

```js verify
import assert from 'node:assert';
import { createSystem } from 'nodejs-actor-framework';

const system = createSystem({ logger: false });
const order = [];
const ref = await system.spawn(
  {
    preStart() {
      this.busy = false;
    },
    async receive(msg) {
      // 故意在里面 await：串行性不该因此被打破
      assert.strictEqual(this.busy, false, '同一个 Actor 不会并发进入 receive');
      this.busy = true;
      order.push(`start:${msg.n}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${msg.n}`);
      this.busy = false;
      return msg.n;
    },
  },
  { id: 'serial' },
);

await Promise.all([ref.ask({ n: 1 }), ref.ask({ n: 2 }), ref.ask({ n: 3 })]);
assert.deepStrictEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
await system.stop();
console.log('ok');
```

## 它在哪里？——`system.resolve(id)`

```js verify
import assert from 'node:assert';
import { createSystem } from 'nodejs-actor-framework';

const system = createSystem({ logger: false });
await system.spawn({ preStart() {}, receive: () => 'pong' }, { id: 'ping' });

const found = system.resolve('ping');
assert.ok(found, '按 id 找到本地 Actor');
assert.strictEqual(await found.ask('hi'), 'pong');
assert.strictEqual(system.resolve('不存在'), null, '找不到就是 null（集群插件会在这里接管远端查找）');

// id 在**系统内全局唯一**：重复 spawn 会明确报错，而不是悄悄造出两个同名 Actor
await assert.rejects(
  () => system.spawn({ preStart() {}, receive: () => 'x' }, { id: 'ping' }),
  /already exists/,
  '重名要当场失败（否则 resolve 会变得有歧义）',
);
await system.stop();
console.log('ok');
```

## 子 Actor 与监督（一句话版）

`system.spawn(def, { parent: 'someId' })` 建立父子关系：默认 `ONE_FOR_ONE`（子崩了只重启子），
可选 `ONE_FOR_ALL` / `REST_FOR_ONE`（见内核导出的 `RestartStrategy`）。崩溃重启与 mailbox 溢出的
完整语义在 [设计文档 01](../design/01-actor-core-standalone.md)；指南这里只讲"你要写什么代码"。

下一步：[持久化与恢复](./02-persistence.md)。
