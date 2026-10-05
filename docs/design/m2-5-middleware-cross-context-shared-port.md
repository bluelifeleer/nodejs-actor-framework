# M2.5 设计：中间件 · HTTP↔WS 跨上下文 · 共享端口

> 由三个实际问题驱动（均已用代码核实现状）：
> 1. 没有中间件机制（全局/路由级都要）；
> 2. HTTP 与 WS 目前**互相看不到**（HTTP 拿不到 socket 上下文）；
> 3. 希望"端口配置相同或未配置就共享、不同就各监听各的"。

## 1. 中间件（全局 / 模块 / 路由级）

**现状（核实）**：`packages/web`、`packages/app` 中 `middleware` 出现 **0 次**——完全没有机制。

**形态：Koa 风格 `(ctx, next)`**（不用 Express 式 `next()` 回调，也不耦合 `req/res`）：

```ts
export const auth = defineMiddleware(async (ctx, next) => {
  const token = ctx.headers('authorization');
  if (!token) throw new HttpError(401, 'unauthorized');
  ctx.state.user = await verify(token);      // 每请求可变袋
  return next();                             // 继续；不调用则短路
});

// 三级注册，顺序 = 全局 → 模块 → 路由，after-logic 逆序展开
defineApp({ modules: [...], middleware: [requestId, accessLog] });
defineModule({ name: 'game', middleware: [rateLimit], routes: [...] });
get('/me', [auth], meController);            // 路由级
defineController({ middleware: [auth], handle });   // 或写在控制器上
```

**执行顺序（框架固定，可测）**：

```
组装 ctx（访问器/requestId/actor/get/config/log）
  → 中间件链（全局 → 模块 → 路由；`await next()` 之后为 after-logic，逆序展开）
  → 输入校验（validateValues，在 handle 之前）
  → 控制器 handle → 返回值按 §2.2 推断形态
  → 异常 → 错误映射表
```

**为什么校验放在中间件之后**：鉴权/限流应当**先**拒绝（比解析并校验 body 便宜），
所以中间件先跑、校验紧贴 handle。中间件里如需校验，可直接用 `validateValues`。

**短路**：`return next()` 表示继续；返回响应对象（`reply.json(...)`）或抛 `HttpError` 表示结束。

**WebSocket 同样适用**：每条消息走同一条链（语义与 HTTP 一致）。

**顺带解决一个遗留取舍**：`requestId`、访问日志、限流、鉴权都能用中间件表达，
因此"app 级事件总线 + requestLogPlugin"**不再是必需品**（事件总线可留给 M4 的运维需求）。

## 2. HTTP ↔ WS 跨上下文（连接注册表）

**现状（核实）**：两个插件各自独立——`http.ts` 里没有任何连接/注册表引用；
`ws.ts` 把连接放在**私有 Set** 里，不对外暴露。**所以今天 HTTP 拿不到 socket 上下文。**

**设计**：`wsPlugin` 把"连接注册表"注册为应用层服务，控制器用 `ctx.get('wsConnections')` 取用：

```ts
// 应用层新增（插件在 onReady 注册服务）
app.provide('wsConnections', registry);        // 重复注册报错

// 注册表 API（@actor/web 内定义，插件与用户共用同一类型）
interface WsConnections {
  byId(id: string): WsConnection | null;
  byPlayer(playerId: string): WsConnection[];   // 一个玩家可能多端在线
  sendTo(id: string, payload: unknown): boolean;
  broadcast(payload: unknown, filter?: (c: WsConnection) => boolean): number;
  ids(): string[];
}
interface WsConnection { id: string; playerId?: string; path: string; readyState: string;
                         send(payload: unknown): boolean; close(code?: number, reason?: string): void }
```

`id` 来源：优先接入层 `verifyClient` 设置的 `socket.playerId`（内核已支持），否则连接自增 id。

**游戏/实时大屏场景**：HTTP 请求触发推送 ——
`POST /broadcast` → `ctx.get('wsConnections').broadcast({ type: 'score', ... })`；
或按玩家推送 → `sendTo(conn.id, ...)`。这就是"在 HTTP 里拿到 socket 上下文"的可用形态。

**边界（必须写在文档里，避免误用）**：注册表是**本节点**的。跨节点推送有两条正路：
① 通过 Actor（位置透明，`ctx.actor('player_001')` 已在 M2 实现）；② 走 pubsub 插件。
HTTP 直连"别的节点上的 socket"不是设计目标。

## 3. HTTP 与 WS 共享端口（配置驱动）

**现状（核实）**：内核 `WebSocketServer` **总是自建** http/https server（`ws-server.ts:327`），
无法附加到既有 server —— 所以共享端口需要内核一个**纯增量**改动。

**规则（按你的要求）**：

| `plugins.ws.port` | 行为 |
|---|---|
| **未配置**，且 HTTP 已启用 | **共享** HTTP 端口（WS 附加到同一个 server，按 upgrade 分发） |
| **配置为数字且与 `plugins.http.port` 相同** | 共享 |
| **配置为数字且不同** | 各监听各的端口（现状行为） |

**实现前提（三个，都列清楚）**：

1. **内核增量**：`WebSocketServer` 支持 `options.server`（附加到既有 http/https server）；
   不传时保持现在的自建行为（纯增量、不破坏既有用法）；
2. **应用层增量**：`Application.provide(name, value)`——插件需要能注册服务（当前 provider 只能由
   模块声明）；重复注册报错；
3. **配置语义增量**：`ws.port` 的 schema 默认值要去掉（改为可选），否则"未配置"与"默认 9001"
   无法区分，规则表就没法实现。

共享端口下的行为：HTTP 普通请求不受影响；WS 按路由表匹配 upgrade 路径（非 WS 路径的 upgrade
→ 400/404）；TLS 沿用 HTTP server 的配置；`start()` 返回即端口就绪（一个 server、两种协议）。
**默认值变更**：未配置 `ws.port` 时，从"独立 9001"变为"与 HTTP 共享"——这会改变现有行为，
故需要在实现时同步更新示例与文档（列为本设计的待确认项）。

## 4. 验收标准

1. 中间件：三级注册的顺序（全局→模块→路由）、after-logic 逆序、短路（返回响应/抛 HttpError）、
   `ctx.state` 在中间件与控制器之间可见；WS 每条消息同样走链；
2. 跨上下文：HTTP 请求经注册表把消息推给指定/全部 WS 连接（真实子进程 + 真实连接验证）；
   跨节点推送不在本项验收内（走 Actor/pubsub，属 M4）；
3. 共享端口：未配置 `ws.port` 时，HTTP 与 WS 在**同一端口**同时可用（同一 server、两种协议）；
   配置不同端口时行为与现在一致（回归）；
4. 不回归：现有 334 例全绿；`npm run typecheck` 0 错误。

## 5. 待你确认

| # | 决策 | 我的建议 |
|---|---|---|
| M1 | 中间件形态 | **Koa 风格 `(ctx, next)`**（支持 after-logic，且不耦合 req/res） |
| M2 | 校验相对中间件的位置 | 中间件**先**跑、校验紧贴 handle（鉴权/限流可先拒绝） |
| M3 | 插件注册服务的入口 | 新增 `Application.provide(name, value)`，重复注册报错 |
| M4 | 未配置 `ws.port` 的默认行为 | **与 HTTP 共享**（按你的要求），并同步更新示例/文档（会改变现有默认） |
| M5 | 注册表命名 | `wsConnections`（`ctx.get('wsConnections')`） |
