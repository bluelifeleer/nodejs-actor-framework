# 12. Actor 与状态：状态该放哪、怎么不丢

## 1. 一句话判断法

| 这个东西 | 放哪 | 为什么 |
|---|---|---|
| **计数、余额、库存、房间成员、游戏角色**这类"**并发写会算错**"的状态 | **Actor** | 同一个 Actor 的消息**串行**处理 → 不用锁也不会算错 |
| 列表、报表、查询 | 仓储/投影（[11 数据与 CRUD](./11-crud-database.md)） | 读多写少，Actor 只会变成瓶颈 |
| 请求级临时值（当前用户、traceId） | `ctx.state` / `ctx.extend` | 每请求一份，与 Actor 无关 |
| 配置 | `config` | 进程级只读（[14 配置](./14-config-env.md)） |

**判据**：如果两个请求同时来会**互相写坏**（读-改-写），那就是 Actor；
如果只是"读出来展示"，那是仓储。

## 2. 定义一个 Actor（handler bag，推荐）

```ts
export const Counter = {
  // 初始化 state（恢复快照之后也会调一次；不要把 state 放在别的字段）
  preStart(this: { state: { count: number } }) {
    this.state = { count: 0 };
  },

  // 所有消息都在这里串行处理；返回值就是 ask() 的返回值
  async receive(
    this: { state: { count: number } },
    msg: { type: 'add'; by?: number } | { type: 'get' },
    ctx: { saveSnapshot(): Promise<void> },
  ) {
    if (msg.type === 'add') {
      this.state.count += msg.by ?? 1;
      await ctx.saveSnapshot();      // 显式落盘（快照模式）
    }
    return this.state.count;
  },

  // 可选：停止时清理（定时器、外部连接）
  postStop(this: { state: unknown }) { void this; },
};
```

**唯一的状态契约是 `this.state`**。状态写到别的字段（`this.count = 1`）看起来能跑，
但**重启后会归零** —— 脚手架自带的"重启后状态还在"用例就是盯这个的。

## 3. 挂到应用上 + 怎么调

```ts
// src/module.ts
export default defineModule({
  name: 'app',
  actors: {
    // 键就是 Actor 路径（ctx.actor('Counter') 用的名字）
    Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } },
  },
});

// src/controller/counter.controller.ts
export const counter = {
  add: defineController({
    input: { by: { type: 'number', default: 1 } },     // 默认来自请求体
    handle: async (input, ctx) => {
      const ref = ctx.actor('Counter') as { ask<R>(msg: unknown, timeoutMs?: number): Promise<R> };
      return { count: await ref.ask<number>({ type: 'add', by: Number(input.by) }) };
    },
  }),
  read: defineController({
    handle: async (_input, ctx) => {
      const ref = ctx.actor('Counter') as { ask<R>(msg: unknown): Promise<R> };
      return { count: await ref.ask<number>({ type: 'get' }) };
    },
  }),
};
```

| 调用方式 | 语义 | 什么时候用 |
|---|---|---|
| `ask(msg, timeoutMs?)` | 发消息并**等回复**（超时抛 `AskTimeoutError` → HTTP 504） | 需要结果：计数、扣库存 |
| `tell(msg)` | 只发不等（fire-and-forget） | 副作用：打日志、触发下游 |

`ctx.actor(name)` 是**位置透明**的：本机没 spawn 会去集群发现（装了集群插件时），
找不到抛 `ActorNotResolvableError` → HTTP 404。

## 4. 持久化：两种模式

| 模式 | 写什么 | 适合 | 注意 |
|---|---|---|---|
| `snapshot` | 整个 `state` 的副本 | 状态小、写不频繁 | 快照只是**缓存**：丢了还能从业务数据重建 |
| `events` | 你显式保存的事件序列 | 需要审计/时间旅行 | 要自己写事件与重建逻辑（`@actor/data` 有 `defineAggregate` 帮你做） |
| 不配 | 无持久化 | 纯内存状态（房间、连接） | 进程重启即丢，这是**明确选择**，不是事故 |

```ts
actors: {
  Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } },
}
```

**class 形态的 Actor 不能开 `snapshot`/`events`**：框架在**启动期**就拒绝
（class 实例的状态无法被正确恢复，宁可拒绝也不静默写坏数据）。要用持久化就用 handler bag，
或者 `@actor/data` 的 `defineAggregate`。

## 5. 依赖注入进 Actor

```ts
actors: {
  Orders: {
    definition: OrdersActor,
    deps: ['orders'],          // 只注入这两个；省略则注入全部 provider + config/log
    options: { persistence: { mode: 'events' } },
  },
}
```

