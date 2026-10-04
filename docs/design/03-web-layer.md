# Web 层：路由、控制器、校验与鉴权（设计草案）

> 对应开放问题 Q3/Q4/Q6。核心立场：**Web 层是协议翻译层，不承载 Actor 语义**。
> 业务状态住在 Actor 里，HTTP 只负责"把请求变成消息、把回复变成响应"。

## 1. 请求生命周期

```
HTTP/WS 请求
  │
  ├─ 0. 连接级：TLS 终结、IP 限流、请求体大小上限、超时预算（deadline）
  ├─ 1. 路由匹配：method + path → { controller, action, params }
  │     未命中 → 404 / 405（带 Allow 头）
  ├─ 2. 全局中间件（注册序）：requestId → trace span → 结构化日志 → 指标 → CORS → body 解析
  ├─ 3. 路由中间件：认证（谁）→ 请求校验（参数合法）→ 授权（能不能做）
  ├─ 4. 控制器动作（普通 async 函数，拿到请求作用域 ctx）
  │     └─ ctx.actor('room-4')  ← 桥：ActorRef（本地/远端同构）
  │           ├─ ask  需要回值（受 askTimeout 约束）
  │           └─ tell 不需要回值（长任务、事件）
  ├─ 5. 响应整形：返回值 → 200 JSON；ctx.json/text/redirect/sse 显式控制
  └─ 6. 错误映射：内核错误 → 状态码 + 结构化错误体 + Retry-After + traceId
```

**三个可扩展点**：全局中间件（插件可注册）、路由中间件（业务/框架）、错误映射器（可替换）。

## 2. 路由

### 2.1 风格选择

| 风格 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **显式 builder**：`router.get('/users/:id', UserController, 'get')` | 无构建步骤、纯 CJS 可用、路由表可静态导出（生成文档/测试） | 略啰嗦 | ✅ 默认 |
| 文件路由（路径即文件） | 零样板 | 隐式、重构易错、难以表达中间件差异 | 可选（M5） |
| TS 装饰器 `@Get('/users/:id')` | 最简洁 | 需要 TS + 装饰器元数据（reflect-metadata），破坏"无构建" | 作为可选 TS 插件（与 Q1 绑定） |

### 2.2 API 草案

```js
const { Router } = require('@actor/web');

const router = new Router({ prefix: '/api/v1' });

// 分组 + 组级中间件
const admin = router.group('/admin', { middleware: [requireRole('admin')] });
admin.get('/stats', StatsController, 'overview');

router
  .get('/users/:id', UserController, 'get', { auth: 'optional' })
  .post('/users', UserController, 'create', { auth: 'required', body: CreateUserSchema })
  .post('/rooms/:id/join', RoomController, 'join', { auth: 'required', actor: 'room-{id}' });

router.exportTable();   // 供文档/测试/契约检查：返回 [{method,path,controller,action,meta}]
```

**要点**：
- 路径参数 `:id`、通配 `*rest`、可选段；**不**引入正则路由（用中间件做特殊匹配）。
- 路由冲突在**注册时**报错（同一 method+path 重复注册），不等到运行期。
- 路由表可导出 → 生成 OpenAPI / 做契约测试 / 文档自动更新。
- 405 必须带 `Allow` 头；HEAD 自动由 GET 派生。

## 3. 控制器

### 3.1 形态

```js
class UserController {
  constructor({ users, clock }) { this.users = users; this.clock = clock; }  // 容器注入（单例服务）

  async get(ctx) {
    const ref = ctx.actor(`user-${ctx.params.id}`);
    if (!ref) throw new NotFoundError('user not found');
    const profile = await ref.ask({ type: 'profile' }, { timeoutMs: 500 });
    return { ...profile, servedAt: this.clock.now() };      // return 值 → 200 JSON
  }

  async create(ctx) {
    const user = await this.users.insert(ctx.body);          // 仓储（doc 04）
    const ref = await ctx.spawn(`user-${user.id}`, UserActor, { id: `user-${user.id}` });
    await ref.tell({ type: 'hydrate', profile: user });      // 不必等
    return ctx.status(201).json(user);
  }
}
```

**为什么控制器默认无状态**：HTTP 并发高、生命周期短；把每个请求变成 Actor 会让串行化成为瓶颈（见 `00-overview.md` §4 反模式）。**只有需要串行化/长生命周期的操作**才落到 Actor，且通常由"实体 Actor"（user-1、room-4）承载，而不是"请求 Actor"。

