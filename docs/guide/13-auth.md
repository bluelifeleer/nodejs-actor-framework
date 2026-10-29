# 13. 鉴权：登录、保护接口、角色

**你会得到**：登录签发 token、两种粒度的接口保护、401/403 约定、上线前的安全清单

**前置**：有可跑的 HTTP 项目　**耗时**：15 分钟

鉴权分三件事，**分开理解**最省事：

| 事 | 谁负责 |
|---|---|
| ① 拿到 token（登录、刷新、注销） | **你的代码**（框架只提供 JWT 的签发/校验工具） |
| ② 校验 token 并放进 `ctx.user` | `authPlugin`（挂在 `@actor/web`） |
| ③ 哪些接口要求什么权限 | **控制器声明**（`auth: { required, roles }`） |

框架**不做**用户表、密码哈希、会话管理 —— 那些是业务，且各家差别太大。

## 1. 装 authPlugin

```ts
import { authPlugin } from '@actor/web';

// 没配密钥就不挂（很多项目本来就没有登录体系，别逼着配一个假密钥）
const secret = process.env.APP_JWT_SECRET;
plugins: [
  ...(secret === undefined || secret === ''
    ? []
    : [authPlugin({ keys: [{ algorithm: 'HS256', key: secret }], issuer: 'my-app' })]),
];
```

| 选项 | 说明 |
|---|---|
| `keys` | 校验用密钥（HMAC 密钥 / RS·ES 公钥）。可以给多把，按 `kid` 选 → **密钥轮换** |
| `algorithms` | 算法白名单（默认支持的全部；`none` **永远不在其中**） |
| `issuer` / `audience` | 校验 `iss` / `aud` |
| `required: true` | **全局**要求鉴权（默认 false：只有声明了的控制器拦） |
| `header` / `cookie` / `extractToken` | token 从哪取（默认 `Authorization: Bearer …`） |
| `rolesClaim` / `scopesClaim` | 角色/权限读哪个 claim（默认 `roles` / `scope`） |
| `verifyExtra` | 额外校验（撤销名单等）：抛错即拒绝 |
| `requireExp` | 是否要求 token 带 `exp`（**默认 true**；显式 `false` 才允许永久 token） |
| `logger` | 服务端记失败明细（**失败原因不会回给客户端**） |

**HMAC 密钥至少 32 字节**（RFC 7518）；短了 `authPlugin` 直接拒绝启动。

> **无 `exp` 的 token 默认被拒绝**：`authPlugin` 从 2026-10-29 起默认 `requireExp: true`，
> 服务端日志 reason=`missing_exp`，对外仍是 401。旧 token 请重新签发（`signJwt` 传
> `expiresInSec`）；迁移期可临时 `requireExp: false`，不要长期关闭。

> **cookie 来源的 CSRF**：用 `cookie` 取 token 时，非 GET/HEAD/OPTIONS 请求默认要求
> `x-requested-with`（双提交/自定义头，跨站表单带不上）。客户端确实无法加头时用
> `csrfHeader: false` 明确关掉，并自行加 Origin/Referer 校验。

## 2. 签发 token（你的登录接口）

```ts
import { signJwt, verifyJwt } from '@actor/web';

const login = defineController({
  input: { user: 'string', password: 'string' },
  handle: async (input, ctx) => {
    const users = ctx.get('users') as { verify(name: string, password: string): Promise<{ id: string; roles: string[] } | null> };
    const account = await users.verify(String(input.user), String(input.password));
    if (account === null) throw new HttpError(401, '用户名或密码不对');
    const token = signJwt(
      { sub: account.id, roles: account.roles, iss: 'my-app' },   // iss 放 payload（authPlugin 会校验）
      { key: { algorithm: 'HS256', key: process.env.APP_JWT_SECRET! }, expiresInSec: 3600 },
    );
    return { token };
  },
});
```

配套的还有 **refresh token**（`memoryRefreshStore` / `redisRefreshStore` + `runRefreshStoreContract`）
—— 需要"短期 access + 长期 refresh"时用，细节见 [internals/14-auth](./internals/14-auth.md)。

## 3. 保护接口：两种粒度

```ts
// 粒度一：整条路由要求已登录
const profile = defineController({
  auth: { required: true },
  handle: (_input, ctx) => ({ user: ctx.user }),
});

// 粒度二：还要求角色（不符 403，而不是 401）
const admin = defineController({
  auth: { required: true, roles: ['admin'] },
  handle: () => ({ ok: true }),
});

// 粒度三：不写 auth 声明，但手动加中间件（例如只有部分方法要）
import { requireRole, atAuth } from '@actor/web';
const report = defineController({
  middleware: [requireRole('admin', 'auditor')],
  handle: () => ({ ok: true }),
});
```

