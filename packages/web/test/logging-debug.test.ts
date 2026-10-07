import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, defineModule } from '@actor/app';
import { resourceAdapter, type ResourceAdapter } from '@actor/resource';

import { createRequestLogger, redactHeaders, redactValue, shouldRedact, toStructuredLog } from '../src/logging.ts';
import { requestLogPlugin, type RequestLogEntry } from '../src/request-log.ts';
import { debugPlugin } from '../src/debug.ts';
import { httpPlugin } from '../src/http.ts';
import { defineController, type Middleware } from '../src/controller.ts';
import { defineRoutes, get, post } from '../src/routes.ts';

test('logging: 脱敏名单覆盖授权/会话/密钥类 key（大小写、子串、嵌套、数组都要挡住）', () => {
  for (const key of ['authorization', 'Authorization', 'cookie', 'set-cookie', 'password', 'x-api-key', 'accessToken', 'refresh_token', 'client-secret', 'SESSION_ID']) {
    assert.strictEqual(shouldRedact(key), true, `${key} 应当被脱敏`);
  }
  for (const key of ['content-type', 'x-chunk-sha256', 'user-agent', 'path']) {
    assert.strictEqual(shouldRedact(key), false, `${key} 不该被脱敏`);
  }

  const redacted = redactValue({
    headers: { authorization: 'Bearer secret', 'x-api-key': 'k', accept: 'application/json' },
    body: { password: 'p', nested: { token: 't', keep: 'v' } },
    list: [{ cookie: 'c' }, 'plain'],
  }) as Record<string, never>;
  const text = JSON.stringify(redacted);
  assert.ok(!text.includes('Bearer secret') && !text.includes('"k"') && !text.includes('"p"') && !text.includes('"t"') && !text.includes('"c"'), `不该泄漏：${text}`);
  assert.ok(text.includes('application/json') && text.includes('"keep":"v"') && text.includes('plain'), '非敏感值要保留');

  const headers = redactHeaders({ cookie: 'a=b', 'user-agent': 'x' }) as Record<string, string>;
  assert.strictEqual(headers['cookie'], '[redacted]');
  assert.strictEqual(headers['user-agent'], 'x');
});

test('logging: 请求级 logger 每条带 requestId，meta 自动脱敏，child 会合并字段', () => {
  const lines: Array<{ event: string; meta: Record<string, unknown> }> = [];
  const log = createRequestLogger((event, meta) => lines.push({ event, meta: meta ?? {} }), { requestId: 'r-1' });
  log.info('用户登录', { userId: 'u1', password: '不该出现' });
  log.child({ userId: 'u2' }).warn('权限不足', { token: '不该出现' });
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0]?.meta['requestId'], 'r-1');
  assert.strictEqual(lines[0]?.meta['level'], 'info');
  assert.strictEqual(lines[0]?.meta['userId'], 'u1');
  assert.strictEqual(lines[0]?.meta['password'], '[redacted]');
  assert.strictEqual(lines[1]?.meta['userId'], 'u2');
  assert.strictEqual(lines[1]?.meta['level'], 'warn');
  assert.strictEqual(lines[1]?.meta['token'], '[redacted]');
});

test('logging: 结构化条目字段齐全且慢请求被标记', () => {
  const entry = toStructuredLog(
    { method: 'GET', path: '/x', status: 200, ms: 700, requestId: 'r-2', bytesIn: 10, bytesOut: 20, userId: 'u9' },
    { slowMs: 500 },
  );
  assert.deepStrictEqual(
    { ...entry },
    { kind: 'http_request', method: 'GET', path: '/x', status: 200, durationMs: 700, requestId: 'r-2', bytesIn: 10, bytesOut: 20, userId: 'u9', slow: true },
  );
});

