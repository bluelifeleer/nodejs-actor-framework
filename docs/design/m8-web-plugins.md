# M8 设计：Web 层插件（上传 / 鉴权 / 邮件 / 日志调试 / 用户插件）

> 用户需求五条：(1.1) 文件上传（单/多文件）；(1.2) token 校验，支持 JWT；
> (1.3) 邮件功能（**要回答"怎么拆"**：内核包？插件？）; (1.4) 日志与调试；(1.5) 提供用户自定义插件逻辑。
>
> 本文是**定稿设计**（先设计后实现），已按用户拍板写入决策（§2）。实现分期见 §9。

## 1. 现状核对（实测，不是印象）

| 事实 | 出处 | 含义 |
|---|---|---|
| `PluginSpec` 只有 `name/requires/provides/description/config/kernelPlugins/setup/onReady/onStopping/teardown` | `packages/app/src/assembly.ts:70` | **插件不能贡献路由，也不能贡献中间件** ✗ —— 这是 1.1/1.2/1.4 的共同前置缺口 |
| `Middleware = (ctx, next) => unknown`，顺序 = 声明顺序 | `packages/web/src/middleware.ts:10` | 没有阶段/优先级元数据 ✗ —— "鉴权必须早于上传解析"只能靠人肉排顺序 |
| `RequestContext` 有 `params/query/body/headers/get()/status/requestId` | `packages/web/src/context.ts` | `ctx.user`/`ctx.files`/`ctx.log` 无处安放 ✗ |
| `httpPlugin` 已有 `maxBodyBytes`（默认 1 MiB）+ 413 分支；JSON 按 content-type 解析 | `packages/web/src/http.ts:23,41,90,100` | 上传只需**在旁边加一条多部分分支** ✓ |
| `requestId` 回写、`http:error` 事件、`requestLogPlugin`、`metricsPlugin`、`wsPlugin` | `packages/web/src/*` | 1.4 的基础已具备 ✓，缺的是结构化字段/脱敏/诊断路由 |
| `definePlugin(spec)` 是恒等函数 | `packages/app/src/assembly.ts:187` | 扩展 `PluginSpec` 的成本很低 ✓ |
| `@actor/db-core` 的 `supervise()`/`runManagedConnectionContract()` 是**通用**资源生命周期 | M7 产出 | 邮件/上传也想要它 —— 但包名像数据库专属 ✗（用户已决定抽 `@actor/resource`，见 §2） |

## 2. 已定决策（用户拍板）

| # | 决策 | 影响 |
|---|---|---|
| 1 | 上传：**流式解析 + 边写边算大小**，超限立刻 413 | 要写一个最小 multipart 边界扫描器（零依赖） |
| 2 | 上传存储：**只内置 local disk** + 发布契约与套件，S3/OSS 交给用户适配器 | 上传离线可真验 ✓；扩展点清晰 |
| 3 | 鉴权：**JWT + JWE + refresh token 全都要** | 鉴权拆成三期（M8c1/M8c2/M8c3），refresh 需要存储（Redis 或内存） |
| 4 | 邮件：**单包 `@actor/mail`**（基础能力 + `mailPlugin`），v1 直发，outbox 留文档 | 与 db/redis/mongodb 同层；`fileTransport` 让邮件离线可真验 |
| 5 | **现在就抽 `@actor/resource`**（`supervise`/契约套件搬过去） | 动 4 个包的依赖与 re-export（有公开面基线 + 847 条测试兜底） |
| 6 | 诊断路由：默认关闭 + 需 token + **生产环境拒绝启动**（除非显式允许） | 三层门禁 |
| 7 | 分期：M8a→M8e 逐期，每期一次提交、全绿 | 与 M7 同节奏 |

## 3. 前置机制（1.5 的答案）：web 插件 = PluginSpec + 三个贡献点

