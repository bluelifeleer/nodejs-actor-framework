# 03. 只写这一种：推荐写法与约定

**你会得到**：每个环节"就写这个"的明确答案（与脚手架生成的项目一致），以及"等价写法去哪查"的出口。

**前置**：跑得起来一个项目（[01 五分钟上手](./01-quickstart.md)）。　**耗时**：6 分钟。

## 1. 为什么要有这一页

同一个框架里如果有三种都"行"的写法，新人第一反应不是"真灵活"，而是**"我该写哪个？"**。
所以这里给出**一种推荐写法**（就是脚手架生成的样子），其余等价形态**不在这条主线上**：

> 规则：**主线只推一种写法**。等价写法（class 形态 Actor、`createActor`、值即 schema 的配置、
> `{ handler, phase }` 的全量中间件…）在 [实现说明：应用层语法糖](./internals/17-app-sugar.md) 里，
> 需要时再查 —— 它们与推荐写法**逐字段等价**，由那里的门禁（`deepStrictEqual`）保证，不是"大概一样"。

## 2. 一张表：每个环节就写这个

| 环节 | 推荐写法 | 不推荐/备用（去哪查） |
|---|---|---|
| 定义 Actor | **handler bag**：`export const Counter = { preStart() {…}, receive(msg) {…} }` | `class X extends Actor`、`createActor()`、裸函数 → [internals/17](./internals/17-app-sugar.md)（注意：class 形态**不能**开持久化，启动期会拒绝） |
| 挂 Actor | `actors: { Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } } }` | 无糖 |
| 控制器 | `defineController({ body: [...], input: {...}, handle })` | 省掉 `body:` 让框架按 `input` 推断来源 → 显式写更省心，见 [10 路由与请求](./10-http-routing.md) |
| 路由 | `defineRoutes([get('/x?q=', c), post('/y', c)])` | `router` + `defineRouter` 做前缀分组（[10](./10-http-routing.md) §1） |
| 模块装配 | `defineModule({ name, providers, actors, middleware, routes })` | 无糖（**显式装配是有意的**，见 §4） |
| 配置 | **显式声明**：`defineConfig({ dataDir: { type: 'string', default: './data' } })` | 值即 schema（`dataDir: './data'`）→ [internals/17](./internals/17-app-sugar.md) |
| 中间件 | `atPre/atAuth/atPost(...)`（阶段即函数名） | `{ handler, phase }` 全量形态 → [internals/17](./internals/17-app-sugar.md) |
| 持久化 | `options: { persistence: { mode: 'snapshot' } }`（或 `'events'`） | —（[12 Actor 与状态](./12-actors-state.md)） |
| 错误 | 控制器里 `throw new HttpError(409, …)`；框架/内核失败配 `errors` 钩子 | —（[20 错误与日志](./20-errors-and-logging.md)） |
| 测试 | `node --test` + 真 app（`createApp` 起、`fetch` 打、`stop`） | 虚拟时钟 / 故障注入（[17 测试](./17-testing.md)） |

## 3. 一份"全都按推荐写法"的最小项目

这就是脚手架 `actor new app` 生成的样子（照着改最快）：

```ts
// config/default.ts —— 配置：显式类型 + 默认值
import { defineConfig } from '@actor/app';
export default defineConfig({ dataDir: { type: 'string', default: './data' } });

// src/actor/counter.actor.ts —— Actor：handler bag，状态只在 this.state
export const Counter = {
  preStart(this: { state: { n: number } }) { this.state = { n: 0 }; },
  receive(this: { state: { n: number } }, msg: { by: number }) {
    this.state.n += msg.by;                       // 串行执行：读-改-写不会交错
    return this.state.n;
  },
};

// src/controller/hello.controller.ts —— 控制器：只放 HTTP 语义
import { defineController, reply } from '@actor/web';
export const hello = defineController({
  input: { name: { type: 'string', default: 'world' } },
  handle: (input) => reply.json({ ok: true, name: input.name }),
});

// src/module.ts —— 装配：显式列出来
import { defineModule } from '@actor/app';
import { defineRoutes, get } from '@actor/web';
export default defineModule({
  name: 'app',
  actors: { Counter: { definition: Counter } },
  routes: defineRoutes([get('/hello?name=', hello)]),
});
```

## 4. 三个"看起来啰嗦但请别省"的地方

1. **模块里显式列出 actors/routes**：不自动扫描目录。换来的是"启动期就能报错"（重复路由、输入键没有来源、
   provider 缺依赖、保留名冲突都在 `start()` 当场拒绝），而不是上线后 404/undefined。
   生成骨架时用 `actor generate <kind> <name> --mount` 自动插进标记处，手工成本并不高。
2. **配置显式写类型**：值即 schema 的简写能省几个字符，但显式写法让"必填/范围/机密"一眼可见，
   也避免把 `'./data'` 这种**字符串默认值**误当成"类型声明"。
3. **`body: [...]` 与 `input` 的关系**：`body` 只说"这些字段从请求体来"，校验规则仍在 `input`；
   两者的优先级规则见 [10 路由与请求](./10-http-routing.md) §2。

## 5. 跑一遍（CI 真执行）

下面这段**只用推荐写法**起一个真应用，验证三件事：路由能响应、Actor 串行累加、配置可读。

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule, defineConfig } = await import(`${repo}packages/app/src/index.ts`);
const { defineController, defineRoutes, get, httpPlugin, reply } = await import(`${repo}packages/web/src/index.ts`);

// ① 配置：显式类型 + 默认值
const config = defineConfig({ greeting: { type: 'string', default: 'hi' } });

// ② Actor：handler bag（推荐形态）
const Counter = {
  preStart() { this.state = { n: 0 }; },
  receive(msg) { this.state.n += msg.by; return this.state.n; },
};

// ③ 控制器：只放 HTTP 语义
const hello = defineController({
  input: { name: { type: 'string', default: 'world' } },
  handle: (input) => reply.json({ ok: true, name: input.name }),
});

// ④ 装配：显式列出 actors 与 routes
const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    config,
    modules: [
      defineModule({
        name: 'app',
        actors: { Counter: { definition: Counter } },
        routes: defineRoutes([get('/hello?name=', hello)]),
      }),
    ],
    plugins: [http],
  }),
  { configDir: '', env: {}, kernel: { logger: false } },
);

await app.start();
try {
  const base = `http://127.0.0.1:${String(http.address()?.port)}`;
  assert.strictEqual((await fetch(`${base}/hello?name=actor`)).status, 200);
  assert.deepStrictEqual(await (await fetch(`${base}/hello?name=actor`)).json(), { ok: true, name: 'actor' });

  const counter = app.actor('Counter');
  assert.strictEqual(await counter.ask({ by: 2 }), 2);
  assert.strictEqual(await counter.ask({ by: 3 }), 5, '同一 Actor 的消息串行，读到的一定是上一个结果');
  assert.strictEqual(app.config.get('greeting'), 'hi', '配置按显式声明读取');

  console.log('style-ok');
} finally {
  await app.stop();
}
```

## 下一步

- 路由、校验、错误码的完整规则：[10 路由与请求](./10-http-routing.md)
- 状态放哪、怎么持久化：[12 Actor 与状态](./12-actors-state.md)
- 想看等价写法与逐条等价证明：[实现说明：应用层语法糖](./internals/17-app-sugar.md)
