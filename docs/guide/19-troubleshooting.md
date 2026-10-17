# 19. 排错手册：按报错原文查

**你会得到**：按报错原文查到原因与改法（启动期/运行期分节）

**前置**：手里有一条报错信息　**耗时**：1–3 分钟（按需查）

**用法**：直接搜你看到的报错原文（`Ctrl-F` 这一页）。每条都给"原因 + 改法"。
框架的原则是**启动期失败**并说清下一步，所以多数问题在 `start()` 那一刻就挡住了。

## 一、启动期：装配/依赖

| 报错原文（片段） | 原因 | 改法 |
|---|---|---|
| `未知依赖 'x'（来自 p）` | provider/Actor 的 `deps` 写了不存在的名字 | 名字拼错，或那个 provider 还没声明；`deps: ['config','log']` 是内置的 |
| `循环依赖: a -> b -> a（来自 b）` | provider 互相依赖 | 拆开（引入第三个 provider 或在 factory 里懒解析） |
| `provider 'x' 被重复定义（模块 'm'）` | 两个模块声明了同名 provider | 只留一处，或改名 |
| `Actor 'x' 被重复定义（模块 'm'）` | 同上 | 同上 |
| `插件 'x' 被重复声明` | 同一个插件在两个模块/顶层都挂了 | 只挂一次 |
| `插件 'x' 依赖未知能力 'y'` | `requires` 写了没人 `provides` 的能力名 | 检查插件名/能力名；内置能力见 [02 项目结构](./02-project-layout.md) |
| `插件循环依赖: a -> b -> a` | 两个插件 `requires` 成环 | 把公共部分抽成第三个插件 |
| `服务 'x' 被重复注册` | 两个插件 `provide` 同名 | 改名（服务名是全局命名空间） |
| `插件 'x' 使用了框架保留服务名（…）` | 插件名/provides 撞了 `config`/`log`/`httpServer`/`wsConnections`/`@actor/…` | 换名字；细节见 [09 应用层语法糖](./09-app-sugar.md) §6 |

## 二、启动期：配置

| 报错原文 | 原因 | 改法 |
|---|---|---|
| `缺少必填配置（无默认值，且配置文件中未提供）` | 声明了 `{ type: 'string' }` 却没给值 | 给 `default`，或在文件/env 里提供 |
| `未知配置项（来自 config/default.json，拼写错误？）` | 配置文件里写了 schema 没声明的键 | 改拼写，或先在 `defineConfig` 里声明它 |
| `期望 string，实际 42`（或 number/boolean/json） | 值类型不对（env 里也是字符串，但会被自动转换） | 检查值；`json` 字段要写合法 JSON |
| `不得小于 1（实际 0）` / `不匹配 /^[a-z]+$/` / `取值必须是 'dev' / 'prod'` | 触发了 `min`/`max`/`regex`/`enum` | 改值或改声明 |
| `配置 schema 必须是普通对象（…）` | `defineConfig(undefined)` 或传了数组 | 传对象 |
| `这里要的是**原始 schema**，不是 defineConfig() 的结果` | 把 `defineConfig(...)` 传给了要 schema 的地方 | 用 `defineConfig({...})`（`loadConfig` 收定义）；要用 schema 就 `.schema` |
| `无法从值推断配置项类型（null）` | 简写里写了 `null`/函数 | 写全量：`{ type: 'json', default: null }` |
| `未知的字段类型 'strng'` | `type` 拼错（或想写对象默认值） | 用 `string/number/boolean/json`；对象默认值写 `{ type: 'json', default: {...} }` |
| `配置尚未加载：请先 start()` | 在 `start()` 之前访问 `app.config` | 放到 `setup`/控制器/provider 里（那时配置已加载） |

## 三、启动期：路由与输入