```ts
// @actor/web —— 结构化扩展（与 databaseAdapter 同构：不强行耦合 app 的内部类型）
export type MiddlewarePhase = 'pre' | 'auth' | 'parse' | 'handler' | 'post' | 'error';

export interface WebPluginSpec extends PluginSpec {
  /** ① 贡献路由（冲突在**启动期**报错，不留到运行期） */
  routes?: readonly Route[];
  routePrefix?: string;
  /** ② 贡献中间件，**带阶段**（不再依赖声明顺序） */
  middleware?: readonly {
    handler: Middleware;
    phase: MiddlewarePhase;
    before?: readonly string[];
    after?: readonly string[];
  }[];
  /** ③ 请求上下文扩展槽：往 ctx 上挂派生值（ctx.user / ctx.files / ctx.log） */
  context?: (ctx: RequestContext) => Record<string, unknown>;
}
export function defineWebPlugin(spec: WebPluginSpec): WebPluginSpec;
```

阶段语义（**顺序由框架保证，不靠使用者记得**）：

| 阶段 | 典型用途 | 为什么在这 |
|---|---|---|
| `pre` | requestId、访问日志、CORS | 最早；此时 body 还没解析 |
| `auth` | JWT/JWE 校验、权限 | **在解析 body 之前** —— 未授权请求不该触发上传落盘 |
| `parse` | 上传解析、输入校验 | 只有确实要用时才做 |
| `handler` | 控制器 | |
| `post` | 响应头、压缩、审计 | |
| `error` | 错误映射兜底 | |

另外两件：
- **`RequestExtensions` 接口**（手写 `.d.ts`）：`ctx.user?: User`、`ctx.files?: UploadedFile[]`、`ctx.log: RequestLogger`；
- **`runWebPluginContract()`**：随包发布的契约套件（阶段顺序、`requires` 拓扑、config schema 生效、
  `teardown` 必被调用、重复 name/`provides` 冲突报错）—— "用户自定义插件"能自证合规 ✓。

**三个层次**（用户该写哪种）：app 插件（服务 + 生命周期）→ **web 插件**（再贡献路由/中间件/ctx 槽）→ 资源适配器
（`defineResourceAdapter`/`defineMailTransport`/…）。**不做沙箱**：插件是与应用同进程的**可信代码**（文档写明）。

## 4. `@actor/resource`：把通用资源生命周期从 db-core 抽出来（决策 5）

```
packages/resource/   @actor/resource   ← 新：与"数据库"无关的通用层
  resource.ts        ResourceAdapter / ManagedResource / defineResourceAdapter / defineManagedResource
  managed.ts         supervise()：状态机、事件、drain、快速失败、定时探活/保活
  errors.ts          ResourceError / ResourceConfigError / ResourceUnavailableError / DriverMissingError
  resolve.ts         createAppRequire / loadDriverModule（从应用根解析 + 安装提示）
  plugin.ts          resourceAdapter()（= 现在的 databaseAdapter）
  testing.ts         runManagedResourceContract()（= 现在的 runManagedConnectionContract）
```

迁移与兼容（**只增不减**，由公开面基线与测试保证）：

| 包 | 变化 |
|---|---|
| `@actor/resource` | 新增；承载通用层 |
| `@actor/db-core` | 依赖 resource；**保留** `Row/Runner/PoolOptions/DriverPool/DriverFactory`（SQL 形状）与 `DbError` 家族名（re-export resource 的基类），并 re-export 通用层（`supervise`/`createAppRequire`/… 与 `DatabaseAdapter`/`databaseAdapter`/`runManagedConnectionContract` 这些**已发布的名字**） |
| `@actor/redis` / `@actor/mongodb` | 依赖从 db-core 改为 resource（它们只用通用层） |
| `@actor/db` | 不变（依赖 db-core） |

命名对齐（新名字更准，旧名字保留为别名）：
`ResourceAdapter`（旧 `DatabaseAdapter`）、`ResourceUnavailableError`（旧 `DbUnavailableError`）、
`resourceAdapter()`（旧 `databaseAdapter()`）、`runManagedResourceContract()`（旧 `runManagedConnectionContract()`）。

## 5. 1.1 文件上传（`uploadPlugin`，落在 `@actor/web`）