`deps` 里的名字必须能在模块里解析出来，否则**启动期报错**（不是运行期 `undefined`）。

## 6. 跑一遍（CI 真执行）

下面这段起一个真内核 + 一个真 Actor，验证：**初始化 → 串行累加 → ask 拿到结果 → 并发不乱 → 停止幂等**。

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { defineController, defineRoutes, get, post, httpPlugin } = await import(`${repo}packages/web/src/index.ts`);

// ① handler bag 形态：状态只在 this.state 上，消息串行处理
const Counter = {
  preStart() {
    this.state = { count: 0, handled: 0 };
  },
  async receive(msg) {
    if (msg.type === 'add') {
      // 故意"读-改-写"：如果不是串行处理，这段在并发下必错
      const current = this.state.count;
      await new Promise((resolve) => setImmediate(resolve));
      this.state.count = current + (msg.by ?? 1);
    }
    this.state.handled += 1;
    return { count: this.state.count, handled: this.state.handled };
  },
};

const counter = {
  add: defineController({
    input: { by: { type: 'number', default: 1 }, times: { type: 'number', default: 1, min: 1, max: 100 } },
    handle: async (input, ctx) => {
      const ref = ctx.actor('Counter');
      const results = [];
      for (let index = 0; index < Number(input.times); index += 1) {
        results.push(await ref.ask({ type: 'add', by: Number(input.by) }));
      }
      return { last: results.at(-1), calls: results.length };
    },
  }),
  // 并发发消息：Actor 的串行保证在这里最关键
  burst: defineController({
    input: { times: { type: 'number', default: 10, min: 1, max: 100 } },
    handle: async (input, ctx) => {
      const ref = ctx.actor('Counter');
      await Promise.all(Array.from({ length: Number(input.times) }, () => ref.ask({ type: 'add', by: 1 })));
      return ref.ask({ type: 'get', });
    },
  }),
  read: defineController({ handle: async (_input, ctx) => ctx.actor('Counter').ask({ type: 'get' }) }),
};

// 持久化目录每次跑都用新的临时目录：否则上一次的快照会被恢复，断言就不可复现了
const persistenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-actors-'));
const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'app',
        actors: { Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } } },
        routes: defineRoutes([
          post('/counter/add', counter.add),
          post('/counter/burst', counter.burst),
          get('/counter', counter.read),
        ]),
      }),
    ],
    plugins: [http],
  }),
  { configDir: null, env: {}, kernel: { persistence: { dir: persistenceDir } } },
);
await app.start();
const base = `http://127.0.0.1:${String(http.address()?.port)}`;
try {
  const added = await (await fetch(`${base}/counter/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 5, times: 2 }),
  })).json();
  assert.deepStrictEqual(added, { last: { count: 10, handled: 2 }, calls: 2 }, 'ask 拿到的是 receive 的返回值');

  // 并发 20 条：如果没有串行保证，读-改-写会丢更新（结果会小于 30）
  const burst = await (await fetch(`${base}/counter/burst`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ times: 20 }),
  })).json();
  assert.strictEqual(burst.count, 30, '并发消息必须串行处理（10 + 20 = 30，一条都不能丢）');
  // 处理条数 = 2（add）+ 20（并发）+ 1（burst 结尾那次读取）= 23
  assert.strictEqual(burst.handled, 23, '每条消息（含读取）都被处理过');

  // 查询也走 Actor（只是为了演示 ask 的返回值；真实统计该走投影/仓储）
  assert.deepStrictEqual(await (await fetch(`${base}/counter`)).json(), { count: 30, handled: 24 });
} finally {
  await app.stop();
  await app.stop(); // 停机幂等：第二次不该抛、不该重复释放
  fs.rmSync(persistenceDir, { recursive: true, force: true });
}
console.log('ok');
```

> 这段里的 `setImmediate` 是**故意**的：它把"读-改-写"的窗口拉开，
> 如果 Actor 不串行，20 条并发必丢更新。所以这个断言是可证伪的。

## 7. 相关

- 依赖注入与 provider 解析 → [02 项目结构](./02-project-layout.md)
- 事件溯源聚合（`defineAggregate`）与投影 → [internals/04-data-layer](./internals/04-data-layer.md)
- 集群下的位置透明（`ctx.actor` 触达别的节点）→ [internals/05-cluster](./internals/05-cluster.md)
- Actor 起不来 / 超时 → [19 排错手册](./19-troubleshooting.md)
