> **状态（M2 基本完成）**：已实现路由表与匹配（路径/查询参数、启动期检查、方法归一化、
> HEAD→GET 回退、OPTIONS→204+Allow、WS 路由复用同一套语法）、控制器上下文（访问器双形态 +
> 返回形态 + 错误映射 + `requestId`）、`defineController` 与输入校验（复用应用层
> `validateValues`）、插件生命周期钩子（`onReady`/`onStopping`）、`httpPlugin`（node:http
> 零依赖、在途请求优雅停止、访问日志）、`wsPlugin`（复用内核零依赖 ws-server、每条消息一次
> handle）、**位置透明**（`ctx.actor(name)`：本地 → 内核按名解析 → 明确报错）。
> 端到端示例：`examples/app-web/`（含 WS 与 HTTP）。
>
> **已验证范围（如实）**：HTTP 200/201/400/404/405/504/HEAD/OPTIONS + 优雅停止；
> WS 连接/消息/校验/404/优雅停止；位置透明的回退路径用**真实内核**验证（内核直接 spawn 的
> Actor 不在应用层句柄表里，仍能被解析）。
>
> **未验证/未完成（不要当成已完成）**：
> 1. **两节点集群端到端**（控制器在 B 节点、Actor 在 A 节点、经 gossip 发现后触达）——
>    属 M4 集群里程碑的验收项；本层只保证"回退到内核解析"这条链路接通并有单测；
> 2. **app 级事件总线 + 真正的 `requestLogPlugin`**——当前访问日志由 `httpPlugin` 自己记录
>    （插件生命周期没有"每请求"事件）；总线属 M4 运维范畴；
> 3. HTTP 与 WS 共享同一端口（可选优化，当前各监听自己的端口，均可配置）。

# M2 设计：路由 + 控制器（Web 层）

> 前提（沿用 M1 结论）：用户项目只依赖 `@actor/app` + `@actor/web`，**不接触内核**；
> 无状态控制器为默认，`ctx.actor(name)` 是控制器访问 Actor 的**唯一桥梁**。
> 依赖方向：`@actor/web` → `@actor/app` → 内核（严格向下，web 层不 re-export 内核类型）。

## 1. 用户可见 API

```ts
// src/controllers/join.ts —— 无状态控制器（默认形态，无继承、无装饰器）
import { defineController } from '@actor/web';

export const JoinController = defineController({
  deps: ['leaderboard'],                       // 与 provider 同一套按名解析
  input: {                                     // 输入校验：复用 M1 的字段描述符
    playerId: { type: 'string', min: 1 },
    room: { type: 'string', default: 'lobby' },
  },
  async handle(input, ctx) {
    const room = await ctx.actor('Room');      // ← 唯一桥梁：本地或远程由内核决定
    const score = await ctx.get('leaderboard').top(input.playerId);
    return { playerId: input.playerId, score };   // 直接返回对象 → JSON 200
  },
});

// src/routes.ts
import { defineRoutes, get, post } from '@actor/web';
export default defineRoutes([
  post('/join', JoinController),
  get('/rooms/:id', RoomController),
]);

// src/module.ts（与 actors/providers 对称：路由也是模块声明的一部分）
export default defineModule({ name: 'game', actors: {...}, providers: {...}, routes: gameRoutes });

// main.ts
const application = createApp(defineApp({ config, modules: [gameModule], plugins: [httpPlugin({ port: 9000 })] }));
await application.start();     // 启动顺序见 §3；`start()` 返回后端口已就绪
```

函数简写（不需要 deps/输入校验时）：

```ts
export default defineRoutes([ get('/health', () => ({ ok: true })) ]);
```

## 2. 关键设计

