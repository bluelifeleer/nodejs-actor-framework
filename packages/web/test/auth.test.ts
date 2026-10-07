import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { createApp, defineApp, defineModule } from '@actor/app';

import { httpPlugin } from '../src/http.ts';
import { authPlugin, requireRole } from '../src/auth/plugin.ts';
import { decodeJwt, JwtError, signJwt, verifyJwt, type JwtKey } from '../src/auth/jwt.ts';
import { defineController } from '../src/controller.ts';
import { defineRoutes, get, post } from '../src/routes.ts';

const SECRET = 'a-very-long-development-secret-0123456789'; // >= 32 字节

/** fetch 不允许设置 cookie 这类禁止头 → 用 node:http 发原始请求（这样才真的验证到 cookie 路径）。 */
function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const hmacKey = (algorithm: 'HS256' | 'HS384' | 'HS512' = 'HS256', kid?: string): JwtKey => ({ algorithm, key: SECRET, ...(kid === undefined ? {} : { kid }) });

// --- JWT 单元（离线，真加解密）---------------------------------------------
test('jwt: HS256/384/512 往返；篡改任何一段都拒绝', async () => {
  for (const algorithm of ['HS256', 'HS384', 'HS512'] as const) {
    const token = signJwt({ sub: 'u1', roles: ['admin'] }, { key: hmacKey(algorithm), expiresInSec: 60 });
    const { payload } = await verifyJwt(token, { keys: [hmacKey(algorithm)] });
    assert.strictEqual(payload.sub, 'u1');
    assert.ok(Array.isArray(payload.roles) && payload.roles.includes('admin'));

    const [header, body, signature] = token.split('.') as [string, string, string];
    // 注意 base64url 的**末位字符只有 2 位有效**（32 字节 → 43 字符），改末位解码后字节可能完全一样 →
    // 必须改**首字符**（它决定第一个字节的高 6 位），否则"篡改"根本没生效（这正是这条测试先前会偶发通过的原因）
    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    await assert.rejects(() => verifyJwt(`${header}.${body}.${flipped}`, { keys: [hmacKey(algorithm)] }), /签名/);
    const tampered = Buffer.from(JSON.stringify({ sub: 'root', roles: ['admin'] })).toString('base64url');
    await assert.rejects(() => verifyJwt(`${header}.${tampered}.${signature}`, { keys: [hmacKey(algorithm)] }), /签名/);
  }
});

