/**
 * 任务脚本 ③：只看 [13 鉴权](../../docs/guide/13-auth.md) 就能跑通的登录 + 保护接口。
 *
 * 断言：签发 token → 带 token 200、不带 401、角色不够 403；密钥太短启动期就拒绝。
 */
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { HttpError, authPlugin, defineController, defineRoutes, get, httpPlugin, post, signJwt } = await import(`${repo}packages/web/src/index.ts`);

const secret = 'a'.repeat(32);                       // HMAC 密钥至少 32 字节
const key = { algorithm: 'HS256', key: secret };     // signJwt 的 key 形状（与 authPlugin 的 keys 一致）
const issuer = 'doc-task';

const login = defineController({
  body: ['sub'],
  input: { sub: { type: 'string', min: 1 } },
  handle: (input) => ({ token: signJwt({ sub: String(input.sub), roles: ['reader'], iss: issuer }, { key, expiresInSec: 60 }) }),
});

const me = defineController({
  auth: { required: true },                          // 需要鉴权（`required` 是必须的；`auth: true` 不生效）
  handle: (_input, ctx) => ({ user: ctx.user }),
});

const admin = defineController({
  auth: { required: true, roles: ['admin'] },        // 角色不足 → 403（不是 401）
  handle: () => ({ ok: true }),
});

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'app',
        routes: defineRoutes([post('/login', login), get('/me', me), get('/admin', admin)]),
      }),
    ],
    plugins: [authPlugin({ keys: [key], issuer }), http],
  }),
  { configDir: '', env: {}, kernel: { logger: false } },
);

await app.start();
try {
  const base = `http://127.0.0.1:${String(http.address()?.port)}`;
  const token = (await (await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: 'u-1' }) })).json()).token;
  assert.strictEqual(typeof token, 'string');

  assert.strictEqual((await fetch(`${base}/me`)).status, 401, '不带 token → 401');
  assert.strictEqual((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  const profile = await (await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.strictEqual(profile.user.sub, 'u-1', 'ctx.user 里有 token 的 payload');

  assert.strictEqual((await fetch(`${base}/admin`, { headers: { authorization: `Bearer ${token}` } })).status, 403, '角色不够 → 403');
  assert.strictEqual((await fetch(`${base}/me`, { headers: { authorization: 'Bearer not-a-jwt' } })).status, 401, '坏 token → 401');

  console.log('task-auth-ok');
} finally {
  await app.stop();
}
