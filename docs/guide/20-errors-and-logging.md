# 20. 错误与日志：让失败看得见

**你会得到**：错误出口（`errors` 钩子）与统一日志（`logging`）一处配好；后台失败不再静默

**前置**：有可跑的项目　**耗时**：15 分钟

框架里出事的地方分三类，**出口只有一个地方配**：`createApp(spec, { errors, logging })`。
这一页讲清楚"什么会失败、怎么接住、日志往哪走"。

> 一句话立场：**库代码不自己决定输出**。不给出口 = 保持默认（内核日志关闭、console 兜底），
> 给了出口 = 全部汇到你的 logger 与错误钩子。

## 一、错误会出现在哪

| 层 | 类型 | 什么时候出现 |
|---|---|---|
| 内核 | `ActorFrameworkError` 及其子类（`DefinitionError` / `MailboxFullError` / `AskTimeoutError` / `ActorStoppedError` / `ActorNotFoundError` / `PersistenceError` / `PersistenceConflictError` / `EscalationError`） | spawn / ask / tell / 持久化 / 监督升级 |
| 应用层 | `AssemblyError`（带 `issues[]`，每条有 `requester`）、`ActorNotResolvableError` | `start()` 装配期；运行期寻址失败 |
| Web 层 | `HttpError`（你自己的业务错误） | 控制器里 throw，映射成对应状态码 |

**错误详情会平铺到错误对象上**（`err.actorId` 这种），便于日志与断言 —— 这是 `ActorFrameworkError` 的约定。

### 「同步路径」与「后台路径」

| 路径 | 例子 | 怎么拿到 |
|---|---|---|
| **同步**（调用方等结果） | `ask()` 超时、`tell()` 撞满邮箱、控制器抛错 | `try/catch` / HTTP 响应码（`AskTimeoutError`→504、找不到 Actor→404、其它→500） |
| **后台**（没人等） | Actor 崩溃/重启、消息进死信、快照写失败、集群事件 | `errors` 钩子（下面是主角） |

> ⚠️ **`tell` 是 fire-and-forget**：它失败了不会告诉你，只能从死信或内核事件里看到。
> 需要"知道失败"就必须用 `ask`。

## 二、接住后台失败：`errors` 钩子

```ts
createApp(spec, {
  errors: {
    // 1) 内核全部日志事件（40+ 个：actor_crash / actor_restart / dead_letter /
    //    dead_letter_persist_failed / system_failure / scheduler_error / snapshot_auto_failed / cluster_* …）
    onKernelLog: ({ event, meta }) => logger.warn(event, meta),

    // 2) 强类型视图：Actor 崩溃（比 1) 窄、好接）
    onActorCrash: ({ name, path, error }) => alert(`${name} 崩了：${error}`),

    // 3) 消息进了死信（这是"消息静默丢了"的唯一证据）
    onDeadLetter: (entry) => logger.error('dead-letter', entry),

    // 4) 顶层 Actor 耗尽重启强度（内核正在停下来并如实上报）
    onSystemFailure: ({ error, path }) => logger.error('system-failure', { path, error }),

    // 5) Web 层 5xx（与 app.on('http:error') 同一份数据，收进同一个口）
    onHttpError: (info) => logger.error('http-5xx', info),
  },
});
```

**Actor 级回执**（只关心某一个 Actor）：

```ts
actors: {
  Payment: {
    definition: PaymentActor,
    options: { persistence: { mode: 'events' } },
    // 只通知，**不干预监督**：重启强度/升级策略仍归内核（要改行为用 options.restart）
    onCrash: ({ name, error }) => audit.write(`${name} crashed: ${error}`),
  },
}
```

**死信可读**（钩子之外，也能主动查）：

```ts
const entries = await app.deadLetters();   // 装了 deadLetters 插件读落盘的那份，否则读内存环
await app.clearDeadLetters();              // 返回清掉的条数（两处一起报，见下）
```

**想让死信活过重启**（进程退出/崩溃后消息还在）就把落盘插件装上 —— 一行：

```ts
import { deadLettersPlugin } from '@actor/app';

defineApp({
  modules: [...],
  plugins: [deadLettersPlugin({ path: './data/dlq.jsonl' })],   // path 不给就用默认队列
});
```

两点实测确认过的行为：

- **形状统一**：内核内部有两套死信形状（内存环 `{ path, payload, error }`、落盘队列 `{ actorId, msg, reason }`），
  `app.deadLetters()` 会**统一成前者**再给你 —— 不用按"装没装插件"分两种写法（`normalizeDeadLetter` 是导出的，需要时可用）；
- **`clearDeadLetters()` 返回真实条数**：装了插件时内存环是空的（落盘队列才是权威），
  框架会先读一遍再清，所以不会出现"清掉了却告诉你 0 条"。

## 三、日志：一处配、三类事件汇到出口

```ts
createApp(spec, {
  logging: {
    logger: pino(),                    // 函数式 (event, meta) => void 或对象式（pino/winston/console）
    level: 'info',                     // 最低级别（默认 debug；默认规则已决定级别）
    filter: ['kernel:*', 'http:*'],    // 只留这些（支持 * 通配）
    exclude: ['kernel:scheduler_error'],// 排除优先
    redactKeywords: ['x-my-secret'],   // 追加脱敏关键词（按 key 子串匹配）
    context: () => ({ service: 'api', env: process.env.APP_ENV }),  // 每条日志都补上
  },
});
```

