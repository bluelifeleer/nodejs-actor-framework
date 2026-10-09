# 18. 可观测与上线：日志、诊断、优雅停、检查清单

**你会得到**：日志三条线怎么分、诊断路由怎么开才安全、优雅停机、上线检查清单

**前置**：有可跑的项目　**耗时**：15 分钟

## 1. 日志：三条线，各管一段

| 你想要 | 装什么 | 输出 |
|---|---|---|
| 访问日志（每请求一行/一条 JSON） | `requestLogPlugin()` | 方法/路径/状态/耗时/requestId，慢请求标 `SLOW` |
| 请求内的子日志（自动带 requestId，meta 脱敏） | `httpPlugin({ logger })` → 控制器里 `ctx.log.info(...)` | 结构化条目，`password`/`authorization` 等自动打码 |
| 5xx 与内部错误 | `app.on('http:error', …)` | `{ requestId, status, path, error }`（**响应里不含细节**） |

```ts
import { requestLogPlugin } from '@actor/web';

plugins: [
  httpPlugin({ port: 9000, logger: (event, meta) => myLogger.info(event, meta) }),
  requestLogPlugin({ format: 'json', slowMs: 500, sampleRate: 1, onRequest: (entry) => myLogger.info('http', entry) }),
],
```

要点：
- **采样只管普通请求**：慢请求（≥ `slowMs`）**永远记**（采样时最怕把事故采掉）；
- **header 默认不收集**（`includeHeaders: true` 才收，且仍会脱敏）；
- 库代码**不自己写 stdout**：出口由你给（框架只在内部用 console 兜底）。

## 2. 诊断路由 `/__debug/*`（默认关、需 token、生产拒绝启动）

```ts
import { debugPlugin } from '@actor/web';

plugins: [
  debugPlugin({
    enabled: process.env.APP_DEBUG === '1',          // 默认关：不显式打开就没有这些路由
    token: process.env.APP_DEBUG_TOKEN,              // 开启必须给（≥16 字符）
    allowInProduction: false,                        // 生产默认拒绝启动；要开必须显式承认
    expose: { hidePrefixes: ['/internal'] },         // 只影响"诊断输出暴露什么"
  }),
],
```

| 路由 | 给什么 |
|---|---|
| `GET /__debug/routes` | 路由表（方法/模式/中间件阶段），按可见性作用域过滤 |
| `GET /__debug/health` | 各**受管资源**的 `stats()`；`?check=1` 时再跑真实探活 |
| `GET /__debug/config` | 配置**形状**（键/类型/是否等于默认值），**值一律打码** |

**三层门禁**（这是安全边界，别再自己加"隐藏"）：默认关闭 → 需要 token → 生产拒绝启动。

**四层可见性作用域**（这不是安全边界，只是减少信息面）：

```ts
debugPlugin({ expose: { hidePrefixes: ['/internal'] } })     // 全局：按前缀
defineModule({ debug: { hidePrefixes: ['/admin/audit'] } })  // 模块内按前缀
defineModule({ debug: { expose: false } })                    // 整个模块不进诊断输出
defineController({ debug: 'off', handle })                    // 单条路由不进诊断输出
```

> 反例警示："隐藏了就等于保护了"是错的 —— 被隐藏的路由照样能被访问，诊断端点没 token 照样 401。
> 真正的保护是鉴权（[13 鉴权](./13-auth.md)）。

## 3. 优雅停：进程怎么退

`main.ts` 里的样板（脚手架已生成）：

```ts
const application = createApp(app, { configDir: new URL('./config', import.meta.url).pathname });

// ① 信号处理器必须在**任何 await 之前**注册（否则启动窗口内收到 SIGTERM 会走默认行为：直接死）
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;                       // ② 重复信号只处理一次（幂等）
    stopping = true;
    void application
      .stop({ timeoutMs: 10_000 })              // ③ 有界：等在途请求，超时就切断
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

await application.start();
```

停止顺序（框架保证）：**插件 `onStopping`（停收新请求）→ 模块 `onStop`（逆序）→ 内核停止（有界）→ 插件 `teardown` → provider `dispose`（逆序）**。

自己写 `main.ts` 时用 `runApp()` 更省事（它把上面这些顺序固定下来，且退出行为可注入以便测试）：