- **流式**：边扫边界边写（决策 1），三个上限 `maxFileSize` / `maxFiles` / `maxFieldSize`，超限**立刻** 413 并断开；
- 与现有 body 处理按 **content-type 分流**：`multipart/form-data` → 上传分支；`application/json` → 现有分支；其它 → 415；
- **存储是扩展点**（决策 2）：
  ```ts
  export interface UploadStorage {
    put(stream: AsyncIterable<Uint8Array>, meta: { name: string; mimeType: string; size: number }): Promise<UploadedFile>;
    get(key: string): Promise<{ stream: AsyncIterable<Uint8Array>; meta: UploadedFile } | null>;
    delete(key: string): Promise<boolean>;
    stat(key: string): Promise<UploadedFile | null>;
  }
  export function localDiskStorage(options: { dir: string; publicPrefix?: string }): UploadStorage;
  export function defineUploadStorage(spec: UploadStorage): UploadStorage;
  export function runUploadStorageContract(...): void;   // 随包发布的契约套件
  ```
- **默认安全**：key 由服务端生成（`uuid` + 白名单扩展名），原始文件名/MIME 只作**元数据**；
  `allowedMimeTypes`/`allowedExtensions` 白名单；不信任任何客户端路径；
- 控制器侧：`ctx.files('docs')`（多）、`ctx.file('avatar')`（单）、`ctx.body` 拿文本字段；
- **多文件语义**：**全成功或全回滚**（任一失败即删掉已写入的）；
- 自带路由：`POST /uploads`（多文件）、`GET /uploads/:key`（回读，带 content-type 与 `Content-Disposition`；
  v1 不做 Range，文档写明）；
- **离线可真验**：本地磁盘 storage → 真写/真读/限额/路径穿越尝试，全部在 CI 里跑。

## 6. 1.2 鉴权 / JWT（决策 3：三期）

### 6.1 M8c1：JWT 签发与校验
- 零依赖（`node:crypto`）：**HS256/384/512**（HMAC + 常量时间比较）、**RS256/384/512**、**ES256/384**；
  `alg: none` 显式拒绝；**算法白名单**（防 alg 混淆）；
- 校验顺序：签名 → `exp`/`nbf`/`iat`（`clockToleranceMs`）→ `iss`/`aud` → `verifyExtra` 钩子（黑名单/撤销）；
- 取值来源可配：`Authorization: Bearer` / cookie / 自定义 extractor；
- 路由级：`defineController({ auth: { required: true, roles: ['admin'] } })` + `requireRole()`；
  **明确写清"claims 是声明，不是授权"**；
- 失败：`401` + `WWW-Authenticate`；**对外不区分原因**（防探测），服务端记明细（接 1.4）；
- 密钥：配置 + env；**缺失/过短直接拒绝启动**；永不进日志（脱敏有测试）。

### 6.2 M8c2：JWE（加密 JWT）
- 支持**常见且安全**的组合：`RSA-OAEP-256` + `A256GCM`、`dir` + `A256GCM`；其它组合**显式拒绝**（不假装支持）；
- 推荐**嵌套**（签名后加密：JWS in JWE）；解密后仍走 6.1 的完整校验链；
- 密钥轮换：支持 `keys: [{ kid, key }]`（多密钥，按 `kid` 选，验签可用旧密钥）；
- 明确不做：ECDH-ES 全套、密钥管理服务（KMS）集成（文档给出接入点）。

### 6.3 M8c3：refresh token（需要存储）
- **不透明随机串**（不是 JWT —— 要能撤销），含 `family`/`jti`/`expiresAt`；
- **轮换 + 重放检测**：旧 token 再被使用 → **整族撤销**（标准防御）；
- 存储契约（可注入）：
  ```ts
  export interface RefreshTokenStore { issue(...); consume(token): Promise<Result>; revokeFamily(id); revoke(token); }
  export function memoryRefreshStore(): RefreshTokenStore;         // 单节点/测试
  export function redisRefreshStore(client): RefreshTokenStore;    // 复用 @actor/redis（可选依赖）
  export function runRefreshStoreContract(...): void;              // 契约套件
  ```
  内置内存实现会在多节点下**语义不成立**——这一点在启动时按 `NODE_ENV`/显式开关**警告或拒绝**（不静默糊过去）。

## 7. 1.3 邮件：拆法（**回答"内核包还是插件"**）

**结论：内核不要碰邮件；基础能力放独立包 `@actor/mail`，插件在同包里，投递语义单独一期。**