**需要 Actor 支撑的场景**（显式 opt-in）：
- 同一实体的并发写（订单、库存）：`ctx.actor('order-42')` 天然串行。
- 长任务：控制器 `tell` 给任务 Actor，立即返回 `202 + jobId`，进度走 SSE/轮询/webhook。
- 有状态会话：会话 Actor（见 `examples/access-node.js` 的 Session）。

### 3.2 请求作用域 ctx 提供什么

| 成员 | 说明 |
|---|---|
| `ctx.params/query/body/headers` | 已解析并（可选）校验过的输入 |
| `ctx.method/path/requestId/traceId` | 请求元信息（requestId 进日志与错误体，便于对账） |
| `ctx.actor(nameOrPath)` | **Actor 访问桥**，返回 `ActorRef` 或 `null` |
| `ctx.spawn(id, definition, options)` | 按需创建实体 Actor（幂等：已存在则返回现有 ref） |
| `ctx.get(serviceName)` | 从容器取作用域内服务（事务、当前用户） |
| `ctx.json/text/html/redirect/status/sse` | 响应控制 |
| `ctx.log` | 带 requestId/traceId 的结构化日志 |
| `ctx.signal` | 客户端断开信号（用于取消下游工作） |
| `ctx.user` | 已认证主体（由认证中间件填充） |

### 3.3 取消与超时

- 每个请求有**总预算**（默认 30s，可配）：超过则响应 504，并（可选）取消下发的 ask。
- `ctx.signal` 在客户端断开时触发 → 控制器应尽早停止无意义工作（`tell` 出去的活无法真正取消，文档要说明——Actor 消息没有取消语义，需要业务用"取消消息"实现）。
- `ask` 超时必须**显式传入**（默认值从配置读），避免默认超时与业务预期不符。

## 4. 校验

```js
const CreateUserSchema = {
  body: { name: { type: 'string', min: 1, max: 64 }, email: { type: 'string', format: 'email' } },
  query: { invite: { type: 'string', optional: true } },
};
router.post('/users', UserController, 'create', { schema: CreateUserSchema });
```

- **位置**：`body` / `query` / `params` / `headers` 四类，分别校验。
- **失败响应**：422 + 字段级错误数组（`[{ path: 'body.email', code: 'format', message }]`），不要只给一句 "invalid input"。
- **响应校验**：开发/测试环境可开启（防止多返回敏感字段），生产关闭（性能）。
- **适配器**：`validator: builtin | zod | ajv`；内置极简校验覆盖 string/number/boolean/array/object/enum/format/optional，够零依赖用（见 Q6）。
- **与消息校验的关系**：HTTP 层校验"协议输入"，Actor 定义校验"消息契约"（doc 01 §3.5）。两者都要，因为 Actor 也可能被集群/内部消息调用，不能只信 HTTP 入口。
- 校验失败**不触发** Actor crash（在进入 Actor 之前就拦掉；直接进去的非法消息走死信）。

## 5. 鉴权

### 5.1 认证（Authentication：你是谁）

| 身份来源 | 场景 | 现状 |
|---|---|---|
| HMAC token（`?token=` / `bearer.<t>` / `Authorization`） | 客户端/服务间 | ✅ 已有 `src/ops/token.js` |
| Cookie + 服务端会话 | 浏览器 | 新增（会话 Actor 承载） |
| mTLS 客户端证书 | 服务间/内部 | 部分（内核有 TLS 工具，需要接到 Web 层） |
| 签名（HMAC 请求签名） | 开放 API | 新增（远期） |

认证结果统一写入 `ctx.user = { id, roles, claims }`，**不散落在各处**。

### 5.2 授权（Authorization：你能不能做这个）

**两层，都要**：

```js
// ① 路由级：粗粒度
router.post('/admin/users', AdminController, 'create', { auth: 'required', roles: ['admin'] });
// 策略式（更细）：能拿到完整请求上下文
router.post('/orders/:id/cancel', OrderController, 'cancel', {
  policy: (ctx) => ctx.user.id === ctx.params.ownerId || ctx.user.roles.includes('support'),
});

// ② 消息级 guard：谁能给这个 Actor 发这种消息（Actor 模型特有的那一半）
system.spawn(OrderActor, {
  id: 'order-42',
  guards: [
    guard('cancel', (msg, ctx) => ctx.sender?.claims?.role === 'support' || ctx.sender?.path === 'session-7'),
    guard('*', 'deny-by-default'),        // 未列出的消息默认拒绝
  ],
});
```