test('request-log: 采样率 0 时不记普通请求，但**慢请求一定记**；结构化格式带脱敏', async () => {
  const entries: RequestLogEntry[] = [];
  const http = httpPlugin({ port: 0, logger: () => undefined });
  const app = createApp(
    defineApp({
      name: 'log-app',
      modules: [defineModule({ name: 'app', routes: defineRoutes([get('/fast', () => ({ ok: true })), get('/slow', async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true }; })]) })],
      // 注意 slowMs 要明显大于 /fast 的耗时，否则普通请求自己就变成"慢请求"了（采样就挡不住）
      plugins: [http, requestLogPlugin({ sampleRate: 0, slowMs: 15, format: 'json', onRequest: (entry) => entries.push(entry) })],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  const port = http.address()?.port as number;
  try {
    await fetch(`http://127.0.0.1:${port}/fast`);
    await fetch(`http://127.0.0.1:${port}/slow`);
    // 采样 0 → 只有慢请求那条（/slow 睡 30ms >= 15ms）
    assert.ok(entries.length >= 1, '慢请求必须被记录');
    assert.ok(entries.every((entry) => entry.path === '/slow'), `采样 0 时不该记普通请求：${JSON.stringify(entries)}`);
    const structured = toStructuredLog(entries[0] as RequestLogEntry, { slowMs: 15 });
    assert.strictEqual(structured['kind'], 'http_request');
    assert.ok(typeof structured['durationMs'] === 'number');
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

test('logging+http: 访问日志事件带 bytesIn/bytesOut/userId；ctx.log 每条带 requestId', async () => {
  const events: Array<Record<string, unknown>> = [];
  const logged: string[] = [];
  const asUser: Middleware = async (ctx, next) => {
    ctx.extend({ user: { sub: 'u1', roles: [] } });
    return next();
  };
  const http = httpPlugin({ port: 0, logger: (event) => logged.push(event) });
  const app = createApp(
    defineApp({
      name: 'fields-app',
      modules: [
        defineModule({
          name: 'app',
          routes: defineRoutes([
            post(
              '/whoami',
              defineController({
                middleware: [asUser],
                async handle(_i, ctx) {
                  const log = ctx.log as { info(message: string, meta?: Record<string, unknown>): void };
                  log.info('控制器里打日志');
                  return { ok: true };
                },
              }),
            ),
          ]),
        }),
      ],
      plugins: [http],
    }),
    { configDir: null, env: {} },
  );
  app.on('http:request', (entry: unknown) => events.push(entry as Record<string, unknown>));
  await app.start();
  const port = http.address()?.port as number;
  try {
    await fetch(`http://127.0.0.1:${port}/whoami`, { method: 'POST', body: 'hello' });
    const entry = events.find((item) => item['path'] === '/whoami');
    assert.ok(entry !== undefined);
    assert.strictEqual(entry['userId'], 'u1', '访问日志要带 userId');
    assert.strictEqual(entry['bytesIn'], 5);
    assert.ok(typeof entry['bytesOut'] === 'number' && (entry['bytesOut'] as number) > 0);
    assert.ok(logged.includes('控制器里打日志'), `ctx.log 应当走 httpPlugin 的 logger：${JSON.stringify(logged)}`);
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});

// --- 诊断路由 --------------------------------------------------------------
const probeAdapter: ResourceAdapter<{ ping(): string }> = {
  kind: 'probe',
  driverPackage: '(内置)',
  connectionKind: 'url',
  async connect() {
    return {
      client: { ping: () => 'pong' },
      healthCheck: async () => undefined,
      close: async () => undefined,
      stats: () => ({ kind: 'probe', ok: true }),
    };
  },
};

test('debug: 默认关闭（路由不存在）；开启但没 token 直接拒绝；生产环境默认拒绝', async () => {
  const closed = createApp(
    defineApp({ name: 'd0', modules: [defineModule({ name: 'app', routes: [] })], plugins: [debugPlugin(), httpPlugin({ port: 0 })] }),
    { configDir: null, env: {} },
  );
  assert.deepStrictEqual((closed.routes as readonly unknown[]).length, 0, '默认关闭时不贡献任何路由');

  assert.throws(() => debugPlugin({ enabled: true }), /至少 16 字符的 token/);

  const original = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    assert.throws(() => debugPlugin({ enabled: true, token: 'a-very-long-debug-token' }), /生产环境默认拒绝/);
    assert.doesNotThrow(() => debugPlugin({ enabled: true, token: 'a-very-long-debug-token', allowInProduction: true }));
  } finally {
    if (original === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = original;
  }
});

test('debug: 三个路由都要 token；routes/health/config 的内容符合约定', async () => {
  const http = httpPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      name: 'd1',
      modules: [defineModule({ name: 'app', routes: defineRoutes([get('/hello', () => ({ ok: true }))]) })],
      plugins: [
        resourceAdapter(probeAdapter, { name: 'probe' }),
        debugPlugin({ enabled: true, token: 'a-very-long-debug-token' }),
        http,
      ],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  const port = http.address()?.port as number;
  const base = `http://127.0.0.1:${port}`;
  try {
    // 没 token → 401（三个路由都拦）
    for (const path of ['/__debug/routes', '/__debug/health', '/__debug/config']) {
      const res = await fetch(base + path);
      assert.strictEqual(res.status, 401, `${path} 没 token 必须 401`);
    }
    const headers = { 'x-debug-token': 'a-very-long-debug-token' };

    const routes = (await (await fetch(`${base}/__debug/routes`, { headers })).json()) as { routes: Array<{ method: string; pattern: string }> };
    assert.ok(routes.routes.some((item) => item.pattern === '/hello'), `路由表要能列出应用路由：${JSON.stringify(routes.routes)}`);

    const health = (await (await fetch(`${base}/__debug/health`, { headers })).json()) as { resources: Array<{ name: string; stats: Record<string, unknown> | null }>; deep: boolean };
    assert.strictEqual(health.resources.length, 1, `受管资源注册表要能发现 probe：${JSON.stringify(health)}`);
    assert.strictEqual(health.resources[0]?.name, 'probe');
    // /__debug/health 给的是**受管资源**的 stats（状态机 + 驱动 stats），比只看驱动更全
    const stats = health.resources[0]?.stats as { state?: string; driver?: Record<string, unknown> } | null;
    assert.strictEqual(stats?.state, 'ready');
    assert.deepStrictEqual(stats?.driver, { kind: 'probe', ok: true });
    const deep = (await (await fetch(`${base}/__debug/health?check=1`, { headers })).json()) as { resources: Array<{ check?: string }> };
    assert.strictEqual(deep.resources[0]?.check, 'ok', '?check=1 要真的跑 checkHealth');

    const config = (await (await fetch(`${base}/__debug/config`, { headers })).json()) as { entries: Array<{ key: string; type: string; set: boolean; value?: unknown }> };
    assert.ok(config.entries.length > 0, `配置形状要能列出来：${JSON.stringify(config)}`);
    assert.ok(config.entries.some((entry) => entry.key.startsWith('plugins.')), `应当是 plugins.<name>.* 形状：${JSON.stringify(config.entries.slice(0, 5))}`);
    // 值**一律**打码（只出形状）
    for (const entry of config.entries) {
      assert.strictEqual(entry.value, '[redacted]', `值必须打码：${JSON.stringify(entry)}`);
    }

    // query token 也可以
    assert.strictEqual((await fetch(`${base}/__debug/routes?token=a-very-long-debug-token`)).status, 200);
    // 错 token
    assert.strictEqual((await fetch(`${base}/__debug/routes`, { headers: { 'x-debug-token': 'wrong-token-wrong-token' } })).status, 401);
  } finally {
    await app.stop({ timeoutMs: 5000 });
  }
});