理由（分层，不是工作量）：内核是**运行时原语**（actor/mailbox/scheduler，CJS、零依赖、不含 I/O 语义）；
邮件是**应用级 I/O 能力**（SMTP/模板/重试/退信）。把 SMTP 放进内核会让内核知道"邮件"，破坏这个仓库一路守住的边界。

| 层 | 落点 | 内容 |
|---|---|---|
| ① 基础能力 | `@actor/mail` | 消息模型（to/cc/bcc/subject/text/html/attachments/headers）、**transport 契约**、内置 transport、极简渲染、**契约套件** |
| ② 应用接线 | 同包 `mailPlugin()` | 配置节 `plugins.mail.*`、**从应用根懒加载** `nodemailer`（缺失给 `npm i nodemailer`）、生命周期交给 `supervise()`、注册 `ctx.get('mail')` |
| ③ 投递语义（单独一期） | 复用 `@actor/data` 的 **outbox** | 至少一次 + 重试 + 幂等；v1 **直发 + 文档说明怎么接** |

```ts
export interface MailTransport {
  send(message: MailMessage): Promise<{ id: string; accepted: string[]; rejected: string[] }>;
  verify?(): Promise<void>;
  close?(): Promise<void>;
}
export function fileTransport(options: { dir: string }): MailTransport;   // ★ 内置零依赖：写 .eml
export function smtpTransport(options: SmtpOptions): MailTransport;       // 懒加载 nodemailer
export function defineMailTransport(spec): MailTransport;                 // 用户接 Resend/SES/Mailgun
export function runMailTransportContract(...): void;                      // 契约套件
```

- **`fileTransport` 是关键设计**：它让邮件在**离线环境也能真验** —— 断言 `.eml` 的 MIME 结构、头部编码、
  中文主题（RFC 2047）、附件 base64；
- SMTP：契约级（假 nodemailer）+ **可选真验**（compose 加 **MailHog**，`ACTOR_TEST_SMTP_URL`，缺了**可见跳过**）；
- **模板**：不内置模板引擎（不造轮子）—— 极简占位替换 + **默认转义**（防 XSS）+ `renderer` 注入点；
- **v1 不做**：DKIM 签名、退信/投诉 webhook、限流与退避、批量个性化（各自都有替代路径，文档写清）。

## 8. 1.4 日志与调试

**不发明新抽象**：全仓库已用 `(event: string, meta?) => void` 这个接缝，就沿用它，补三样：

1. **结构化请求日志**（扩 `requestLogPlugin`）：`method/path/status/durationMs/requestId/bytesIn/bytesOut/userId`
   + 慢请求阈值 + 采样 + **脱敏名单**（`authorization`/`cookie`/`password`/`token`/`set-cookie` 一律打码，有测试）；
2. **请求级子日志** `ctx.log`：自动带 `requestId`，业务日志能与访问日志对上；
3. **诊断路由** `debugPlugin`（决策 6 的三层门禁：默认关闭 → 需 token → 生产拒绝启动除非显式允许）：
   - `GET /__debug/routes`（路由表 + 每个路由的中间件阶段）
   - `GET /__debug/health`（**聚合各受管资源健康**：直接问每个 `ManagedResource` 的 `stats()`/`healthCheck()`
     —— 正好复用 M8a 抽出的 `@actor/resource`）
   - `GET /__debug/config`（**只出 schema 与"已设置"标记，值打码**）
4. 已有的 `http:error` 事件直接进日志；**5xx 永远带 requestId 记明细**。

## 8.5 实施进度

### M8a0（已完成）：抽 `@actor/resource`

- 新建 `packages/resource`（`@actor/resource`，零运行时依赖）：通用层搬过来 ——
  错误基类（`ResourceError`/`DriverMissingError`/`ResourceConfigError`/`ResourceConnectionError`/
  `ResourceNotConnectedError`/`ResourceUnavailableError`）、驱动解析（`createAppRequire`/`loadDriverModule`/
  `DriverResolver`）、连接形状与池参数（`BaseConnection`/`PoolOptions`/`mapPoolOptions`）、
  适配器契约（`ResourceAdapter`/`ManagedConnection`/`AdapterConnectInput`/`defineResourceAdapter`/
  `defineManagedResource`）、连接管控（`supervise` + 事件 + drain + 快速失败）、应用接线
  （`resourceAdapter()`）、契约套件（`runManagedResourceContract`/`realResourceUrl`/`testWithResource`）。