| 项 | 设计 |
|---|---|
| 控制器形态 | `defineController({ deps?, input?, handle })` 为主；也接受普通函数 `(input, ctx) => result`。**无继承、无装饰器**（装饰器实测不可用） |
| `ctx` 内容 | `actor(name) → ActorHandle`、`get(providerName)`、`config`、`log`、`req`（方法/路径/头/`requestId`）。**只出现应用层概念** |
| 返回值 | 返回对象/数组 → JSON 200；返回 `{ status?, headers?, body }` → 自定义；返回 `undefined` → 204 |
| 错误 | 抛 `HttpError(status, message, details?)` 精确控制；未捕获异常 → 500 且响应不含堆栈（日志含 `requestId`） |
| 输入来源 | 路径参数 + query + JSON body 合并，再按 `input` schema 校验；**复用 M1 的字段描述符与校验器**（一套校验、一种错误格式、一次性报全部问题） |
| 路由匹配 | `METHOD /path/:param` 注册表；启动时检测重复（同 method+path）并报错；未知路径 404 |
| 服务器 | `node:http`（零依赖）；`httpPlugin({ port, host })` 作为应用层插件显式启用 |
| WebSocket | 紧随 HTTP 之后（内核已有零依赖 ws-server + 接入层示例），`ws('/path', Controller)`，语义与 HTTP 控制器一致（`ctx.actor` 桥梁不变） |

## 2.1 路由模式语法（路径参数 + 查询参数都支持）

```
pattern := path [ '?' query_decl ]
path    := ( '/' segment )*          segment := literal | ':' name
query_decl := name [ '=' ] { '&' name [ '=' ] }
```

| 写法 | 含义 | 取值来源 |
|---|---|---|
| `get('/rooms/:id', C)` | 路径参数 `id` | URL 路径（`/rooms/42` → `id='42'`，自动 URL 解码） |
| `get('/rooms?id=', C)` | **查询参数** `id` | 查询串（`/rooms?id=42` → `id='42'`） |
| `get('/rooms?limit=&cursor=', C)` | 多个查询参数 | 查询串 |
| `get('/rooms/:id/players?limit=', C)` | 两者混用 | 路径给 `id`，查询给 `limit` |

**三条规则**（都会在 `start()` 时检查，不是运行时才发现）：

1. `?` 后面的声明**只表示"这个路由会读取这些查询参数"**，不参与路径匹配——
   `/rooms?id=` 也能匹配 `/rooms?other=1`（未声明的查询参数仍可在 `ctx.req.query` 里读到）；
2. **重复路由**按"method + 路径模式"判定：`get('/rooms?id=')` 与 `get('/rooms?room=')`
   视为冲突（路径相同、匹配无法区分），启动报错并提示"若要区分请求，请把参数放进路径"；
3. **`input` schema 的键必须来自路径参数或已声明的查询参数**，否则启动报错
   （与配置系统的"未知配置项"同一思路：拼写错误在启动时暴露，而不是在线上静默变成 undefined）。

`input` schema 复用 M1 的字段描述符与校验规则；是否必填由 schema 决定
（有 `default` 即可选，没有则必填）——与配置系统语义一致。

## 2.2 请求访问器与返回形态（控制器 ctx）

**请求访问器：两种写法等价，都支持**（用户要求）：

```ts
qs('page')            // 取单个查询参数
qs().get('page')      // 同一语义的链式写法
qs().all()            // 全部查询参数
qs().has('page')
headers('authorization')       // 请求头（大小写不敏感；重复头返回数组）
headers().get('authorization')
headers().all()
params('id') / params().get('id')     // 路径参数
body                                   // 已解析的请求体（JSON 自动解析；否则原始文本）
method / path / requestId              // 请求元信息
```

实现方式：访问器本身是**可调用对象**（函数 + `.get/.all/.has` 方法），因此两种写法指向同一份数据，
不存在"两套 API 行为不一致"的风险。

**返回形态：默认 JSON，可显式指定状态码与内容类型**（用户要求）：