```ts
import { runApp } from '@actor/app';
import app, { http } from './server.ts';

await runApp(app, {
  configDir: new URL('./config', import.meta.url).pathname,
  onStarted: () => console.log(`listening on http://${http.address()?.host}:${http.address()?.port}`),
});
```

## 4. 上线检查清单

**启动**
- [ ] 端口/主机来自配置或环境变量（不硬编码）；`APP_PLUGINS__HTTP__HOST=0.0.0.0` 才对外
- [ ] 必填配置在启动期就报错（`{ type: 'string' }` 不给默认值），**不要**留到运行期 `undefined`
- [ ] 连不上数据库/Redis 就**拒绝启动**（框架默认如此，别改成静默降级）
- [ ] 迁移状态在启动前检查（`actor migrate status`；有未应用就拒绝启动）

**运行**
- [ ] 访问日志开着，`slowMs` 按你的 SLO 调；日志出口接到采集系统
- [ ] `http:error` 事件接上（5xx 必须留痕）
- [ ] `/__debug/*` 只在需要时开、token 从环境变量给、生产保持拒绝

**停止**
- [ ] 用 `SIGTERM`（K8s/PM2/Systemd 默认就是它），并在编排里给足 `terminationGracePeriodSeconds`（≥ `stop` 的 timeout）
- [ ] 发了信号后会**先停收新请求**再退（反向代理/负载均衡也要在这个窗口里摘流量）
- [ ] 退出码：正常 0，停止失败 1

**安全**
- [ ] 密钥只从环境变量/密钥管理服务来（`secret: true` 让诊断输出打码）
- [ ] `authPlugin` 的 `algorithms` 收紧；`@actor/web` 的 upload 白名单按需开
- [ ] 生产 `NODE_ENV=production`（debugPlugin 据此拒绝启动）

## 5. 跑一遍（CI 真执行）

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { defineController, debugPlugin, defineRoutes, get, httpPlugin, requestLogPlugin } = await import(
  `${repo}packages/web/src/index.ts`
);

const TOKEN = 'a-very-long-debug-token';
const entries = [];

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({ name: 'site', routes: defineRoutes([get('/notes', defineController({ handle: () => ({ ok: true }) }))]) }),
      defineModule({
        name: 'internal',
        debug: { expose: false },
        routes: defineRoutes([get('/internal/secret', defineController({ handle: () => ({ secret: true }) }))]),
      }),
    ],
    plugins: [http, requestLogPlugin({ slowMs: 0, onRequest: (entry) => entries.push(entry) }), debugPlugin({ enabled: true, token: TOKEN, expose: { hidePrefixes: ['/internal'] } })],
  }),
  { configDir: null, env: {} },
);

// 优雅停：寄存器在 start() 之前就绪（这里手工模拟一次 stop 的幂等性）
await app.start();
const base = `http://127.0.0.1:${String(http.address()?.port)}`;
try {
  // ① 访问日志真的记了（slowMs: 0 → 每条都算慢）
  assert.strictEqual((await fetch(`${base}/notes`)).status, 200);
  assert.ok(entries.length >= 1, 'requestLogPlugin 必须收到条目');
  assert.strictEqual(entries.at(-1).path, '/notes');

  // ② 诊断路由三层门禁：没 token → 401
  assert.strictEqual((await fetch(`${base}/__debug/routes`)).status, 401);
  assert.strictEqual((await fetch(`${base}/__debug/routes`, { headers: { 'x-debug-token': 'wrong-token-wrong-token' } })).status, 401);

  // ③ 带 token → 200，且诊断输出按可见性过滤
  const routes = await (await fetch(`${base}/__debug/routes?token=${TOKEN}`)).json();
  const patterns = routes.routes.map((route) => route.pattern);
  assert.ok(patterns.includes('/notes'), `公开路由要在：${patterns.join(', ')}`);
  assert.ok(!patterns.some((item) => item.includes('/internal')), `隐藏的作用域不能出现：${patterns.join(', ')}`);

  // ④ 被"隐藏"的路由照样可用（证明隐藏不是安全边界）
  assert.strictEqual((await fetch(`${base}/internal/secret`)).status, 200);

  // ⑤ 健康检查聚合受管资源（这里没装受管资源 → 空报告 + 计数 0）
  const health = await (await fetch(`${base}/__debug/health?token=${TOKEN}`)).json();
  assert.strictEqual(health.count, 0);
  assert.deepStrictEqual(health.resources, []);

  // ⑥ 配置诊断只给形状，值打码
  const config = await (await fetch(`${base}/__debug/config?token=${TOKEN}`)).json();
  assert.ok(config.entries.every((entry_) => entry_.value === '[redacted]'), '诊断里的配置值必须打码');
} finally {
  await app.stop();
}
assert.ok(true, '优雅停没有抛错（幂等：重复 stop 也不会）');
console.log('ok');
```

## 6. 相关

- 脱敏规则与日志字段全表 → [internals/15-observability](./internals/15-observability.md)
- span/指标/OTLP 导出（内核级可观测性）→ [internals/07-observability](./internals/07-observability.md)
- 停不下来 / 端口占用 / 诊断 401 → [19 排错手册](./19-troubleshooting.md)

## 下一步


- [22 部署与构建](./22-deploy-and-build.md)
- [20 错误与日志](./20-errors-and-logging.md)