test('jwt: 拒绝 alg=none 与算法混淆（白名单 + 密钥类型都对不上就拒）', async () => {
  const noneToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'root' })).toString('base64url')}.`;
  await assert.rejects(() => verifyJwt(noneToken, { keys: [hmacKey()] }), (err: unknown) => {
    assert.ok(err instanceof JwtError);
    assert.strictEqual(err.reason, 'unsupported_algorithm');
    return true;
  });

  // 用 HS256 签的 token 冒充 RS256：白名单只允许 RS256 → 拒绝
  const hs = signJwt({ sub: 'u' }, { key: hmacKey('HS256') });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(
    () => verifyJwt(hs, { keys: [{ algorithm: 'RS256', key: publicKey.export({ type: 'spki', format: 'pem' }) as string }], algorithms: ['RS256'] }),
    /不在白名单/,
  );
  // RS256 正常往返
  const rs = signJwt({ sub: 'rs' }, { key: { algorithm: 'RS256', key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }, expiresInSec: 30 });
  const verified = await verifyJwt(rs, { keys: [{ algorithm: 'RS256', key: publicKey.export({ type: 'spki', format: 'pem' }) as string }] });
  assert.strictEqual(verified.payload.sub, 'rs');
});

test('jwt: ES256 往返（原始 R||S 签名）', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const token = signJwt({ sub: 'es' }, { key: { algorithm: 'ES256', key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }, expiresInSec: 30 });
  const { payload } = await verifyJwt(token, { keys: [{ algorithm: 'ES256', key: publicKey.export({ type: 'spki', format: 'pem' }) as string }] });
  assert.strictEqual(payload.sub, 'es');
});

test('jwt: exp / nbf / iat（含 clockToleranceSec）与 iss / aud', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = signJwt({ sub: 'x', exp: now - 10 }, { key: hmacKey(), now: now - 100 });
  await assert.rejects(() => verifyJwt(expired, { keys: [hmacKey()] }), /过期/);
  // 容差之内可以通过
  const close = signJwt({ sub: 'x', exp: now - 2 }, { key: hmacKey(), now });
  await verifyJwt(close, { keys: [hmacKey()], clockToleranceSec: 5 });

  const notYet = signJwt({ sub: 'x', nbf: now + 100 }, { key: hmacKey() });
  await assert.rejects(() => verifyJwt(notYet, { keys: [hmacKey()] }), /还没生效/);

  const future = signJwt({ sub: 'x' }, { key: hmacKey(), now: now + 100 });
  await assert.rejects(() => verifyJwt(future, { keys: [hmacKey()] }), /iat 在未来/);

  const tok = signJwt({ sub: 'x', iss: 'auth.example', aud: 'api' }, { key: hmacKey() });
  await verifyJwt(tok, { keys: [hmacKey()], issuer: 'auth.example', audience: 'api' });
  await assert.rejects(() => verifyJwt(tok, { keys: [hmacKey()], issuer: 'other' }), /iss 不匹配/);
  await assert.rejects(() => verifyJwt(tok, { keys: [hmacKey()], audience: 'other' }), /aud 不匹配/);
});

test('jwt: kid 选密钥（轮换）+ verifyExtra 可拒绝（撤销）', async () => {
  const keys: JwtKey[] = [
    { algorithm: 'HS256', key: SECRET, kid: 'old' },
    { algorithm: 'HS256', key: `${SECRET}-rotated`, kid: 'new' },
  ];
  const token = signJwt({ sub: 'u', jti: 'abc' }, { key: keys[1] as JwtKey, expiresInSec: 30 });
  const { payload } = await verifyJwt(token, { keys });
  assert.strictEqual(payload.jti, 'abc');
  // 只给旧密钥 → 找不到 kid
  await assert.rejects(() => verifyJwt(token, { keys: [keys[0] as JwtKey] }), /找不到 kid/);
  // 撤销名单
  await assert.rejects(
    () => verifyJwt(token, { keys, verifyExtra: (claims) => { if (claims.jti === 'abc') throw new Error('已撤销'); } }),
    (err: unknown) => {
      assert.ok(err instanceof JwtError);
      assert.strictEqual(err.reason, 'verify_extra_failed');
      return true;
    },
  );
  // decodeJwt 不校验（名字里写明了）
  assert.strictEqual(decodeJwt(token).payload.sub, 'u');
});

// --- 插件端到端（真 HTTP）---------------------------------------------------
async function startAuthApp(options: Parameters<typeof authPlugin>[0], routes: ReturnType<typeof defineRoutes>) {
  const http = httpPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      name: 'auth-app',
      modules: [defineModule({ name: 'app', routes })],
      plugins: [authPlugin(options), http],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  const port = http.address()?.port as number;
  return { app, base: `http://127.0.0.1:${port}` };
}