事件名与级别：

| 事件 | 什么时候 | 默认级别 |
|---|---|---|
| `app:started` / `app:stopped` | 启动完成 / 停机 | info |
| `kernel:*`（40+ 个） | 内核内部（崩溃、重启、死信、快照、集群…） | 失败类 warn，其余 info |
| `http:request` / `http:access` | 访问日志（由 `requestLogPlugin` 转发） | info |
| `http:error` / `http:handler_error` | 5xx（`http:error` 是事件总线的那份） | warn |
| `plugin:http_listening` / `plugin:ws_listening` | 端口就绪 | info |

**没给 `logger` 时**：框架走 console 兜底（与以前行为一致），内核日志保持关闭 —— 不会凭空多出输出。

**访问日志的脱敏**：`requestLogPlugin` 默认对 `authorization` / `cookie` / `password` / `token` / `secret` … 脱敏；
你在 `logging.redactKeywords` 里加的会**一起生效**（`ctx.log` 与访问日志同一份名单）。

### 请求级子日志

```ts
const controller = defineController({
  handle: (_input, ctx) => {
    ctx.log.info('下单开始', { orderId: 'o-1', token: 'secret' });  // 自动带 requestId；token 自动打码
    return { ok: true };
  },
});
```

`ctx.log` 的出口优先级：`httpPlugin({ logger })` > `logging.logger` > console。

## 四、跑一遍（CI 真执行）

下面这段真起应用、真制造崩溃与死信，断言"三类事件都到了出口、且不重复"。

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);

const seen = [];
const errors = [];
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'main',
        actors: {
          // 每次消息都崩：用于制造崩溃 + 死信
          Flaky: {
            definition: {
              preStart() { this.state = { n: 0 }; },
              receive() { this.state.n += 1; throw new Error(`boom ${String(this.state.n)}`); },
            },
            // failure: 'retry' = 重试耗尽后**进死信**（不崩 Actor）；要测崩溃就用 failure: 'crash'
            options: { failure: 'retry', maxRetry: 1, retryBackoffMs: 1 },
          },
          Healthy: {
            definition: { preStart() { this.state = {}; }, receive: (msg) => ({ echo: msg }) },
          },
        },
      }),
    ],
  }),
  {
    configDir: '',
    env: {},
    logging: { logger: (event, meta) => seen.push(`log:${event}${meta?.level === undefined ? '' : `(${String(meta.level)})`}`) },
    errors: {
      onActorCrash: ({ name, error }) => errors.push(`crash:${name}:${error}`),   // 本页没触发崩溃，接上备用
      onDeadLetter: (entry) => errors.push(`dead:${entry.path}:${entry.retryCount}`),
      onSystemFailure: () => errors.push('system-failure'),
      onHttpError: (info) => errors.push(`http:${String(info.status)}`),
    },
  },
);
await app.start();
try {
  assert.ok(seen.includes('log:app:started(info)'), `应用生命周期事件要走统一出口：${seen.join(', ')}`);

  // 重试耗尽 → 死信（不崩 Actor）
  await assert.rejects(() => app.actor('Flaky').ask({}), /boom 2/);
  for (let index = 0; index < 60 && !errors.some((item) => item.startsWith('dead:')); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const deadCount = seen.filter((item) => item.startsWith('log:kernel:dead_letter')).length;
  assert.strictEqual(deadCount, 1, `同一条内核事件只能出现一次（给了 logger 就不该再经事件桥）：${seen.join(', ')}`);
  assert.ok(errors.some((item) => item === 'dead:Flaky:1'), `死信要带重试次数：${errors.join(', ')}`);

  // 死信可读、可清
  const readable = await app.deadLetters();
  assert.strictEqual(readable.length, 1);
  assert.strictEqual(await app.clearDeadLetters(), 1);
  assert.deepStrictEqual(await app.deadLetters(), []);

  // 健康 Actor 不受影响（钩子们没有把东西搞坏）
  assert.deepStrictEqual(await app.actor('Healthy').ask({ hi: 1 }), { echo: { hi: 1 } });
} finally {
  await app.stop();
}
assert.ok(seen.includes('log:app:stopped(info)'), '停机也要留痕');
console.log('ok');
```

## 五、和诊断路由的关系

- `/__debug/health` 给的是**受管资源**的状态（数据库/Redis/邮件…的 `stats()`，`?check=1` 时真探活）；
- 崩溃/死信/错误**不在**诊断路由里，而是走上面的钩子（事件是"流"，诊断是"快照"）。
- 生产上把 `/__debug/*` 关掉（默认就关），把钩子接进你的日志/告警系统。

## 六、相关

- 访问日志的脱敏名单与字段全表 → [internals/15-observability](./internals/15-observability.md)
- span / 指标 / OTLP 导出 → [internals/07-observability](./internals/07-observability.md)
- 出错时的排查步骤 → [19 排错手册](./19-troubleshooting.md)

## 下一步


- [18 可观测与上线](./18-observability-deploy.md)
- [19 排错手册](./19-troubleshooting.md)
