import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, defineApp, defineModule } from '@actor/app';

import { defineController, defineRoutes, get, httpPlugin, reply } from '../src/index.ts';

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-web-http-'));
}

function makeApp(routes: ReturnType<typeof defineRoutes>, extra = {}) {
  const plugin = httpPlugin({ port: 0, shutdownTimeoutMs: 3000, ...extra });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'api',
          routes,
          actors: { Room: async (msg: { type: string; id?: number }) => ({ joined: msg.id ?? 0 }) },
        }),
      ],
      plugins: [plugin],
    }),
    { configDir: tempConfigDir(), env: {} },
  );
  return { app, plugin };
}

// 说明（历史）：这里曾经挂着一条 TODO，写着"这两个用例当前失败、原因未定位"。
// 审计核实它们**早已通过**（`node --test packages/web/test/http.test.ts` → 2/2），
// 那条注释会让下一个人去修一个不存在的问题 —— 过时注释比没有注释更糟，所以删掉、只留下这段记录。
test('http: 真实请求走通（200 JSON / 404 / 405 带 Allow），start() 返回即端口就绪', async () => {
  const { app, plugin } = makeApp(
    defineRoutes([
      get(
        '/rooms/:id',
        defineController({
          input: { id: { type: 'number', min: 1 } },
          handle: async (input, ctx) => {
            const room = ctx.actor('Room') as { ask: (m: unknown) => Promise<unknown> };
            const joined = await room.ask({ type: 'join', id: input.id });
            return { ...joined, requestId: ctx.requestId, ua: ctx.headers('user-agent') ?? null };
          },
        }),
      ),
      get('/text', () => reply.text('plain')),
    ]),
  );

  await app.start();
  const address = plugin.address();
  assert.ok(address && address.port > 0, 'start() 返回后应已拿到真实端口');
  const base = `http://127.0.0.1:${String(address.port)}`;

  const ok = await fetch(`${base}/rooms/42`, { headers: { 'user-agent': 'actor-test' } });
  assert.strictEqual(ok.status, 200);
  assert.match(String(ok.headers.get('x-request-id')), /^r-/, '响应头应回写 requestId（便于跨日志追踪）');
  assert.match(String(ok.headers.get('content-type')), /application\/json/);
  const payload = (await ok.json()) as { joined: number; requestId: string; ua: string };
  assert.strictEqual(payload.joined, 42, '路径参数应被转成 number 并交给 Actor');
  assert.match(payload.requestId, /^r-/);
  assert.strictEqual(payload.ua, 'actor-test', '请求头应可读');

  const text = await fetch(`${base}/text`);
  assert.strictEqual(text.status, 200);
  assert.strictEqual(await text.text(), 'plain');

  const missing = await fetch(`${base}/nope`);
  assert.strictEqual(missing.status, 404);

  const wrongMethod = await fetch(`${base}/text`, { method: 'DELETE' });
  assert.strictEqual(wrongMethod.status, 405);
  assert.strictEqual(wrongMethod.headers.get('allow'), 'GET');

  await app.stop();
});

test('http: 优雅停止——在途请求先完成，之后不再接受新连接', async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, plugin } = makeApp(
    defineRoutes([
      get(
        '/slow/:id',
        defineController({
          input: { id: { type: 'number' } },
          handle: async () => {
            await gate;
            return { done: true };
          },
        }),
      ),
    ]),
  );

  await app.start();
  const base = `http://127.0.0.1:${String(plugin.address()?.port)}`;

  const inFlight = fetch(`${base}/slow/1`);
  await new Promise((resolve) => setTimeout(resolve, 100)); // 确保请求已进入服务端
  const stopping = app.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  release?.(); // 放行在途请求

  const response = await inFlight;
  assert.strictEqual(response.status, 200, '在途请求应被完成，而不是被中断');
  assert.deepStrictEqual(await response.json(), { done: true });
  await stopping;

  await assert.rejects(() => fetch(`${base}/slow/1`), '停止后不应再接受新请求');
});

test('http: 访问日志出口抛错不会二次 writeHead / 打崩进程（回归）', async () => {
  const plugin = httpPlugin({ port: 0, shutdownTimeoutMs: 3000 });
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'api', routes: defineRoutes([get('/ok', () => ({ ok: true }))]) })],
      plugins: [plugin],
    }),
    {
      configDir: tempConfigDir(),
      env: {},
      logging: {
        logger: (_family: string, event: string) => {
          if (event === 'http:request') throw new Error('logger down');
        },
      },
    },
  );

  await app.start();
  const address = plugin.address();
  assert.ok(address && address.port > 0);
  const res = await fetch(`http://127.0.0.1:${String(address.port)}/ok`);
  assert.strictEqual(res.status, 200, '日志失败不应改变已经成功的响应');
  assert.deepStrictEqual(await res.json(), { ok: true });

  // 进程仍在：还能继续服务下一次请求
  const again = await fetch(`http://127.0.0.1:${String(address.port)}/ok`);
  assert.strictEqual(again.status, 200);
  await app.stop();
});

test('http: 端口被占用时 start() 必须拒绝，而不是让进程崩溃（回归）', async () => {
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
  const occupied = (blocker.address() as { port: number }).port;

  const plugin = httpPlugin({ port: occupied, shutdownTimeoutMs: 1000 });
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'api', routes: defineRoutes([get('/ok', () => ({ ok: true }))]) })],
      plugins: [plugin],
    }),
    { configDir: tempConfigDir(), env: {} },
  );

  await assert.rejects(
    () => app.start(),
    (err: unknown) => err instanceof Error && /EADDRINUSE/.test(err.message),
    'start() 应把监听失败如实抛出',
  );
  await app.stop().catch(() => undefined);
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
});