- **兼容策略：别名 + 保形**（这是本期的关键纪律）：
  - `@actor/db-core` 的 `errors.ts`/`resolve.ts`/`adapter.ts`/`managed.ts`/`plugin.ts`/`testing.ts`
    全部变成**再导出 shim**，运行时导出集合与名字**一个不少**；`Row`/`Runner`/`DriverPool`/`DriverFactory`
    （SQL 形状）与 `DbConflictError`/`DbNotFoundError`（实体语义）留在 db-core；
  - 别名是**同一个对象**（`databaseAdapter === resourceAdapter`、`DbError === ResourceError`、
    `runManagedConnectionContract === runManagedResourceContract`），有断言钉住；
  - **`name`/`code`/消息文案全部保持搬迁前形态**（`DbError` / `DB_CONFIG_INVALID` …）—— 实施中发现
    "错误的 `name` 也是对外行为"（既有测试断言 `err.name === 'DbDriverMissingError'`），所以泛型类仍然
    报历史名字，只把它们当作类型层的别名；`ResourceNotConnectedError` 的默认参数与文案也一并保形。
- `@actor/redis` / `@actor/mongodb` 依赖从 `@actor/db-core` 改为 `@actor/resource`（它们只用通用层）；
  `@actor/db` 不变（仍依赖 db-core 拿 SQL 形状）。
- 矩阵：`packages/resource` 进 `npm test` 工作区矩阵、`tsconfig.json` include、`tools/docs-site.mjs` PACKAGES；
  自带公开面门禁（含证伪）；通用层测试（managed/plugin/real-db-helpers/kind-gate）随包搬到 `packages/resource/test/`。
- **验证**：全量 **850/850**（833 pass / 0 fail / 17 skipped）、typecheck 0、文档站 46 页；db-core 运行时导出数不变。

### M8a（已完成）：web 插件机制

- `PluginSpec` 扩展三个**不透明**贡献点：`routes` / `routePrefix` / `middleware`（应用层不依赖 Web 层，
  保持既有依赖方向）；`app.routes` 与 `app.middleware` 把插件贡献聚合进去（模块路由之后、全局中间件之后）。
- `@actor/web` 新增 `plugins.ts`：`defineWebPlugin()`（校验名字/前缀/**阶段**/插件内重复路由 —— 全在**定义期**报错）、
  `MIDDLEWARE_PHASES`（pre/auth/parse/handler/post/error）、`orderMiddleware()`（**稳定排序**：未声明阶段的按
  `pre` 处理 → 既有代码顺序不变，有测试钉住）、`WEB_CONTEXT_HOOKS_SERVICE`，以及**契约套件**
  `runWebPluginContract()`（阶段合法、路由带前缀无冲突、`context` 钩子注册成服务、非法阶段/重复路由被拒、
  阶段排序真实执行验证）。
- `dispatch` 中间件链改走 `orderMiddleware`；新增 `contextHooks`：`defineWebPlugin({ context })` 通过 `setup`
  把钩子注册成服务，`httpPlugin` 每请求读出并执行。
- `RequestContext` 新增 `extend(values)`（写到 ctx 本身 + `state`，**拒绝覆盖框架保留字段**，有测试）
  与 `extension<T>(key)`；约定字段 `user`/`files`/`log` 已声明（由后续 M8b/M8c/M8d 写入）。
- 测试：`packages/web/test/plugins.test.ts` 11 条（含契约套件 5 条）；`web + app` 44/44 全绿。
- 本期已收尾：`examples/app-plugin`（自定义 web 插件 + 冒烟门禁通过）+ 指南 `docs/guide/12-web-plugin.md`
  （含**离线可跑**的 verify 块：`defineWebPlugin` 校验 + `orderMiddleware` 阶段顺序真实执行验证）。

### M8b（已完成）：上传（流式 + 分片 + 断点续传 + sha256）

