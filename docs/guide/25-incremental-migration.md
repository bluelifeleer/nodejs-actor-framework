# 25. 增量迁移：不改现有服务，先搬一条路径

**你会得到**：一套"并存 → 搬状态 → 收装配 → 收尾"的迁移顺序，以及**同一个进程里既有服务与新接口并存**
的可跑最小形态（含共享同一个持久化目录）。

**前置**：有一个正在跑的 Express/Koa/Fastify/NestJS 服务；跑得起来一个示例项目。　**耗时**：12 分钟。

> 别做的两件事：**不要**一次性重写整个路由树；**不要**为了用 Actor 先重写数据层。
> 迁移的最小单元是"**一条有状态的路径**"，不是"一个服务"。

## 1. 迁移顺序（每步可单独上线、单独回滚）

| 步骤 | 做什么 | 验收 |
|---|---|---|
| **0** | 先把可观测性对齐：健康检查、日志出口、优雅停机（[18](./18-observability-deploy.md)、[20](./20-errors-and-logging.md)） | 出问题时你还能看到它在哪一步 |
| **1 并存** | 新接口用本文档写，老接口不动；同一进程不同端口，或挂在现有网关后面 | 老接口回归测试全过；新接口有测试 |
| **2 搬状态** | 找出模块级可变变量（计数、房间、连接映射、限流器），逐个搬进 Actor | 搬一个删掉一处竞态/锁；[00 §11](./00-what-is-an-actor.md#11-五分钟改造演练把共享计数器搬进-actor) 有完整推演 |
| **3 搬装配** | `app.set`/`process.env` → `defineConfig`；`app.use` → `atPre/atAuth/atPost`；5xx 兜底 → `errors`/`logging` | `actor doctor` 全绿；配置有 schema |
| **4 收尾** | 决定部署路线（直跑 `.ts` 或编译产物，见 [22](./22-deploy-and-build.md)）；旧服务下线 | 上线检查清单（[18 §4](./18-observability-deploy.md)） |

## 2. 三个真实的坑（迁移时最容易踩）

1. **状态别放在两个地方**。搬到一半时最常见的错误是：Actor 里有 `this.state.count`，
   同时还有一个模块级 `count` 在别处被读 —— 两边会分叉。搬的时候**尽量一次搬完一处状态的读写**，
   或者让旧代码也改成向 Actor 发消息（本页的示例就是后者）。
2. **`await` 会占住邮箱**。Actor handler 里 `await` 慢 IO 时，该 Actor 的后续消息全部排队。
   迁移时如果发现某个 Actor 变慢，先把慢 IO 移到服务层，Actor 只做决策（[00 §9](./00-what-is-an-actor.md)）。
3. **持久化目录必须与数据目录同源**。快照/事件写在 `kernel.persistence.dir`；如果它与 `APP_DATA_DIR`
   指向不同位置，重启后你会看到"数据在库里、状态却丢了"。脚手架里两者同源，迁移时照抄。

## 3. 共享一个持久化目录（跨"老代码 → Actor"的交接点）

如果你希望老代码读到的计数与新 Actor 的状态一致，最省事的做法是：
**让老代码也通过 Actor 读**（下面示例里 `legacy` 服务的 `/legacy/count` 就是这么做的）。
反过来"老代码直接读快照文件"是不行的 —— 快照是内部格式，不是 API。

## 4. 跑一遍（CI 真执行）

一个真进程里：既有 `node:http` 服务（模拟未迁移的老服务）与新 app 并存；
老服务的一条路径**委托给 Actor**，验证"老入口 + 新状态"能对上；并验证重启后状态仍在。

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const repo = `file://${process.cwd()}/`;
const appLayer = await import(`${repo}packages/app/src/index.ts`);
const webLayer = await import(`${repo}packages/web/src/index.ts`);
const { createApp, defineApp, defineModule } = appLayer;
const { defineController, defineRoutes, get, httpPlugin, post } = webLayer;

// 持久化目录必须与"数据目录"同源（这里是同一次启动内共用同一个临时目录）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-incremental-'));

const Counter = {
  preStart() { this.state = { n: 0 }; },
  receive(msg) {
    if (msg.type === 'add') this.state.n += msg.by;
    return this.state.n;
  },
};

async function boot() {
  const http2 = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'app',
          actors: { Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } } },
          routes: defineRoutes([
            post('/counters/main/add', defineController({
              body: ['by'],
              input: { by: { type: 'number', min: 1 } },
              handle: (input, ctx) => ctx.actor('Counter').ask({ type: 'add', by: Number(input.by) }),
            })),
          ]),
        }),
      ],
      plugins: [http2],
    }),
    { configDir: '', env: {}, kernel: { logger: false, persistence: { dir: dataDir } } },
  );
  await app.start();

  // 老服务：它自己的路由照旧，但"读计数"这条路径**委托给 Actor**（避免两处状态分叉）
  const legacy = http.createServer((req, res) => {
    void (async () => {
      if ((req.url ?? '') === '/legacy/count') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ from: 'legacy', n: await app.actor('Counter').ask({ type: 'read' }) }));
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise((resolve) => legacy.listen(0, '127.0.0.1', () => resolve()));
  return { app, legacy, base: `http://127.0.0.1:${String(http2.address()?.port)}`, legacyBase: `http://127.0.0.1:${String(legacy.address().port)}` };
}

const first = await boot();
try {
  // 老入口与新接口同时可用
  const added = await fetch(`${first.base}/counters/main/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 7 }),
  });
  assert.strictEqual(added.status, 200);
  assert.strictEqual(await added.json(), 7);

  // 老服务读到的是**同一份状态**（委托给 Actor，而不是自己维护一个变量）
  assert.deepStrictEqual(await (await fetch(`${first.legacyBase}/legacy/count`)).json(), { from: 'legacy', n: 7 });
} finally {
  await first.app.stop();
  await new Promise((resolve) => first.legacy.close(() => resolve()));
}

// 重启（新实例、同一个持久化目录）：状态还在 —— 迁移不必一次做完，但持久化要一开始就选对
const second = await boot();
try {
  assert.deepStrictEqual(
    await (await fetch(`${second.legacyBase}/legacy/count`)).json(),
    { from: 'legacy', n: 7 },
    '重启后老入口读到的仍是同一份状态',
  );
  console.log('incremental-ok');
} finally {
  await second.app.stop();
  await new Promise((resolve) => second.legacy.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
```

## 下一步
- 从 Express 过来的逐条映射：[23 从 Express 过来](./23-from-express.md)
- 从 NestJS 过来（装饰器/DI/Guard 的对应物）：[24 从 NestJS 过来](./24-from-nestjs.md)
- 旧版本升级（v0.x → 1.0 被删能力的替代做法）：[迁移指南（旧版）](../migration.md)
