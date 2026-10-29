# 17. 测试：真内核、虚拟时钟、故障注入

**你会得到**：用真内核写测试、虚拟时钟（把"等一小时"变成 0 毫秒）、故障注入

**前置**：写过 `node --test` 或任何测试框架　**耗时**：15 分钟

三条原则（与仓库里 1000+ 用例的做法一致）：

1. **不 mock 框架**：起真内核、真 HTTP、真存储 —— 测的是"接线对不对"，mock 掉的正是你要验的东西；
2. **可证伪**：断言要能因为"实现错了"而失败（比如"并发不乱"就真的并发发消息）；
3. **时间不真等**：定时器用虚拟时钟（"等一小时"变成 0 真实毫秒）。

## 1. 测什么放在哪

| 测什么 | 怎么测 | 例子 |
|---|---|---|
| 纯函数/校验/映射 | 直接调，`node:assert` | 路由匹配、`defineModel` 生成的 DDL |
| 控制器 + 路由 + 中间件 | 起真 app + `fetch`（或 `dispatch()` 直接派发） | 状态码、输入校验、错误形状 |
| Actor 行为 | 真内核 `createSystem` + `ask` | 串行、重启后状态、监督 |
| 跨层（HTTP→Actor→存储） | 起真 app，真请求 | 脚手架自带的 4 条用例 |
| 定时/重试/超时 | **虚拟时钟** | rate limit、看门狗、定时清理 |

## 2. 一个最小的"真 app"测试

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { createApp, defineApp, defineModule } from '@actor/app';
import { defineController, defineRoutes, get, httpPlugin } from '@actor/web';

test('GET /health 返回 200 与 ok', async () => {
  const http = httpPlugin({ port: 0 });          // 0 = 随机空闲端口（避免抢端口）
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'app',
          routes: defineRoutes([get('/health', defineController({ handle: () => ({ ok: true }) }))]),
        }),
      ],
      plugins: [http],
    }),
    { configDir: null, env: {} },                 // 不读 config 目录（用例自包含）
  );
  await app.start();
  try {
    const response = await fetch(`http://127.0.0.1:${http.address().port}/health`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { ok: true });
  } finally {
    await app.stop();                             // 一定要停：否则进程不退出
  }
});
```

要点：`configDir: null`（不读磁盘上的配置）、`port: 0`（不抢端口）、`finally` 里 `stop()`。

## 3. 虚拟时钟：把"等一小时"变成 0 毫秒

```ts
import { createVirtualClock } from '@actor/testkit';
import { createSystem } from 'nodejs-actor-framework';

const virtual = createVirtualClock({ start: 0 });
const system = createSystem({ clock: virtual.clock });     // 内核的定时器全走它

// ……触发一个"60 秒后超时"的逻辑……

const fired = await virtual.advance(60_000);               // 虚拟时间前进，真实耗时 ≈ 0
assert.ok(fired >= 1, '到点的定时器必须真的被触发');
assert.strictEqual(virtual.now(), 60_000);
```

`runAll()` 会把**所有**已排期定时器跑完（周期定时器跑 `maxSteps` 轮，超出直接报错 ——
这样"无限自调度"不会挂死测试）。

**注意**：虚拟时钟只管**定时器**；协程/消息投递仍走真实调度器，所以 `advance` 之后要
`await virtual.flush()`（或框架内建的多轮 microtask 冲刷）让续体跑完 —— 参数 `flushTurns` 就是为这个。

## 4. 故障注入：把"生产里偶发"变成显式声明

```ts
import { createFaultInjector } from '@actor/testkit';

const faults = createFaultInjector({
  rules: [
    { target: 'Player', failTimes: 2, error: new Error('磁盘抖了一下') },   // 前两次必失败
    { target: 'Slow', delayMs: 500 },                                     // 变慢
  ],
});
// 把它接到内核/Actor 的失败路径上，然后断言"重试后成功、监督策略按预期生效"
```

原则：**故障是显式声明的**（写在用例里），不是"偶尔红一次"的 flaky。

## 5. 跑一遍（CI 真执行）

下面这段演示两件事：真 app 的端到端断言 + 虚拟时钟把 30 秒的定时器变成 0 真实毫秒。

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { defineController, defineRoutes, get, httpPlugin } = await import(`${repo}packages/web/src/index.ts`);
const { createVirtualClock } = await import(`${repo}packages/testkit/src/index.ts`);

// ① 真 app：起真 HTTP、真请求、断言状态码与响应体，最后一定停
{
  const http = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'app',
          routes: defineRoutes([
            get('/health', defineController({ handle: () => ({ ok: true }) })),
            get('/notes/:id', defineController({
              input: { id: { from: 'params', type: 'string' } },
              handle: (input) => {
                if (input.id === 'missing') throw Object.assign(new Error('not found'), { name: 'HttpError', status: 404 });
                return { id: input.id };
              },
            })),
          ]),
        }),
      ],
      plugins: [http],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  try {
    const base = `http://127.0.0.1:${String(http.address()?.port)}`;
    assert.strictEqual((await fetch(`${base}/health`)).status, 200);
    assert.deepStrictEqual(await (await fetch(`${base}/notes/42`)).json(), { id: '42' });
    // 不存在的资源 → 404（错误语义也能测）
    assert.ok((await fetch(`${base}/notes/missing`)).status >= 400);
    // 没声明的路由 → 404
    assert.strictEqual((await fetch(`${base}/nope`)).status, 404);
  } finally {
    await app.stop();
    await app.stop();     // 停机幂等：重复 stop 不该抛
  }
}

// ② 虚拟时钟：30 秒的定时器不真等
{
  const virtual = createVirtualClock({ start: 1_000_000 });
  const fired = [];
  virtual.clock.setTimeout(() => fired.push(virtual.now()), 30_000);
  assert.deepStrictEqual(fired, [], '还没到点，不该触发');
  const realStart = Date.now();

  const count = await virtual.advance(30_000);
  assert.strictEqual(count, 1, '到点应当触发一个定时器');
  assert.deepStrictEqual(fired, [1_030_000], '触发时虚拟时间就是到期时刻');
  assert.strictEqual(virtual.now(), 1_030_000);
  assert.ok(Date.now() - realStart < 5_000, `真实耗时必须接近 0（实测 ${Date.now() - realStart}ms）`);
  assert.strictEqual(virtual.pending(), 0, '没有遗留定时器');
}
console.log('ok');
```

## 6. 相关

- 已有示例的测试怎么写的：`examples/*/test/`、脚手架生成项目的 `test/api.test.ts`
- 测试用 http 客户端与探针 → [internals/06-testing](./internals/06-testing.md)
- 契约套件（自己写插件/适配器时自证合规）→ [internals/11-custom-adapter](./internals/11-custom-adapter.md)
- 契约套件仍从各包主入口导出；`node:test` 是**惰性加载**的：应用 import 生产入口不会启动测试运行器，
  只有真正调用 `run*Contract` 时才加载。打包到 serverless/边缘时不用担心测试框架被带进去。

## 下一步


- [19 排错手册](./19-troubleshooting.md)
- [18 可观测与上线](./18-observability-deploy.md)
