# 6. 怎么测

原则：**用真内核跑测试**（不需要 mock 框架），把断言落在**可观察行为**上。

## 最小测试骨架

```js verify
import assert from 'node:assert';
import { createSystem } from 'nodejs-actor-framework';

const system = createSystem({ logger: false }); // 测试里关日志，输出才干净
try {
  const ref = await system.spawn(
    {
      preStart() {
        this.count = 0;
      },
      receive(msg) {
        this.count += msg.by ?? 1;
        return this.count;
      },
    },
    { id: 'counter' },
  );

  assert.strictEqual(await ref.ask({ by: 2 }), 2);
  assert.strictEqual(await ref.ask({}), 3);
} finally {
  await system.stop(); // 一定要停：漏掉会留下定时器/socket，测试进程不退出
}
console.log('ok');
```

## 测失败路径：慢 Actor 会拿到 `AskTimeoutError`

```js verify
import assert from 'node:assert';
import { AskTimeoutError, createSystem } from 'nodejs-actor-framework';

const system = createSystem({ logger: false });
try {
  const slow = await system.spawn(
    {
      preStart() {
        this.seen = 0;
      },
      async receive() {
        this.seen += 1;
        await new Promise((resolve) => setTimeout(resolve, 200)); // 慢，但**最终会返回**
        return 'late';
      },
    },
    { id: 'slow' },
  );

  await assert.rejects(
    () => slow.ask('hi', 50), // 第二个参数是超时毫秒数（不是 options 对象）
    (err) => {
      assert.strictEqual(err.name, 'AskTimeoutError', `期望 AskTimeoutError，实际 ${err.name}`);
      return true;
    },
    '调用方必须拿到明确的超时错误，而不是无限等',
  );
} finally {
  await system.stop(); // 慢 handler 会自然结束，所以 stop 能正常收尾
}
console.log('ok');
```

> **一个必须知道的边界**：超时定时器是 `unref()` 的——它不会把进程钉住。所以如果 handler **永不返回**，
> 且进程里没有别的待处理工作（没有别的 socket / 定时器），Node 会**直接退出**，你甚至看不到那条
> `AskTimeoutError`（实测：退出码 13 "unsettled top-level await"）。生产里通常有别的句柄所以不会
> 撞上；写测试时用"慢但会返回"的 handler（如上），不要用 `new Promise(() => {})`。

## 测持久化：真文件、跨"重启"、清理干净

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilePersistence, createSystem } from 'nodejs-actor-framework';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-test-'));
const store = new FilePersistence({ baseDir: dir });
const definition = {
  preStart() {
    this.state = { items: 0 };
  },
  applyEvent(event) {
    if (event.type === 'ItemAdded') this.state.items += 1;
  },
  async receive(msg, ctx) {
    if (msg.type === 'add') await ctx.persist({ type: 'ItemAdded' });
    return this.state.items;
  },
};

try {
  const first = createSystem({ logger: false });
  const ref = await first.spawn(definition, { id: 'cart', persistence: { mode: 'events', store } });
  await ref.ask({ type: 'add' });
  await ref.ask({ type: 'add' });
  await first.stop();

  const second = createSystem({ logger: false });
  const again = await second.spawn(definition, { id: 'cart', persistence: { mode: 'events', store } });
  assert.strictEqual(await again.ask({ type: 'state' }), 2, '重启后状态从事件流恢复');
  await second.stop();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok');
```

## 三个习惯

1. **每个测试自己 cleanup**（`try/finally` + `system.stop()`、临时目录删掉）——否则测试会互相污染，
   而且泄漏的定时器会让整个测试进程卡住。
2. **断言可观察行为**，不要断言内部字段：能观察到的是 `ask` 的返回值、事件流长度、快照内容、
   HTTP 状态码、`metrics()` 计数——这些才是契约。
3. **等异步收敛要"有上限的轮询"**（见 [集群指南](./05-cluster.md) 里的 `waitFor` 写法）。
   注意本项目测试工具的选项名是 `{ timeout, interval }`——写错名字会被**静默忽略**（真踩过）。

## 虚拟时钟：把"等一小时"变成 0 真实毫秒

`@actor/testkit` 提供虚拟时钟，注入 `createSystem({ clock })` 之后，超时/限流/`ctx.sleep`/轮询
全部由**你推进的时间**驱动，顺序确定、不用 sleep 抢时序：

```js verify
import assert from 'node:assert';
import { AskTimeoutError, createSystem } from 'nodejs-actor-framework';
import { createVirtualClock } from '@actor/testkit';

const vc = createVirtualClock();
const system = createSystem({ logger: false, clock: vc.clock });
try {
  const ref = await system.spawn(
    {
      preStart() {
        this.state = { done: 0 };
      },
      async receive(_msg, ctx) {
        await ctx.sleep(10_000); // 虚拟的 10 秒；由 advance() 决定何时过去
        this.state.done += 1;
        return 'finally';
      },
    },
    { id: 'sleeper' },
  );

  const realStart = Date.now();
  const pending = ref.ask('hi', 1000); // 超时 1000ms
  // 注意顺序：**先在 promise 上挂处理器，再推进时间**。超时是在 advance() 里触发的，
  // 那一刻还没有处理器的话，Node 会把它当"未处理的拒绝"直接崩掉测试。
  const timedOut = assert.rejects(
    () => pending,
    (err) => err instanceof AskTimeoutError,
  );
  await vc.drain(); // 让消息真正投递到 Actor（消息走真实调度器，定时器才是虚拟的）
  await vc.advance(1000); // 1000ms 的虚拟时间：真实时间几乎没走
  await timedOut;

  assert.ok(Date.now() - realStart < 200, '真实耗时应当极小');
  await vc.advance(9000); // 超时只是"调用方不等了"，Actor 的活还在虚拟时间里挂着
  assert.strictEqual((await system.cells.get('sleeper').ref.state()).done, 1, 'Actor 最终完成了处理');
} finally {
  // 停系统之前，把还挂着的虚拟等待推完：否则 system.stop() 会一直等那一轮（虚拟时间里它不会自己醒）
  await vc.advance(60_000);
  await system.stop();
}
console.log('ok');
```

### 三条必须知道的规则

| 规则 | 为什么 |
|---|---|
| **advance 之前先 `drain()`** | 虚拟时钟只接管定时器；**消息投递仍走内核真实的调度器**。不 drain 就 advance，会看到"什么都没发生"——Actor 还没开始处理，它内部的定时器自然还没排上 |
| **停系统之前先推进** | 还在 `ctx.sleep` / 限流等待里的 Actor 不会自己醒；`system.stop()` 会等那一轮结束 |
| **网络 I/O 仍然需要真实时间** | 真实 socket 的读写不受虚拟时钟影响，所以集群/网关里的连接超时、gossip 心跳保持真实时钟（`docs/design/m5-cli-and-testkit.md` §6 写明了这条边界） |

事件、投递器、投影的**轮询**也接了时钟：`createOutboxDispatcher({ clock })` /
`createProjectionRunner({ clock })` 注入虚拟时钟后，`advance(1000)` 就能触发一轮，不用 `await sleep(1000)`。

> 还想要什么：探针（记录消息/回复）与故障注入（按次数失败/延迟/丢弃）在 M5 计划里（`@actor/testkit` 的下一步）。