| 报错原文 | 原因 | 改法 |
|---|---|---|
| `路由重复：GET /x（已由 m 注册…）` | 两条路由方法+路径完全相同（**查询声明不参与**，`/x?a=` 与 `/x?b=` 是冲突的） | 改路径（要区分就把参数放进路径），或删一条 |
| `路由 "/__debug/mine" 落在框架保留前缀里` | 自己的路由用了 `/uploads` 或 `/__debug` | 换前缀；要换框架前缀就 `uploadPlugin({ routePrefix: '/files' })` |
| `插件 'x' 声明的路由前缀 "…" 与框架保留前缀 "…" 重叠` | 插件 `routePrefix` 撞保留区 | 换自己的前缀 |
| `路由前缀 "…" 被多个插件声明占用` | 两个插件抢同一片命名空间 | 其中一个换 `routePrefix` |
| `input 声明了 'q'，但它既不是路径参数、也不是查询参数、也不在 body 声明里` | 手写 controller spec 时输入键没有来源 | 模式写 `?q=` / `:q`，或 `body: ['q']`；用 `defineController` 时**默认来自 body**，通常自动满足 |
| `不支持的方法 'FETCH'（支持：GET, HEAD, …）` | `routes` 里方法名写错 | 用 `get/post/put/patch/del/ws` 这些助手 |
| `参数必须独占一段（写成 /:name）` | 写成 `/users/id:123` | 改成 `/users/:id` |
| `路径参数重复：'id'` / `查询参数重复：'q'` | 同一模式里重名 | 去重 |
| `模块 'm' 同时声明了 routes 与 router` | 两种写法混用 | 只留一种（嵌套用 `router`） |
| `路由模式必须以 / 开头：'notes'` | 漏了前导斜杠 | 写 `/notes` |
| `路由配置有问题（N 项）` | 上面某一类问题的**汇总**（一次报全） | 逐条看下面的 `- …` |

## 四、运行期：HTTP

| 现象 | 原因 | 改法 |
|---|---|---|
| **405** + `Allow: …` | 路径对、方法不对 | 换方法，或补一条对应方法的路由 |
| **404** + `no route for …` | 真没这条路由 | 检查前缀（`/api/v1/...`）、拼写、以及模块是否真的挂上了 |
| **400** `input validation failed` | 请求体有未声明的键，或校验不过 | 看 `details.issues`（会列出**全部**问题：哪个字段、为什么） |
| **413** `payload too large` | 超过 `maxBodyBytes`（HTTP）或上传上限 | 调大配置；大文件走分片上传 |
| **504** `actor did not answer in time` | Actor `ask` 超时 | 看 Actor 是不是卡住/消息太大；调 `ask(msg, timeoutMs)` |
| **404** 且 JSON 里是 `不存在名为 'X' 的 Actor` | `ctx.actor('X')` 本地没 spawn、集群也没发现 | 检查 `actors` 声明里的键名（它就是路径） |
| **500** `internal error`（响应无细节） | 控制器/中间件抛了未捕获异常 | 看服务端：`app.on('http:error', …)` 或访问日志；框架故意不把细节回客户端 |
| 中间件没生效 | 阶段/位置不对 | 全局 middleware 在 `defineApp`，模块级在 `defineModule`，路由级传给 `get(path, ctrl, [mw])`；阶段顺序 `pre→auth→parse→handler→post→error` |
| `ctx.extend: "path" 是框架保留字段，不能被插件覆盖` | 覆盖了框架字段 | 换键名（保留清单见 [09 应用层语法糖](./09-app-sugar.md) 的保留名那张表） |

## 五、运行期：存储/Actor/邮件

| 报错原文 | 原因 | 改法 |
|---|---|---|
| `row "…" not found`（`DbNotFoundError`） | `update`/`delete` 的目标不存在 | 先 `findById` 判空 → 404 |
| `DbConflictError`（版本冲突） | 乐观锁：别人先改了 | 翻译成 **409**（`crudRoutes` 会自动翻；手写就 catch 后抛 `HttpError(409)`） |
| `cannot infer the dialect from the connection url (scheme "…")` | DSN 的 scheme 不认识 | 用 `pgsql://` `mysql://` `sqlite:` `mongodb://` `redis://`；或显式给 `dialect` |
| `DbDriverMissingError` / `loadDriverModule` 失败 | 没装驱动包 | `npm i pg` / `mysql2`（sqlite 用内置 `node:sqlite`；mongodb 用 `mongodb`） |
| `init: chunkSize 太小（最小 5242880 字节）` | 分片太小 | chunkSize ≥ 5MiB（或调大 `limits`，但不建议） |
| `init: sha256 必须是 64 位十六进制` | 整文件 sha256 没给/格式不对 | 传 `createHash('sha256')` 的 hex |
| `整文件 sha256 不符（分片数据不可信，已作废会话）` | 传输中数据损坏 | 重新 init 并重传（断点续传状态已作废） |
| `缺少 x-chunk-sha256（本插件配置为必须逐片校验）` | 开了 `requireChunkSha256` 但没带片哈希 | 每个分片带 `x-chunk-sha256`，或关掉该开关 |
| `无主会话只有本人能续传`（他人得到 **404**） | 归属校验生效（这是预期的） | 用创建者身份继续；匿名会话不受限 |
| `mail: 至少一个收件人（to）` / `mail: … 里不允许出现换行` | 邮件非法（缺收件人 / 头部注入） | 发送前调 `assertSendable(message)`；见 [16 邮件](./16-mail.md) |
| `mailPlugin` 起来但 `ctx.get('mail')` 拿到的不是 transport | 它是**受管资源** | `await resource.acquire()` 拿 transport（见 [16 邮件](./16-mail.md)） |
| Actor 重启后状态归零 | 状态没放在 `this.state`，或没开持久化 | 见 [12 Actor 与状态](./12-actors-state.md)：状态只在 `this.state`；class 形态不能开 snapshot/events |
| `Actor 'x' 是 class 形态且启用了 'snapshot' 持久化：当前不支持` | 上面那条的启动期版本 | 改 handler bag，或 `@actor/data` 的 `defineAggregate`，或不开持久化 |

