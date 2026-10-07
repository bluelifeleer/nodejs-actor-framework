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
