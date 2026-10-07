# 日志与诊断（脱敏 / 采样 / `__debug`）

三件事：**结构化访问日志**（自带脱敏）、**请求级子日志** `ctx.log`、**默认关闭的诊断路由**。

```ts
import { debugPlugin, httpPlugin, requestLogPlugin } from '@actor/web';

export default defineApp({
  modules: [myModule],
  plugins: [
    httpPlugin({
      port: 3000,
      logger: (event, meta) => myLogger(event, meta),   // → ctx.log 的出口
    }),
    requestLogPlugin({ slowMs: 500, sampleRate: 0.1, format: 'json' }),
    debugPlugin({ enabled: process.env.DEBUG_ROUTES === '1', token: process.env.DEBUG_TOKEN ?? '' }),
  ],
});
```

## 脱敏：默认就挡住，不靠你记得

脱敏是**按 key 名**判定的（大小写不敏感、**子串**匹配），并且会递归进对象/数组：

| 会被打码（`[redacted]`） | 不会 |
|---|---|
| `authorization`、`cookie`、`set-cookie`、`password`、`secret`、`token`、`accessToken`、`x-api-key`、`private-key`、`session` | `content-type`、`user-agent`、`x-chunk-sha256`（是哈希不是密钥）、`path` |

```js verify
import { redactValue, shouldRedact, createRequestLogger, REDACTED } from '@actor/web';

// 名单：命中就挡，没命中就留（反例也要能过）
if (!shouldRedact('Authorization')) throw new Error('authorization 必须被脱敏');
if (!shouldRedact('refresh_token')) throw new Error('refresh_token 必须被脱敏');
if (shouldRedact('content-type')) throw new Error('content-type 不该被脱敏');

const safe = redactValue({
  headers: { authorization: 'Bearer super-secret', accept: 'application/json' },
  body: { password: 'p@ss', nested: { apiKey: 'k' }, keep: 'visible' },
  list: [{ token: 't' }],
});
const text = JSON.stringify(safe);
console.log('脱敏后 →', text);
if (text.includes('super-secret') || text.includes('p@ss') || text.includes('"k"') || text.includes('"t"')) {
  throw new Error('脱敏漏了');
}
if (!text.includes('application/json') || !text.includes('visible')) throw new Error('非敏感值不该被动');

// 请求级子日志：每条都带 requestId，meta 自动脱敏
const lines = [];
const log = createRequestLogger((event, meta) => lines.push(meta), { requestId: 'r-1' });
log.info('用户登录', { userId: 'u1', password: '不该出现' });
log.child({ userId: 'u2' }).warn('权限不足');
console.log('日志 →', JSON.stringify(lines));
if (lines[0].requestId !== 'r-1' || lines[0].password !== REDACTED) throw new Error('子日志/脱敏不对');
if (lines[1].userId !== 'u2') throw new Error('child() 没有合并字段');
```

## 采样：慢请求**永远**记

`sampleRate: 0.1` 只对**快**请求生效；超过 `slowMs` 的请求一定进日志（排障时最需要的恰恰是它）。

## `ctx.log`：业务日志与访问日志能对上

```ts
defineController({ async handle(_input, ctx) {
  const log = ctx.log as { info(m: string, meta?: Record<string, unknown>): void };
  log.info('开始处理订单', { orderId });   // 自动带 requestId；meta 自动脱敏
  return { ok: true };
} });
```

## 诊断路由（默认关闭）

| 路由 | 作用 |
|---|---|
| `GET /__debug/routes` | 路由表（方法/模式/中间件阶段） |
| `GET /__debug/health` | 各**受管资源**的 `stats()`（含状态机与驱动 stats）；`?check=1` 再真的跑 `checkHealth()` |
| `GET /__debug/config` | 只出 key/type，**值一律 `[redacted]`**（如实标注"含 schema 默认值"） |

三层门禁：**默认关闭**（不贡献任何路由）→ 开启必须给 ≥16 字符 token（`x-debug-token` 头或 `?token=`，
常量时间比较）→ `NODE_ENV=production` 下**拒绝启动**，除非显式 `allowInProduction: true`（会留日志）。

受管资源（`resourceAdapter()`/`databaseAdapter()` 装的那些）会自动进注册表，所以 `/__debug/health`
不需要谁去登记；`@actor/redis`、`@actor/mongodb`、上传插件、邮件插件都算。

## 明确不做（v1）

- 分布式追踪（OpenTelemetry）接入；
- 日志轮转/落盘策略（框架只给接缝 `(event, meta) => void`，写哪儿由你决定）；
- 采样策略只做"比例 + 慢请求例外"，不做自适应采样。