## 六、CLI 与进程

| 现象 | 原因 | 改法 |
|---|---|---|
| `目标目录非空：…` | 脚手架拒绝覆盖 | 换目录，或确认后 `--force`（也不会删你的文件） |
| `未知的插件类型 'nope'` | `--kind` 写错 | `app` / `web` / `resource` / `mail` |
| `插件名不合法` | 用了大写/下划线 | npm 包名风格（小写、可带 `@scope/`） |
| 有未应用的迁移（退出码 **2**） | `actor migrate status` 发现 pending | `actor migrate up`（CI 里就当门禁） |
| `SIGTERM` 后进程不退出 | 有东西在跑（定时器/连接没关） | 用 `runApp()`/脚手架 `main.ts`；插件要在 `onStopping`/`teardown` 里清定时器与连接 |
| 进程启动就退出、无日志 | 启动期抛错（配置/依赖/路由） | 看 stderr 的 `配置校验失败`/`装配失败`/`路由配置有问题`，按上面几节查 |
| 端口占用 `EADDRINUSE` | 端口被别的进程占了 | 换端口（`APP_PLUGINS__HTTP__PORT`）或用 `port: 0` 让系统分配（测试里推荐） |

## 六点五、错误与日志（"我根本没看到报错"）

| 现象 | 原因 | 改法 |
|---|---|---|
| Actor 崩了/重启了，但日志里什么都没有 | 内核的后台事件**默认不转发到应用层** | 配 `errors` 钩子（`onActorCrash` / `onKernelLog`）与 `logging.logger`：见 [20 错误与日志](./20-errors-and-logging.md) |
| `tell()` 的消息好像"消失了" | `tell` 是 fire-and-forget；失败只进死信 | 需要知道失败就用 `ask`；或读 `await app.deadLetters()`（并接 `onDeadLetter`） |
| 5xx 只有一句 `internal error` | 框架**故意**不把内部细节回客户端 | 服务端接 `errors.onHttpError` 或 `app.on('http:error')` |
| 日志里出现 `[errors] … 钩子抛错（已忽略）` | 你自己的错误钩子抛错了（框架兜住了，没影响应用） | 修钩子；这条 console 是刻意的（否则问题会消失） |
| 想看内核单独事件（例如只关心死信） | 事件名有前缀 | `logging.filter: ['kernel:*']` + `exclude` 排除噪声 |
| 自定义命令改了但 `actor commands` 还是旧的 | 早期版本按 URL 缓存模块 | 已修（按 mtime 重新加载）；升级后重跑即可 |
| `app.deadLetters()` 装插件后 `entry.path` 是 undefined | 早期把落盘队列的 `{actorId,msg,reason}` 原样透出 | 已修（统一成 `{path,payload,error}`）；升级后再读 |
| 死信重启后不见了 | 只用了内存环（`deadLetters` 插件没装） | `plugins: [deadLettersPlugin({ path: './data/dlq.jsonl' })]` |
| 迁移文件里没有 `run` 可用 | `MigrationContext` 只有 `store` 与 `log` | DDL 走数据层适配器（`db.sync([...])` / 适配器 `query`）；生成器已按这个签名出模板 |

## 七、诊断与工具