**没装 authPlugin 时**，`auth` 声明只是个声明（不拦人）—— 这符合"能力显式启用"的原则，
但**别把它当安全**：上线前用 `actor doctor` 或自查"要保护的接口是否真的装了 authPlugin"。

## 4. 状态码约定

| 情况 | 响应 |
|---|---|
| 没带 token / token 无效 / 过期 | **401** `unauthorized`（带 `WWW-Authenticate: Bearer`） |
| token 有效但角色不符 | **403** `forbidden` |
| 服务端日志 | 由 `logger` 收（`auth_failed` / `authz_failed`），**原因不回客户端** |

`ctx.user` 的结构：`{ sub, roles, scopes, claims }`（`claims` 是原始 payload，
要读自定义字段就用它）。它由 authPlugin 在 **auth 阶段** `ctx.extend` 上去。

## 5. 跑一遍（CI 真执行）

下面这段真签发 token、真请求，把 401 / 200 / 403 / 无声明不拦 四条路径都走一遍。

```js verify
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { authPlugin, defineController, defineRoutes, get, httpPlugin, signJwt } = await import(
  `${repo}packages/web/src/index.ts`
);

const SECRET = 'a-very-long-test-secret-at-least-32-bytes!!';

const routes = defineRoutes([
  // 公开
  get('/public', defineController({ handle: () => ({ public: true }) })),
  // 要登录
  get('/me', defineController({ auth: { required: true }, handle: (_input, ctx) => ({ user: ctx.user }) })),
  // 要 admin 角色
  get('/admin', defineController({ auth: { required: true, roles: ['admin'] }, handle: () => ({ admin: true }) })),
]);

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [defineModule({ name: 'app', routes })],
    plugins: [http, authPlugin({ keys: [{ algorithm: 'HS256', key: SECRET }], issuer: 'doc-test' })],
  }),
  { configDir: null, env: {} },
);
await app.start();
const base = `http://127.0.0.1:${String(http.address()?.port)}`;
const bearer = (token) => ({ authorization: `Bearer ${token}` });
try {
  const key = { algorithm: 'HS256', key: SECRET };
  const alice = signJwt({ sub: 'alice', roles: ['user'], iss: 'doc-test' }, { key, expiresInSec: 60 });
  const root = signJwt({ sub: 'root', roles: ['admin'], iss: 'doc-test' }, { key, expiresInSec: 60 });
  const expired = signJwt({ sub: 'alice', iss: 'doc-test' }, { key, expiresInSec: -10 });

  // 公开接口：谁都能进
  assert.strictEqual((await fetch(`${base}/public`)).status, 200);

  // 没带 token → 401（带 WWW-Authenticate）
  const anonymous = await fetch(`${base}/me`);
  assert.strictEqual(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') ?? '', /Bearer/i);

  // 过期 / 伪造 → 401
  assert.strictEqual((await fetch(`${base}/me`, { headers: bearer(expired) })).status, 401);
  assert.strictEqual((await fetch(`${base}/me`, { headers: bearer('not.a.jwt') })).status, 401);

  // 有效 token → 200，且 ctx.user 里有 sub / roles
  const me = await (await fetch(`${base}/me`, { headers: bearer(alice) })).json();
  assert.strictEqual(me.user.sub, 'alice');
  assert.deepStrictEqual(me.user.roles, ['user']);

  // 角色不符 → 403（已认证但无权）
  assert.strictEqual((await fetch(`${base}/admin`, { headers: bearer(alice) })).status, 403);
  assert.strictEqual((await fetch(`${base}/admin`, { headers: bearer(root) })).status, 200);
} finally {
  await app.stop();
}
console.log('ok');
```

## 6. 上线检查（安全相关，别跳过）

- [ ] **`authPlugin` 真的装了**：`actor doctor` 会检查"声明了 `@actor/web` 的 auth 但没装插件"这类不一致。
- [ ] **密钥来自环境变量**，不写进代码/镜像；用多把 `keys` 支持轮换（旧 token 不至于立刻失效）。
- [ ] **`algorithms` 收紧**到你实际用的那一种（别留一堆用不上的）。
- [ ] **生产环境别开 debug 路由**（框架默认拒绝，见 [15 实时与上传](./15-realtime-upload.md) 的诊断路由一节）。
- [ ] 5xx 与鉴权失败**要有日志**（`authPlugin.logger` + `app.on('http:error')`）。

## 7. 相关

- JWT/JWE 细节（算法白名单、refresh store、`runRefreshStoreContract`）→ [internals/14-auth](./internals/14-auth.md)
- 中间件阶段与 `ctx.extend` → [10 路由与请求](./10-http-routing.md)
- 报错排查（401 一直不过、403 突然出现）→ [19 排错手册](./19-troubleshooting.md)

## 下一步


- [14 配置与密钥](./14-config-env.md)
- [20 错误与日志](./20-errors-and-logging.md)
