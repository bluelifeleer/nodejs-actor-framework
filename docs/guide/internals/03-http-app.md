# 3. HTTP 应用（@actor/app + @actor/web）

用户项目只依赖 `@actor/app` + `@actor/web`（**不接触内核**）。分工：

| 包 | 管什么 |
|---|---|
| `@actor/app` | 配置（schema/默认值/校验）、模块装配、依赖注入、插件启停、优雅停止 |
| `@actor/web` | 控制器、路由表、输入校验、错误 → HTTP 语义、请求上下文 |

## 最小可跑（真的会起 HTTP、真的会请求）

```js verify
import assert from 'node:assert';
import { createApp, defineApp, defineModule } from '@actor/app';
import { HttpError, defineController, defineRoutes, get, post, reply, httpPlugin } from '@actor/web';

// 1) 业务 Actor：普通类，无继承；依赖由框架注入
class Counter {
  constructor(deps) {
    this.deps = deps;
    this.count = 0;
  }
  receive(msg) {
    if (msg.type === 'add') this.count += msg.by ?? this.deps.config.get('step');
    return this.count;
  }
}

// 2) 控制器：声明输入从哪来（body/query/params）与校验规则，其余交给框架
const counter = {
  add: defineController({
    body: ['by'],
    input: { by: { type: 'number', min: 1 } },
    async handle(input, ctx) {
      const value = await ctx.actor('Counter').ask({ type: 'add', by: input.by });
      return reply.json({ count: value }, { status: 201 });
    },
  }),
  read: defineController({
    async handle(_input, ctx) {
      return { count: await ctx.actor('Counter').ask({ type: 'get' }) };
    },
  }),
  missing: defineController({
    async handle() {
      throw new HttpError(404, '这里没有你要的东西'); // 明确语义，而不是 500
    },
  }),
};

// 插件实例要在外面拿着：端口传 0 时，起完才能从它身上读真实地址
const http = httpPlugin({ shutdownTimeoutMs: 2000 });

const app = defineApp({
  config: { step: { type: 'number', default: 1, min: 1 } }, // 也可以放在 config/default.ts
  modules: [
    defineModule({
      name: 'counter',
      actors: { Counter },
      routes: defineRoutes([post('/add', counter.add), get('/count', counter.read), get('/nope', counter.missing)]),
    }),
  ],
  plugins: [http],
});

// 3) 起应用：插件端口取 0 = 随机端口（测试里最省事；生产用配置或 APP_PLUGINS__HTTP__PORT）
process.env.APP_PLUGINS__HTTP__PORT = '0';
const application = createApp(app);

try {
  await application.start();
  const address = http.address(); // { host, port }：HTTP 服务由 @actor/web 的插件自己起
  const base = `http://${address.host}:${address.port}`;

  const added = await fetch(`${base}/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 5 }),
  });
  assert.strictEqual(added.status, 201, '控制器可以用 reply.json(..., { status }) 指定状态码');
  assert.deepStrictEqual(await added.json(), { count: 5 });

  assert.deepStrictEqual(await (await fetch(`${base}/count`)).json(), { count: 5 });

  // 输入校验失败 → 400，并**一次性列出所有问题**（不是抛第一个就完）
  const invalid = await fetch(`${base}/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 0 }),
  });
  assert.strictEqual(invalid.status, 400);
  assert.strictEqual((await invalid.json()).error.details.issues[0].path, 'by');

  // 业务语义错误 → 用 HttpError 明确表达
  assert.strictEqual((await fetch(`${base}/nope`)).status, 404);

  // 方法不对 → 405（不是 404）
  assert.strictEqual((await fetch(`${base}/count`, { method: 'DELETE' })).status, 405);
} finally {
  await application.stop({ timeoutMs: 2000 });
}
console.log('ok');
```

## 配置：schema 就是默认值 + 校验规则

> 两个入口别搞混：`loadConfig(definition, ...)` 收 **defineConfig() 的结果**，
> `validateValues(schema, values)` 收 **原始 schema 对象**。传错会拿到一条明确的错误提示
> （以前这里会**栈溢出**，写这份文档的示例时才发现并修掉）。

```js verify
import assert from 'node:assert';
import { ConfigValidationError, defineConfig, loadConfig, validateValues } from '@actor/app';

const rawSchema = {
  step: { type: 'number', default: 1, min: 1 },
  token: { type: 'string', default: '', secret: true }, // secret: 日志/诊断里自动打码
};
const schema = defineConfig(rawSchema);

// validateValues 收**原始 schema**：填默认值 + 校验，**不抛错**，把问题一次列全（好让用户一次改完）
const ok = validateValues(rawSchema, {});
assert.deepStrictEqual(ok.values, { step: 1, token: '' });
assert.deepStrictEqual(ok.issues, []);

const bad = validateValues(rawSchema, { step: 0 });
assert.strictEqual(bad.issues.length, 1);
assert.deepStrictEqual(bad.issues[0].path, 'step');
assert.match(bad.issues[0].message, /不得小于 1/);

// loadConfig：配置文件分层 + 环境变量覆盖（camelCase → APP_UPPER_SNAKE；嵌套用 __）
process.env.APP_STEP = '3';
const loaded = await loadConfig(schema, { env: process.env, configDir: '/nonexistent-config-dir' });
assert.strictEqual(loaded.get('step'), 3, '环境变量优先于默认值');
delete process.env.APP_STEP;

// 传错了要给**能看懂的**错误，而不是栈溢出
assert.throws(
  () => validateValues(defineConfig(rawSchema), {}),
  (err) => err instanceof ConfigValidationError && /原始 schema/.test(err.message),
);
console.log('ok');
```

## 优雅停止

`application.stop({ timeoutMs })`：先让插件停收新请求（逆序），再让内核收尾（含停止时快照），
超时后强制结束。信号处理要**在任何 await 之前注册**（否则启动窗口内收到 SIGTERM 会走默认行为）：

```ts
// main.ts
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void application.stop({ timeoutMs: 10_000 }).then(() => process.exit(0));
  });
}
```

完整可运行示例见 [`examples/app-data`](../../../examples/app-data/README.md)（CRUD + Actor + 投影 + 迁移门）
与 [`examples/app-web`](../../../examples/app-web/README.md)。

下一步：[数据层](./04-data-layer.md) / [应用层语法糖](../09-app-sugar.md)（控制器输入简写、
中间件阶段简写、`crudRoutes`/`healthRoutes` 工厂，以及保留名与 debug 可见性）。