```bash
actor doctor                 # Node 版本/依赖/配置/数据目录/迁移/能力接线/布局/自定义命令/生产开关/生产构建/模板漂移
actor commands [--json]      # 内置 + 项目自定义命令（带来源）
actor generate <kind> <名字>  # 生成骨架（controller/actor/service/model/schema/middleware/test/command）
actor doctor --json          # CI 里可用
actor migrate status         # 待应用迁移（有则退出码 2）
npm run typecheck            # 类型
DEBUG=1 actor … --debug      # CLI 打堆栈
```

`actor doctor` 会报出"**声明了能力但没接线**"（例如 `package.json` 里有 `@actor/redis`
但 `server.ts` 没有 `redisAdapter`）以及"放错层"的文件 —— 这两类最容易在上线后才被发现。

## 八、还是没头绪？

1. 跑一个最接近的示例：`examples/` 里 8 个能跑的项目（见[文档首页](./README.md)）；
2. 用**最小复现**：`createApp` + 一条路由 + `dispatch()` 直接派发（不经过网络），
   启动期报错会带"哪一项、来自谁"；
3. 查设计文档里"为什么这么做"：[internals/](./internals/README.md) 与 [`docs/design/`](../design/)；
4. 抓不到 5xx 的话，先把 `app.on('http:error', …)` 与 `requestLogPlugin` 接上
   （见 [18 可观测与上线](./18-observability-deploy.md)）。

## 附：这一页的报错原文是**实测**的（CI 真执行）

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule, definePlugin, defineConfig, loadConfig } = await import(
  `${repo}packages/app/src/index.ts`
);
const { debugPlugin, defineController, defineRoutes, defineWebPlugin, get, httpPlugin, uploadPlugin } = await import(
  `${repo}packages/web/src/index.ts`
);

const app = (spec) => createApp(defineApp(spec), { configDir: null, env: {} });
const messageOf = async (fn) => {
  try {
    const value = await fn();
    if (value && typeof value.stop === 'function') await value.stop();
    return null;
  } catch (error) {
    return String(error.message).split('\n').slice(0, 2).join(' | ');
  }
};

// 装配类
assert.match(await messageOf(() => app({ modules: [defineModule({ name: 'm', providers: { p: { factory: ({ nope }) => nope, deps: ['nope'] } } })] }).start()), /未知依赖 'nope'/);
assert.match(await messageOf(() => app({ modules: [defineModule({ name: 'm', providers: { a: { factory: ({ b }) => b, deps: ['b'] }, b: { factory: ({ a }) => a, deps: ['a'] } } })] }).start()), /循环依赖: a -> b -> a/);
assert.match(await messageOf(() => app({ modules: [defineModule({ name: 'm' })], plugins: [definePlugin({ name: 'httpServer' })] }).start()), /使用了框架保留服务名/);

// 配置类
assert.match(await messageOf(() => loadConfig(defineConfig({ dsn: { type: 'string' } }), { configDir: null, env: {} })), /缺少必填配置/);
assert.match(await messageOf(() => defineConfig({ broken: { type: 'strng' } })), /未知的字段类型 'strng'/);

// 路由类（真起 httpPlugin，验证启动期拦截）
assert.match(
  await messageOf(() => app({ modules: [defineModule({ name: 'm', routes: defineRoutes([get('/x', () => 1), get('/x', () => 2)]) })], plugins: [httpPlugin({ port: 0 })] }).start()),
  /路由重复：GET \/x/,
);
assert.match(
  await messageOf(() => app({ modules: [defineModule({ name: 'm', routes: defineRoutes([get('/__debug/mine', () => 1)]) })], plugins: [httpPlugin({ port: 0 })] }).start()),
  /落在框架保留前缀里/,
);
// 手写 spec（不走 defineController 的自动补 body）时，规则 3 仍然会拦住"没有来源的输入键"
const { buildRouteTable } = await import(`${repo}packages/web/src/index.ts`);
const rule3 = buildRouteTable([get('/x', { input: { q: { type: 'string' } }, handle: () => 1 })]);
assert.match(rule3.issues[0].message, /input 声明了 'q'.*不在 body 声明里/);

// 插件定义期
assert.match(await messageOf(() => uploadPlugin({})), /必须给 "storage"/);
assert.match(await messageOf(() => debugPlugin({ enabled: true })), /至少 16 字符的 token/);
assert.match(
  await messageOf(() => defineWebPlugin({ name: 'p', middleware: [{ handler: () => 1, phase: 'authh' }] })),
  /phase must be one of pre\|auth\|parse\|handler\|post\|error/,
);
console.log('ok');
```

## 下一步


- [20 错误与日志](./20-errors-and-logging.md)
- [文档首页（按任务查）](./README.md)