**为什么消息级必须有**：Actor 不只被 HTTP 调用——集群里的其他节点、其他 Actor、插件都能给它发消息。只在 HTTP 层鉴权，等于把后门留在 Actor 边界上。

**审计**：被拒绝的调用记 `authz_denied`（含 sender、target、message type、decision reason），可对接告警（doc 05）。

## 6. 错误映射

内核错误 → HTTP 语义（**必须显式定义，不能一律 500**）：

| 内核/应用错误 | HTTP | 响应要点 |
|---|---|---|
| 校验失败（请求/消息 schema） | 422 | 字段级错误数组；`code: 'validation_failed'` |
| 未认证 / token 失效 | 401 | `WWW-Authenticate`；不泄露"用户是否存在" |
| 已认证但无权限 | 403 | 记录审计；不泄露资源细节 |
| `ActorNotFoundError`（实体不存在） | 404 | 与"路由不存在"区分 `code` |
| `MailboxFullError`（背压） | 503 | **必须带 `Retry-After`** |
| `AskTimeoutError`（下游太慢） | 504 | 带 traceId，便于追 |
| 死信（消息最终未处理） | 500 | `code: 'dead_letter'` + traceId；同时触发告警 |
| 主动限流（rateLimit 触发） | 429 | `Retry-After` + 限额信息 |
| 未捕获异常 | 500 | 生产不返回堆栈，只回 traceId；日志里带全栈 |

## 7. 实时通道（WS/SSE）与会话 Actor

- 一条连接 = 一个**会话 Actor**（已有可运行参考实现：`examples/access-node.js`），负责：入口限流、有界邮箱、断线清理、把服务器推送写回 socket。
- **推送来源**：房间/业务 Actor 把 `ctx.sender`（可回信的 ref）存下来后直接 `tell`（内核已支持跨节点回信，见 README 的②节）。
- **慢客户端**：会话 Actor 邮箱有界；溢出策略显式选择（默认丢最新 + 计数告警），绝不能无限缓冲。
- **SSE**：用同一套会话 Actor，写 `text/event-stream`。
- **反压**：连接数上限、单连接消息速率（已有 rateLimit）、单连接未确认推送上限。

## 8. 反模式（写进文档，配反例代码）

| 反模式 | 后果 | 正确做法 |
|---|---|---|
| 所有请求 `ask` 同一个 Actor | 吞吐塌陷 | 实体 Actor 分片（user-x、room-y） |
| 每个请求 spawn 一个 Actor | Actor 数量爆炸、监督树噪音 | 请求状态放 `ctx`（作用域） |
| 在控制器里直接改共享 Map/全局变量 | 竞态、无法水平扩展 | 状态进 Actor，读走投影 |
| 长任务同步等待 | 连接耗尽、超时 | `tell` + 任务 Actor + 202/SSE |
| 只在 HTTP 层鉴权 | 集群/内部消息绕过鉴权 | 路由策略 + 消息 guard 双层 |
| Actor 里直接读可变全局配置 | 隐性共享状态 | `ctx.config` 快照 + 订阅变更消息 |
| 用 Actor 做列表查询 | 无法分页/排序/聚合，且成单点 | 投影/读模型（doc 04） |

## 9. 部署形态（同一套代码）

```
形态 A（开发默认）：一个进程 = Web + Actor
形态 B（生产推荐）：接入层进程（HTTP/WS，无状态可扩） + Actor 节点（有状态，cluster 互联）
```
控制器代码**完全相同**，因为 `ctx.actor(name)` 在两种形态下都返回可用的 ref。

## 10. 本节待决策

| # | 问题 | 建议 |
|---|---|---|
| C1 | 是否自研 HTTP 服务器（零依赖）还是基于 Node `http` + 极简路由 | 用 Node `http` + 自研路由（保持零依赖，WS 已有先例） |
| C2 | 控制器基类还是纯函数 | 两者都支持：`class extends Controller`（可注入）或 `(ctx) => ...`（简单路由） |
| C3 | 一致性：默认最终一致还是强一致读 | 默认最终一致（Actor + 投影），提供"读己之写"的会话级方案 |
| C4 | 是否内置 OpenAPI 生成 | 提供（路由表已可导出），但作为可选包 |
| C5 | 是否内置会话（cookie session）存储 | 提供 Actor 承载的会话实现；存储后端可插拔 |