- `packages/web/src/upload/`：
  - `storage.ts`：`UploadStorage` 契约（`put(stream)` 边写边算 sha256 / get / stat / delete / list?）+
    `localDiskStorage`（临时名写入→rename、元数据先落、key 由服务端生成、**纯流式**）+
    `memoryUploadStorage` + `defineUploadStorage` + **`runUploadStorageContract`**（契约套件，含证伪）；
  - `multipart.ts`：**零依赖流式 multipart 解析**（边读边写、超限**立刻** 413、畸形 400、
    文件名剥路径、跨块边界安全刷出）；
  - `chunked.ts`：`ChunkSessionStore` 契约 + `memoryChunkStore` + **`diskChunkStore`（重启后仍能续传）** +
    `runChunkStoreContract`（含 reopen 用例：换实例后仍看得到已收分片）；
  - `plugin.ts`：`uploadPlugin()` —— 7 条路由（multipart 上传/回读/init/PUT 分片/状态/complete/abort），
    分片逐片 sha256、整文件 sha256（不符 → 400 + expected/actual + **作废会话** + 删文件）、
    幂等重传、精确分片大小校验、默认安全（服务端 key、白名单、5MiB 下限）。
- `httpPlugin` 支持**流式路由**：插件把"需要流式 body 的路径"注册成 `@actor/web:streamRoutes` 服务，
  httpPlugin 命中就**不缓冲**、把原始流通过 `ctx.stream` 交给 handler。
- `ControllerSpec` 补上 `body?: readonly string[]`（路由校验一直在用、类型里却漏了 ——
  实施时我据此误判并删掉声明，启动期报错才暴露）。
- `defineRoutes` 放宽为接受助手产出的元组形状（`get/post/put` 返回带可选中间件的 4 元组，
  早先只接受 3 元组 → `defineRoutes([get(...)])` 是类型错误；示例没进 typecheck 所以一直没暴露）。
- 测试 27 条全绿：存储契约（本地磁盘/内存 × 4 条 + 证伪）、分片契约（内存/磁盘 × 5 条，含**重启续传**）、
  multipart 边界（跨块、多文件、剥路径、超限、畸形）、插件端到端（真 HTTP：单/多文件 + 回读 +
  **超限全回滚** + 分片全流程 + **断点续传（先查 missing 再补）** + 分片 sha256 不符 +
  整文件 sha256 不符报期望/实际且不留文件）。
- 示例 `examples/app-upload`（自带**前端页面**：分片/并发/退避重试/断点续传/WebCrypto sha256）+ 冒烟门禁；
  指南 `docs/guide/13-upload.md`（含**离线可跑** verify 块：本地磁盘存储 + 分片会话）。

**自我修正（本轮抓到 4 个真 bug，都是我的）**：
1. `defineWebPlugin` **覆盖**而不是组合调用方的 `setup` → 插件注册的服务（流式路由表、存储）全丢，
   表现为运行期 500 与测试挂起；
2. `dispatch` 没把 `options.stream` 交给 ctx → 上传路由拿不到请求流；
3. multipart 起始边界多拼了一个 CRLF → 所有请求都被判"起始边界不符"；
4. 字段 part 的**尾块被丢**（数据出口只处理文件 sink）→ 表单字段值被截断。
   另外两处是我的**测试写法**错：在断言消息里读 body（`Body has already been read`）、
   用 `app.get('http')` 取端口（服务名不是 `http`，且失败后 `stop()` 会挂）。

### M8c1（已完成）：鉴权 / JWT

- `packages/web/src/auth/jwt.ts`：零依赖 JWT（`node:crypto`）——HS256/384/512（**常量时间比较**）、
  RS256/384/512、ES256/384（`dsaEncoding: 'ieee-p1363'`，JWS 用原始 R||S）；**拒绝 `alg=none`**；
  算法**白名单**；`exp/nbf/iat` + `clockToleranceSec`（默认 0，不偷偷放宽）；`iss`/`aud`；`kid` 多密钥轮换；
  `verifyExtra` 钩子（撤销/黑名单）；失败抛 `JwtError` 带 `reason`（**只给服务端日志用**）；
  `decodeJwt()` 明确命名"只解码不校验"。
