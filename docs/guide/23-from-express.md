# 23. 从 Express 过来：映射表与增量迁移

**你会得到**：Express 里每个常见概念在本文档里的对应物、一眼能看懂的差异，以及"不用重写"的迁移顺序。

**前置**：用过 Express（或 Koa/Fastify 同类）；跑得起来一个项目。　**耗时**：15 分钟。

> 一句话：**HTTP 那层很像**（路由 + 中间件 + 状态码），**差别在状态放哪**：
> Express 里你把状态放在模块级变量/服务单例里，本文档把它放进 Actor（消息串行，不用锁）。
> 详见 [00 什么是 Actor](./00-what-is-an-actor.md)。

## 1. 概念映射表

| Express | 本文档 | 差异要点 |
|---|---|---|
| `expressApp.get('/notes/:id', h)` | `defineRoutes([get('/notes/:id', c)])` | 路由**声明在模块上**，启动期统一校验（重复路由/非法模式/输入键无来源 → 拒绝启动） |
| `req.params.id` / `req.query.x` / `req.body` | 控制器 `input` 声明 + 自动按来源取值 | 读一次 `input`，来源由**路由模式或显式 `from`** 决定，不用手写 `req.` |
| 手写 `if (!req.body.title) return res.status(400)…` | `input: { title: { type: 'string', min: 1 } }` | 校验失败自动 400，错误形状统一（[10 路由与请求](./10-http-routing.md) §2） |
| `res.status(409).json({…})` | `throw new HttpError(409, '…')` 或 `reply.json(body, { status: 409 })` | **抛错即响应**：控制器只管抛，映射表见 [10](./10-http-routing.md) §3 |
| `expressApp.use((req,res,next) => …)` | `atPre/atAuth/atPost(…)` | **阶段即函数名**：顺序由框架保证（不用自己排 use 的顺序） |
| `expressApp.use('/api', router)` | `router` + `defineRouter`（前缀套整棵子树） | 同 [10](./10-http-routing.md) §1 |
| `expressApp.locals` / 模块级变量存状态 | **Actor**：`this.state` + 消息 | 这是最大的差别：进程内共享可变状态在本文档里归 Actor |
| `expressApp.set('x', v)` / `process.env` | `defineConfig({…})` + env 覆盖 | 配置有 schema 与校验，启动期就报错（[14 配置与密钥](./14-config-env.md)） |
| 手写 `res.status(500)` 兜底 + `console.error` | 5xx 自动映射 + `errors.onHttpError` / `logging` | 内部细节不回客户端；服务端有显式出口（[20 错误与日志](./20-errors-and-logging.md)） |
| `expressApp.listen(3000, cb)` | `httpPlugin({ port: 3000 })` + `createApp(...).start()` | 启动是**装配**：模块/插件/provider 都在 `start()` 前声明好 |
| `supertest(app)` + `node --test` | `node --test` + 真 app（起、fetch、stop） | 见 [17 测试](./17-testing.md) |

**没有变的东西**：路由模式（`:id`）、状态码语义、JSON 响应、中间件这个抽象本身。

> 代码里的变量名刻意用 `expressApp`（而不是 `app`）：文档里的 `app` 专指**框架应用层**
> （`app.defineApp`/`app.get(...)`），避免两种 `app` 混着读。

## 2. 一段真实对照

Express 写法（把"读-改-写"放在模块级变量里，两个请求同时来会算错）：

```js
let balance = 100;                                  // 模块级共享状态：问题在这里
expressApp.post('/debit', (req, res) => {
  const current = balance;
  db.update(...).then(() => { balance = current - 1; res.json({ balance }); });
});
```

本文档写法（同样的 HTTP 语义；状态搬进 Actor，消息串行处理）：

```ts
const Account = {
  preStart() { this.state = { balance: 100 }; },
  async receive(msg) {
    const current = this.state.balance;
    await db.update(...);                            // 同样"慢 IO"，但消息是串行的
    this.state.balance = current - msg.amount;
    return this.state.balance;
  },
};

export const debit = defineController({
  body: ['amount'],
  input: { amount: { type: 'number', min: 1 } },
  handle: async (input, ctx) => ({ balance: await ctx.actor('Account').ask({ amount: Number(input.amount) }) }),
});
```

