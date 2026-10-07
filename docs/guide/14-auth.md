# 鉴权与 JWT（authPlugin）

`authPlugin()`（`@actor/web`）做三件事：**取 token**（Bearer / cookie / 自定义）→ **校验 JWT** →
把用户放进 `ctx.user`。零依赖，只用 `node:crypto`。

```ts
import { authPlugin, httpPlugin, signJwt } from '@actor/web';

export default defineApp({
  modules: [myModule],
  plugins: [
    authPlugin({
      keys: [{ algorithm: 'HS256', key: process.env.JWT_SECRET! }],   // HMAC 密钥 >= 32 字节，否则**拒绝启动**
      issuer: 'auth.example',
      audience: 'api',
      clockToleranceSec: 5,                 // 默认 0（不偷偷放宽）
      logger: (event, meta) => console.warn('[auth]', event, meta),   // 失败明细只到这里
    }),
    httpPlugin({ port: 3000 }),
  ],
});
```

需要鉴权的路由显式声明（**只有声明了才拦**）：

```ts
get('/me',    defineController({ auth: { required: true },           async handle(_i, ctx) { return { user: ctx.user }; } }));
get('/admin', defineController({ auth: { required: true, roles: ['admin'] }, async handle() { return { ok: true }; } }));
```

## 语义（都写进了测试）

| 情况 | 响应 |
|---|---|
| 需要鉴权但没带 token | **401** + `WWW-Authenticate: Bearer` |
| token 坏（签名/过期/iss/aud/撤销） | **401**（**对外一律同一句 `unauthorized`**，原因只进服务端日志 —— 防探测） |
| 已认证但角色不符 | **403** |
| 没声明 `auth` 的路由 | 放行（带了 token 也会校验并设置 `ctx.user`，但不会因为没带而拒绝） |

## 支持与明确拒绝

- **支持**：`HS256/384/512`（HMAC，**常量时间比较**）、`RS256/384/512`、`ES256/384`；
  `exp`/`nbf`/`iat` + 时钟容差；`iss`/`aud`；`kid` 多密钥（轮换：新 token 用新 kid，旧 token 还能验）；
  `verifyExtra` 钩子做撤销/黑名单。
- **明确拒绝**：`alg: none`（JWT 最经典的坑 —— 默认就不接受）、不在白名单里的 alg、算法混淆
  （白名单限定 + 密钥类型不匹配即拒）。

```js verify
import { signJwt, verifyJwt, decodeJwt, JwtError } from '@actor/web';

const key = { algorithm: 'HS256', key: 'a-very-long-development-secret-0123456789' }; // >= 32 字节

// 签发 + 校验往返
const token = signJwt({ sub: 'u1', roles: ['admin'] }, { key, expiresInSec: 60 });
const { payload } = await verifyJwt(token, { keys: [key] });
console.log('sub =', payload.sub, '| roles =', payload.roles);
if (payload.sub !== 'u1') throw new Error('往返失败');

// 只解码不校验（名字里写明了）
console.log('decodeJwt（不校验）→', decodeJwt(token).payload.sub);

// 篡改 payload → 拒绝
const [header, , signature] = token.split('.');
const tampered = `${header}.${Buffer.from(JSON.stringify({ sub: 'root' })).toString('base64url')}.${signature}`;
try {
  await verifyJwt(tampered, { keys: [key] });
  throw new Error('篡改竟然通过了');
} catch (err) {
  if (!(err instanceof JwtError)) throw err;
  console.log('篡改被拒 →', err.reason);
}

// alg=none → 拒绝
const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
try {
  await verifyJwt(none, { keys: [key] });
  throw new Error('alg=none 竟然通过了');
} catch (err) {
  if (!(err instanceof JwtError)) throw err;
  console.log('alg=none 被拒 →', err.reason);
}
```

## 角色：两种写法

```ts
// ① 在控制器上声明（authPlugin 直接处理，403）
defineController({ auth: { required: true, roles: ['admin'] }, ... });

// ② 作为中间件（自带 phase: 'auth'，所以一定跑在 authPlugin 之后）
defineRoutes([get('/x', controller, [requireRole('admin')])]);
```

> 中间件阶段由框架保证：`pre → auth → parse → handler → post → error`。
> 你自己写的中间件若要在 auth 阶段跑，写成 `{ handler, phase: 'auth' }`（或给函数加 `phase` 属性）——
> 别靠声明顺序，默认阶段是 `pre`。

## 加密 JWT（JWE）

签名保证**没被改**，但不保证**看不到内容**（JWS 的 payload 只是 base64）。要藏内容就上 JWE。
框架只支持两种**常见且安全**的组合，其它组合**显式拒绝**（不假装支持）：

| alg | enc | 密钥 |
|---|---|---|
| `RSA-OAEP-256` | `A256GCM` | PEM 公钥加密 / 私钥解密，可按 `kid` 轮换 |
| `dir` | `A256GCM` | 32 字节共享密钥 |

推荐**嵌套**：先签后加（`JWS in JWE`）—— 解密后再验签，两头都占。

```js verify
import { encryptJwe, decryptToJws, signJwt, verifyJwt, JweError } from '@actor/web';

const signKey = { algorithm: 'HS256', key: 'a-very-long-development-secret-0123456789' };
const encKey = { alg: 'dir', key: Buffer.alloc(32, 7) };

const jws = signJwt({ sub: 'u1', roles: ['admin'] }, { key: signKey, expiresInSec: 60 });
const jwe = encryptJwe(jws, { key: encKey, typ: 'JWT' });
console.log('JWE 段数 =', jwe.split('.').length);
if (jwe.includes('admin')) throw new Error('加密后不该看到内层声明');

const back = decryptToJws(jwe, { keys: [encKey] });
const { payload } = await verifyJwt(back, { keys: [signKey] });
console.log('解出并验签 →', payload.sub, payload.roles);

try {
  encryptJwe('x', { key: { alg: 'RSA-OAEP', key: '' } });
  throw new Error('不支持的组合竟然通过了');
} catch (err) {
  if (!(err instanceof JweError)) throw err;
  console.log('不支持的组合被拒 →', err.message);
}
```

## 逃生通道与后续

- `ctx.user = { sub, roles, scopes, claims }`（`claims` 是原始声明 ✓ **claims 是声明，不是授权**：真正授权看 `roles`/`scopes` 或你自己的策略）；
- 撤销/黑名单：`verifyExtra` 里查（配合 `@actor/redis`），框架不内建；
- JWE 见上一节（`encryptJwe`/`decryptJwe`/`decryptToJws`）；
- refresh token（不透明串 + 轮换 + 重放即整族撤销）在 M8c3 提供。