- `authPlugin()`：中间件跑在 **auth 阶段**（在解析 body 之前）；token 来源 = Bearer / cookie / 自定义 extractor；
  用户放进 `ctx.user`（`{ sub, roles, scopes, claims }`）；每路由声明 `defineController({ auth: { required, roles } })`
  （由 `dispatch` 把当前控制器声明放进 `ctx.state.route` 供中间件读取 ✓ 不反向依赖）；`requireRole(...roles)`；
  **401 + `WWW-Authenticate: Bearer`** 且**对外不区分原因**（明细只进 `logger`）；角色不符 403；
  密钥缺失/太短（HMAC < 32 字节）**拒绝启动**，且永不进日志。
- `HttpError` 支持 `headers` 并真的落到错误响应上（否则 `WWW-Authenticate` 就是假承诺 —— 测试里断言响应头存在）。
- `orderMiddleware` 现在也尊重**函数上的 `phase` 属性**：`requireRole()` 自带 `phase: 'auth'`，
  否则默认 `pre` 会让它跑在 `authPlugin` 之前（`ctx.user` 还没设 → 全部 401）。
- 测试 8 条：JWT（三档 HMAC 往返/篡改/`alg=none`/算法混淆/ES256/RS256/exp·nbf·iat·容差/iss·aud/kid/verifyExtra）+
  插件端到端（401 带头且不暴露原因、服务端记明细、`ctx.user`、角色 403、cookie 来源（用 `node:http` 发原始请求 ——
  fetch 不允许设 cookie 头）、自定义 extractor、撤销、启动期拒短密钥）。

### M8c2（已完成）：JWE（加密 JWT）

- `packages/web/src/auth/jwe.ts`：只支持 `RSA-OAEP-256` + `A256GCM`（PEM 公钥加密/私钥解密，按 `kid` 轮换）
  与 `dir` + `A256GCM`（32 字节共享密钥）；**其它组合一律显式拒绝并说清支持什么**（不假装支持）。
  compact 五段；AAD = protected header（RFC 7516）；CEK 每条消息随机（`dir` 除外）；
  解密失败（篡改密文/标签/IV/header、拿错密钥）一律 `decrypt_failed`；
  `decryptToJws()` 一步解出内层 JWS 并校验它确实是三段。
- 推荐用法是**嵌套 JWS-in-JWE**：`signJwt` → `encryptJwe` → `decryptToJws` → `verifyJwt`，两头都占。
- 测试 5 条：dir 往返 + 密文里看不到明文（含 base64）+ header/密文/标签/IV 篡改全部拒绝；
  32 字节校验 + `kid` 找不到明确报错；RSA-OAEP-256 往返 + 轮换 + 错密钥拒绝；
  不支持组合（`RSA-OAEP`/`A256KW`/`none`/`A128GCM`/伪造 header）显式拒绝且信息里写清支持项；
  嵌套端到端（内层被篡改 → 外层解开也验签失败；内层不是 JWS → 明确报错）。
- 文档：指南 14 增加 JWE 一节（含**离线可跑** verify 块：签→加→解→验 + 不支持组合被拒）。

### M8c3（已完成）：refresh token（轮换 + 重放即整族撤销）

- `packages/web/src/auth/refresh.ts`：`RefreshTokenStore` 契约 + `memoryRefreshStore` +
  **`redisRefreshStore`**（只要求一个最小 KV 客户端形状 —— `@actor/redis` 的客户端满足它，
  **不引入依赖**）+ **`runRefreshStoreContract`** 契约套件。
- 不变量（都写进契约套件）：token 是**不透明随机串**（不是 JWT，必须可撤销）；**每次消费都轮换**；
  **旧 token 再用一次 = 重放 → 整族撤销**（连刚换发的那把也失效，有断言）；
  未知/过期/撤销明确区分；`revokeFamily` 不影响别族；存储里只放 **token 的 sha256**（不放原文，有断言）。
- **多节点诚实边界**：`memoryRefreshStore` 是单节点语义（跨实例表现为随机登出、重放检测会被绕过），
  所以 `NODE_ENV=production` 下**默认拒绝启动**，要用必须显式 `{ allowInMemoryInProduction: true }` 并留日志。
