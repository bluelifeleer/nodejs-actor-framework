import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, defineApp, defineModule } from '@actor/app';

import { defineRoutes, get, httpPlugin, requestLogPlugin, type RequestLogEntry } from '../src/index.ts';

test('requestLogPlugin: 经事件总线拿到每次请求（方法/路径/状态/耗时/requestId），订阅者抛错不影响请求', async () => {
  const entries: RequestLogEntry[] = [];
  const plugin = requestLogPlugin({
    onRequest: (entry) => {
      entries.push(entry);
      throw new Error('订阅者故意抛错：不应影响请求');
    },
  });

  const app = createApp(
    defineApp({
      modules: [
        defineModule({ name: 'm', routes: defineRoutes([get('/ok', () => ({ ok: true }))]) }),
      ],
      // 内置访问日志关掉，验证"插件形态"这条路径
      plugins: [httpPlugin({ port: 0, accessLog: false }), plugin],
    }),
    { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-log-')), env: {} },
  );

  await app.start();
  const port = (app.get('httpServer') as { address(): { port: number } }).address().port;

  assert.strictEqual((await fetch(`http://127.0.0.1:${String(port)}/ok`)).status, 200);
  assert.strictEqual((await fetch(`http://127.0.0.1:${String(port)}/nope`)).status, 404);

  // 事件在响应之后发布，轮询等待（但不假设顺序）
  for (let i = 0; i < 50 && entries.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(entries.length, 2, '应收到两条请求事件');
  assert.deepStrictEqual(entries.map((e) => e.status).sort(), [200, 404]);
  assert.deepStrictEqual(entries.map((e) => e.path).sort(), ['/nope', '/ok']);
  assert.ok(entries.every((e) => /^r-/.test(e.requestId)), '每条都应有 requestId');
  assert.ok(entries.every((e) => typeof e.ms === 'number' && e.ms >= 0));
  assert.ok(entries.every((e) => e.method === 'GET'));

  await app.stop();
});

test('requestLogPlugin: enabled=false 时不输出，但请求照常工作', async () => {
  const entries: RequestLogEntry[] = [];
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'm2', routes: defineRoutes([get('/ok', () => ({ ok: true }))]) })],
      plugins: [httpPlugin({ port: 0, accessLog: false }), requestLogPlugin({ enabled: false, onRequest: (e) => entries.push(e) })],
    }),
    { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-log2-')), env: {} },
  );
  await app.start();
  const port = (app.get('httpServer') as { address(): { port: number } }).address().port;
  assert.strictEqual((await fetch(`http://127.0.0.1:${String(port)}/ok`)).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(entries, []);
  await app.stop();
});
