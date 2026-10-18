# 04. 新手路线：前 3 小时怎么走

**你会得到**：一条按时间boxed 的路线（每一步都有"验收"，做完再往下），以及卡住时该翻哪一页。

**前置**：装了 Node.js ≥ 24（`node -v` 看一下）。　**耗时**：3 小时（可拆成多次）。

> 这一页是**路线图**，不是教程：每一步都指向真正讲那件事的页面。
> 顺序是刻意排的 —— 先看到东西跑起来，再理解模型，最后才动状态与部署。

## 第 0 步（5 分钟）：先让东西跑起来

```bash
npx @actor/cli new app my-app       # 发布后可直接用；仓库内开发用 node packages/cli/src/cli.ts new app my-app
cd my-app
npm install
npm test                            # 4 条端到端测试
npm start                           # 起 HTTP（默认 127.0.0.1:9000）
```

**验收**：`npm test` 全绿，`npm start` 打印出监听地址，`curl -s localhost:9000/health` 返回 200。
**卡住看**：[01 五分钟上手](./01-quickstart.md)（含四个 curl 请求）· [19 排错手册](./19-troubleshooting.md)

## 第 1 小时：看懂"状态为什么归 Actor"

先读 [00 什么是 Actor](./00-what-is-an-actor.md)（15 分钟，含一个可跑的"丢更新 vs 不丢更新"对照），
再读 [03 推荐写法与约定](./03-recommended-style.md)（6 分钟，明确"每个环节就写这一种"）。

**验收**：你能回答三个问题 ——
① 为什么同一个 Actor 里不用加锁？② `tell` 和 `ask` 失败时分别怎么知道？③ 什么时候**不该**用 Actor？
**卡住看**：[00 §7 四条常见误解](./00-what-is-an-actor.md#8-四条常见误解)

## 第 2 小时：写出你的第一个接口 + 把状态搬进 Actor

- 接口：读 [10 路由与请求](./10-http-routing.md) —— 路由写哪、输入怎么声明、错误怎么映射成状态码；
- 状态：读 [12 Actor 与状态](./12-actors-state.md) —— 状态放哪、怎么调、快照/事件两种持久化。

**验收**（这两条就是上面两页的核心）：

```bash
curl -s -X POST localhost:9000/notes -H 'content-type: application/json' -d '{"title":"第一条"}'   # 201
curl -s 'localhost:9000/notes?limit=5'                                                            # 200 + 列表
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:9000/notes -H 'content-type: application/json' -d '{}'   # 400
```

**卡住看**：[03 推荐写法](./03-recommended-style.md)（写法该长什么样）· [19 排错手册](./19-troubleshooting.md)

## 第 3 小时：测试与上线

- 测试：读 [17 测试](./17-testing.md) —— 用真内核测、虚拟时钟把"等一小时"变成 0 毫秒；
- 上线：读 [22 部署与构建](./22-deploy-and-build.md)（直跑 `.ts` 或编译成 JS，两条路 + Dockerfile）
  与 [18 可观测与上线](./18-observability-deploy.md)（日志、诊断路由、优雅停机、检查清单）。

**验收**：
① 你给新接口写了至少一条测试，且里面有**失败路径**（400/404/405 之一）；
② `actor doctor` 全绿；
③ 你能说清"我这次上线选直跑还是编译，为什么"。
**卡住看**：[20 错误与日志](./20-errors-and-logging.md)（出错时看不到原因）· [25 增量迁移](./25-incremental-migration.md)（已有服务怎么搬）

## 从别的框架过来？

不必从第 0 步开始按顺序走，直接看对照表更快：

- Express / Koa / Fastify → [23 从 Express 过来](./23-from-express.md)
- NestJS → [24 从 NestJS 过来](./24-from-nestjs.md)
- 不想推倒重来 → [25 增量迁移](./25-incremental-migration.md)

## 跑一遍（CI 真执行）

第 2 小时的"接口 + Actor"最小闭环，就是下面这段（配置 → 控制器 → Actor → 请求）：

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const appLayer = await import(`${repo}packages/app/src/index.ts`);
const webLayer = await import(`${repo}packages/web/src/index.ts`);
const { createApp, defineApp, defineConfig, defineModule } = appLayer;
const { defineController, defineRoutes, get, httpPlugin, post, reply } = webLayer;

const config = defineConfig({ greeting: { type: 'string', default: 'hi' } });

// 状态归 Actor：消息串行，读-改-写不需要锁
const Counter = {
  preStart() { this.state = { n: 0 }; },
  receive(msg) { this.state.n += msg.by; return this.state.n; },
};

const bump = defineController({
  body: ['by'],
  input: { by: { type: 'number', min: 1 } },
  handle: async (input, ctx) => ({ total: await ctx.actor('Counter').ask({ by: Number(input.by) }) }),
});
const health = defineController({ handle: (_input, ctx) => reply.json({ ok: true, greeting: String(ctx.config.get('greeting')) }) });

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    config,
    modules: [
      defineModule({
        name: 'app',
        actors: { Counter: { definition: Counter } },
        routes: defineRoutes([get('/health', health), post('/bump', bump)]),
      }),
    ],
    plugins: [http],
  }),
  { configDir: '', env: {}, kernel: { logger: false } },
);

await app.start();
try {
  const base = `http://127.0.0.1:${String(http.address()?.port)}`;

  assert.strictEqual((await fetch(`${base}/health`)).status, 200);
  assert.deepStrictEqual(await (await fetch(`${base}/health`)).json(), { ok: true, greeting: 'hi' }, '配置按声明读到');

  const post = (body) => fetch(`${base}/bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepStrictEqual(await (await post({ by: 2 })).json(), { total: 2 });
  assert.deepStrictEqual(await (await post({ by: 3 })).json(), { total: 5 }, '同一 Actor 串行：读到的一定是上一个结果');
  assert.strictEqual((await post({})).status, 400, '校验失败是 400，不是 500');

  console.log('newcomer-path-ok');
} finally {
  await app.stop();
}
```

## 下一步

- 先补模型：[00 什么是 Actor](./00-what-is-an-actor.md)
- 再定写法：[03 推荐写法与约定](./03-recommended-style.md)
- 想直接照抄一个完整项目：[01 五分钟上手](./01-quickstart.md)（脚手架自带 8 个可跑的示例项目）