- 契约套件新增 `expiryReportsAs`：KV 型存储到期键直接消失，只能报 `unknown` ——
  **这是诚实答案，不是缺陷**，所以显式声明而不是把断言放松掉。
- 测试 10 条：内存 + redis 形状（假 KV 客户端**共享同一份存储** → `reopen` 语义是真验证）两套契约 +
  哈希存储断言 + 生产拒绝启动 + 重放留痕。

## 9. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| **M8a0** | 抽 `@actor/resource`（通用层搬迁 + db-core 别名 re-export + redis/mongodb 改依赖） | 847+ 全绿；db-core/redis/mongodb 公开面**只增不减**（基线门禁）；新包进矩阵 |
| **M8a** | web 插件机制（`routes`/`middleware(phase)`/`ctx` 扩展 + `defineWebPlugin` + `runWebPluginContract`）+ `examples/app-plugin` | 阶段顺序/拓扑/冲突/teardown 用例；示例冒烟 |
| **M8b** | `uploadPlugin` + `UploadStorage` 契约 + `localDiskStorage` + 契约套件 + 示例 | 离线真验（真写/真读/限额/穿越）；单/多文件 |
| **M8c1** | JWT 签/验 + 算法白名单 + `ctx.user` + 角色中间件 | 篡改/过期/错签名/`alg=none`/算法混淆/时钟容差用例 |
| **M8c2** | JWE（RSA-OAEP-256+A256GCM、dir+A256GCM）+ `kid` 轮换 | 加解密往返、拒绝不支持组合、嵌套 JWS-in-JWE |
| **M8c3** | refresh token（不透明串 + 轮换 + 重放检测 + 内存/Redis 存储） | 契约套件 + 重放即整族撤销用例；多节点下的告警 |
| **M8d** | 结构化日志 + 脱敏 + `ctx.log` + `debugPlugin` | 脱敏有测试；诊断路由默认不可达；健康聚合 |
| **M8e** | `@actor/mail`（模型/transport 契约/fileTransport/SMTP/渲染/契约套件 + `mailPlugin` + MailHog 真验开关） | `.eml` 真验；假 nodemailer 契约级；真 SMTP 可见跳过 |

其余照旧：新包进 `npm test`/typecheck 矩阵、公开面与成员级门禁（含证伪）、指南（含**离线可跑**的 verify 块）、
示例冒烟、（如新增包）docs-site API 页。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 抽 `@actor/resource` 是**跨 4 包真搬迁** | 单独一期（M8a0）；公开面基线 + 847 测试；别名 re-export；先搬后改名 |
| JWE + refresh 范围大（决策 3） | 拆三期；每期独立可验收；不支持的组合**显式拒绝**而不是半吊子支持 |
| refresh 的存储语义易被误解（内存实现多节点不成立） | 启动时按环境**警告/拒绝**；契约套件把语义钉死；文档写清 |
| 流式 multipart 解析器写错（安全敏感） | 只实现必要子集 + 大量边界用例（畸形边界/超长头部/嵌套/分块）+ 限额优先；**不解析即拒绝** |
| 诊断路由误开 | 三层门禁 + 默认关闭 + 生产拒绝启动 + 有测试证明"默认不可达" |
| `(event, meta)` 接缝不够用（需要 level/child） | 先给 `withFields()` 之类的**薄助手**，不引入新日志框架；不够用时再立设计 |

## 11. 明确不做（本轮）

- 沙箱化插件（插件是可信代码）；插件市场/热插拔；
- OIDC/OAuth2 授权服务器、SAML、多因素认证；
- 上传的分片/断点续传、图片转码、杀毒扫描；
- 邮件的 DKIM/DMARC、退信处理、营销批量；
- 分布式追踪（OpenTelemetry）接入（已有 span 基础，另立设计）。

## 12. 需要在使用前确认的细节（实现时给理由）

1. `@actor/resource` 里 `Runner`-类 SQL 形状**不进**（留在 db-core）——确认这个边界；
2. `ctx.files` 是"解析完才有"（`auth` 阶段拿不到）——顺序语义要写进指南；
3. refresh token 默认 TTL 与"内存实现在生产拒绝启动"的具体条件；
4. `debugPlugin` 的 token 校验复用 `authPlugin` 还是独立密钥。