| 写法 | 状态码 | Content-Type | 实际返回 |
|---|---|---|---|
| `return { ok: true }` | 200 | `application/json; charset=utf-8` | JSON 序列化 |
| `return reply.json(data, { status: 201 })` | 201 | `application/json` | JSON |
| `return reply.text('hello')` | 200 | `text/plain; charset=utf-8` | UTF-8 文本 |
| `return reply.html('<h1>hi</h1>')` | 200 | `text/html; charset=utf-8` | HTML |
| `return reply.buffer(bytes)` | 200 | `application/octet-stream` | 原始字节 |
| `return reply.protobuf(bytes)` | 200 | `application/x-protobuf` | 原始字节（Protobuf 编码） |
| `return reply.send(body, { status, contentType, headers })` | 自定义 | 自定义（含自定义响应头） | 由 contentType 决定 |
| `return undefined` | 204 | — | 空 |
| `throw new HttpError(404, 'not found')` | 404 | `application/json` | `{ error: { status, message, details? } }` |

约定：**返回值决定形态，显式优先于隐式**；`contentType` 一律可被 `reply.send` 覆盖，
框架不猜测业务意图，只在完全没有指定时按"对象 → JSON"处理。

## 3. 与装配的衔接（生命周期）

```
start: 收集模块/插件(含 routes) → 合并 schema 并加载校验 → 插件 setup
       → provider 解析 → **控制器依赖解析 + 路由注册（重复检测在此报错）**
       → 建内核 + spawn Actor → 模块 onStart → **httpPlugin listen（端口就绪）** → keepAlive
stop : 停止接收新请求 → 等在途请求（有界 timeoutMs）→ 模块 onStop(逆序)
       → 内核停止 → 插件 teardown(逆序) → provider dispose(逆序) → 释放
```

控制器依赖同样走 provider 解析器 ⇒ **未知依赖与循环依赖在 `start()` 立即报错**（与 M1 一致）。

## 4. 错误映射（可测的明确表）

| 抛出/情况 | 响应 |
|---|---|
| `HttpError(status, ...)` | 该 status |
| 输入校验失败 | **400** + 全部问题（与配置校验同一格式：`{ issues: [{ path, message }] }`） |
| Actor 不存在 | **404** |
| ask 超时（内核 `AskTimeoutError`，按 `name` 判定，不暴露内核类型） | **504** |
| 其它未捕获异常 | **500**（响应通用信息 + `requestId`，堆栈只进日志） |
| 路由不存在 | **404**；方法不匹配 **405**（带 `Allow` 头） |

## 5. 可观测性

- 每个请求生成 `requestId`，贯穿日志与错误响应；
- 访问日志（method/path/status/耗时）由 `requestLogPlugin()` 提供（应用层插件，可换实现）；
- 指标（QPS、延迟、状态码分布）复用内置 `metricsPlugin()`——两者都是应用层插件，可独立启用。

## 6. 验收标准（M2 出口）

1. `examples/app-web/`：用 `@actor/app` + `@actor/web` 起 HTTP 服务，含 `config/`、`src/controllers/`、`routes.ts`、`main.ts`；
2. 端到端测试（真实子进程）：正常请求 200、校验失败 400（含全部 issues）、未知 Actor 404、ask 超时 504、方法不匹配 405、优雅停止（在途请求完成后才退出）；
3. 守卫测试扩展：`examples/app-*` 一律不得直接依赖内核；
4. 路由重复注册、控制器未知依赖 → `start()` 报错（有测试）；
5. 不回归：现有 305 用例保持全绿；`npm run typecheck` 0 错误。

## 7. 待你确认

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| W1 | 包名 | `@actor/web` | **`@actor/web`**（与 `@actor/app` 一致） |
| W2 | 控制器风格 | ① `defineController({...})` 为主 + 函数简写 ② 只支持函数 | **①** |
| W3 | 输入校验 | ① 复用 M1 字段描述符与校验器 ② 独立 schema | **①**（一套校验、一种错误格式） |
| W4 | 路由声明位置 | ① `defineModule({ routes })` ② 只放 `defineApp({ routes })` | **①**（与 actors/providers 对称） |
| W5 | WebSocket 时机 | ① M2 内紧随 HTTP ② 独立里程碑 | **①**（内核已有 ws-server，接入层示例已存在） |
| W6 | 服务器实现 | `node:http` 零依赖 | **零依赖**（与内核的取向一致，不引 express/fastify） |