这个替换的**完整推演**（先复现丢账、再改、再持久化）在
[00 什么是 Actor §11](./00-what-is-an-actor.md#11-五分钟改造演练把共享计数器搬进-actor)。

## 3. 增量迁移：不用停服务、不用重写

**推荐顺序**（每一步都能单独上线、单独回滚）：

1. **先并存**：保留现有 Express 服务，把新接口写成本文档的 app，用同一个进程的不同端口/前缀暴露
   （或者把本文档的 app 挂在现有网关后面）。两边共享同一个数据库即可 —— 状态在库里，风险最低。
2. **再搬"内存态"**：找出模块级可变变量（计数、房间、连接映射、限流器），逐个搬进 Actor。
   搬一个就能删掉一处锁/一处竞态，收益立刻可见。
3. **最后搬装配与配置**：把 `expressApp.set` / `process.env` 读取收敛到 `defineConfig`，
   把中间件收敛到 `atPre/atAuth/atPost`，把 5xx 兜底换成 `errors`/`logging` 出口。
4. **收尾**：`actor doctor` 体检（Node 版本、依赖、配置、数据目录、迁移、端口、生产构建），
   把健康检查与优雅停机对齐（[18 可观测与上线](./18-observability-deploy.md)）。

**不要做的事**：不要一次性重写整个路由树。本文档的模块可以只挂**一棵子树**，
与 Express 的路由互不干扰 —— 先用它承载"有状态、并发写会算错"的那几条路径。

## 4. 跑一遍（CI 真执行）

下面这段同时反映两件事：① Express 风格的取值方式（`req.query` / `req.params` / 手写校验）
在本文档里怎么写；② **同一个进程里，Express 式服务与 Actor 并存**（增量迁移的最小形态）。

```js verify
import assert from 'node:assert';
import http from 'node:http';

const repo = `file://${process.cwd()}/`;
const appLayer = await import(`${repo}packages/app/src/index.ts`);
const webLayer = await import(`${repo}packages/web/src/index.ts`);
const kernel = await import(`${repo}packages/core/src/index.ts`);
const { createSystem } = kernel.default ?? kernel;
const { createApp, defineApp, defineModule } = appLayer;
const { HttpError, defineController, defineRoutes, get, httpPlugin, post } = webLayer;

// ---------- ① 既有服务（Express 风格，未迁移）----------
let legacyHits = 0;
const legacy = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/legacy/health') {
    legacyHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hits: legacyHits }));
    return;
  }
  res.writeHead(404).end();
});

// ---------- ② 新接口（本文档风格，与既有服务并存）----------
const Counter = {
  preStart() { this.state = { n: 0 }; },
  receive(msg) { this.state.n += msg.by; return this.state.n; },
};

// 取值来源：路径参数来自 `:id`，查询参数来自 `?times=`，请求体来自 `body` 声明
const bump = defineController({
  body: ['by'],
  input: { id: { type: 'string' }, times: { type: 'number', default: 1, min: 1, max: 10 }, by: { type: 'number', min: 1 } },
  async handle(input, ctx) {
    if (input.id !== 'main') throw new HttpError(404, 'unknown counter');
    const ref = ctx.actor('Counter');
    let last = 0;
    for (let i = 0; i < Number(input.times); i += 1) last = await ref.ask({ by: Number(input.by) });
    return { id: input.id, total: last };
  },
});

const http2 = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'app',
        actors: { Counter: { definition: Counter } },
        routes: defineRoutes([post('/counters/:id/bump?times=', bump)]),
      }),
    ],
    plugins: [http2],
  }),
  { configDir: '', env: {}, kernel: { logger: false } },
);

await app.start();
await new Promise((resolve) => legacy.listen(0, '127.0.0.1', () => resolve()));
try {
  const legacyPort = legacy.address().port;
  const newBase = `http://127.0.0.1:${String(http2.address()?.port)}`;

  // 既有服务照旧
  assert.deepStrictEqual(await (await fetch(`http://127.0.0.1:${String(legacyPort)}/legacy/health`)).json(), { ok: true, hits: 1 });

  // 新接口：路径参数 + 查询参数 + 请求体都按声明取到
  const ok = await fetch(`${newBase}/counters/main/bump?times=3`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 2 }),
  });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { id: 'main', total: 6 }, '3 次 × 每次 +2，串行累加');

  // 校验：缺必填 → 400（Express 里要自己写 if）
  const bad = await fetch(`${newBase}/counters/main/bump?times=3`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(bad.status, 400);

  // 抛 HttpError 即响应（Express 里是 res.status(404)）
  const missing = await fetch(`${newBase}/counters/nope/bump`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 1 }),
  });
  assert.strictEqual(missing.status, 404);

  console.log('express-mapping-ok');
} finally {
  await app.stop();
  await new Promise((resolve) => legacy.close(() => resolve()));
}
```

## 下一步
- 状态该放哪、怎么不丢：[12 Actor 与状态](./12-actors-state.md)
- 迁移过程中怎么不踩坑（报错原文 → 改法）：[19 排错手册](./19-troubleshooting.md)
- 从 NestJS 过来（装饰器/DI/Guard 的对应物）：[24 从 NestJS 过来](./24-from-nestjs.md)