test('auth plugin: 未认证 → 401 + WWW-Authenticate（且**不区分原因**）；带 token → ctx.user 可见', async () => {
  const failures: Array<Record<string, unknown>> = [];
  const { app, base } = await startAuthApp(
    { keys: [hmacKey()], logger: (event, meta) => failures.push({ event, ...(meta ?? {}) }) },
    defineRoutes([
      get('/me', defineController({ auth: { required: true }, async handle(_i, ctx) { return { user: ctx.extension('user') }; } })),
      get('/open', () => ({ ok: true })),
    ]),
  );
  try {
    const anon = await fetch(`${base}/me`);
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.headers.get('www-authenticate'), 'Bearer', '401 必须带 WWW-Authenticate（HttpError.headers 要真的落到响应上）');

    // 原因只在服务端日志里
    assert.ok(failures.some((item) => item.reason === 'missing_token'), `服务端应当记明细：${JSON.stringify(failures)}`);
    const body = (await anon.json()) as { error: { message: string } };
    assert.strictEqual(body.error.message, 'unauthorized', '对外不能暴露"缺少 token"这类细节');

    const token = signJwt({ sub: 'u1', roles: ['user'] }, { key: hmacKey(), expiresInSec: 60 });
    const ok = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(ok.status, 200);
    const payload = (await ok.json()) as { user: { sub: string; roles: string[] } };
    assert.strictEqual(payload.user.sub, 'u1');
    assert.deepStrictEqual(payload.user.roles, ['user']);

    // 未声明 auth 的路由不需要 token
    assert.strictEqual((await fetch(`${base}/open`)).status, 200);

    // 坏 token：签名/过期都回同一个 401（对外不区分）
    const bad = await fetch(`${base}/me`, { headers: { authorization: 'Bearer not-a-jwt' } });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual((await bad.json() as { error: { message: string } }).error.message, 'unauthorized');
    assert.ok(failures.some((item) => item.reason === 'malformed'), '服务端日志要有 malformed');
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('auth plugin: 角色不符 → 403；cookie 与自定义 extractor 都能取 token', async () => {
  const authLog: Array<Record<string, unknown>> = [];
  const { app, base } = await startAuthApp(
    { keys: [hmacKey()], cookie: 'access_token', logger: (event, meta) => authLog.push({ event, ...(meta ?? {}) }) },
    defineRoutes([
      get('/admin', defineController({ auth: { required: true, roles: ['admin'] }, async handle() { return { ok: 'admin' }; } })),
      post('/role-check', defineController({ middleware: [requireRole('admin')], async handle() { return { ok: true }; } })),
    ]),
  );
  try {
    const userToken = signJwt({ sub: 'u', roles: ['user'] }, { key: hmacKey(), expiresInSec: 60 });
    const forbidden = await fetch(`${base}/admin`, { headers: { authorization: `Bearer ${userToken}` } });
    assert.strictEqual(forbidden.status, 403, '已认证但角色不符 → 403');

    const adminToken = signJwt({ sub: 'a', roles: ['admin'] }, { key: hmacKey(), expiresInSec: 60 });
    const viaCookie = await rawGet(`${base}/admin`, { cookie: `access_token=${adminToken}` });
    assert.strictEqual(viaCookie.status, 200, `cookie 来源要能用：${viaCookie.body} | 服务端日志=${JSON.stringify(authLog)}`);
    assert.strictEqual((await fetch(`${base}/role-check`, { headers: { authorization: `Bearer ${adminToken}` }, method: 'POST' })).status, 200);
    assert.strictEqual((await fetch(`${base}/role-check`, { headers: { authorization: `Bearer ${userToken}` }, method: 'POST' })).status, 403);
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('auth plugin: 自定义 extractor + verifyExtra 撤销；密钥太短直接拒绝启动', async () => {
  const { app, base } = await startAuthApp(
    {
      keys: [hmacKey()],
      extractToken: (ctx) => ctx.header('x-token') ?? null,
      verifyExtra: (claims) => {
        if (claims.jti === 'revoked') throw new Error('在撤销名单里');
      },
    },
    defineRoutes([get('/me', defineController({ auth: { required: true }, async handle(_i, ctx) { return { sub: ctx.extension<{ sub?: string }>('user')?.sub }; } }))]),
  );
  try {
    const token = signJwt({ sub: 'custom', jti: 'ok' }, { key: hmacKey(), expiresInSec: 60 });
    assert.strictEqual((await fetch(`${base}/me`, { headers: { 'x-token': token } })).status, 200);
    assert.strictEqual((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401, '配了自定义 extractor 就只认它');

    const revoked = signJwt({ sub: 'custom', jti: 'revoked' }, { key: hmacKey(), expiresInSec: 60 });
    assert.strictEqual((await fetch(`${base}/me`, { headers: { 'x-token': revoked } })).status, 401);
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }

  assert.throws(() => authPlugin({ keys: [{ algorithm: 'HS256', key: 'short' }] }), /密钥太短/);
  assert.throws(() => authPlugin({ keys: [] }), /不能为空/);
});
