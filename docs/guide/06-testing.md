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

## 诚实说明：还没有虚拟时钟

内核的可注入时钟/定时器（M0.2 的原语）**尚未实现**，所以：

- 测"经过一段时间"的逻辑要用真的 `setTimeout` 并接受测试变慢；
- 涉及定时器的测试要么把间隔调小，要么用真实的 `waitFor` 轮询；
- 虚拟时钟与故障注入属于 **M5（TestKit）** 的计划（见 [路线图](../design/06-roadmap-and-nongoals.md)）。

集群/HTTP 的端到端测试可以照 [`test/integration-example-app-data.test.js`](../../test/integration-example-app-data.test.js)
的写法：**真子进程 + 真文件 + 真 HTTP**（适合验证"示例能不能跑起来"与错误语义这类跨层契约）。
