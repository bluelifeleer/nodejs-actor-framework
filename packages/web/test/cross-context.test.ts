import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createApp, defineApp, defineModule } from '@actor/app';

import {
  defineController,
  defineRoutes,
  httpPlugin,
  post,
  ws,
  wsPlugin,
  type WsConnections,
} from '../src/index.ts';

const require = createRequire(import.meta.url);
const { connect } = require('nodejs-actor-framework/src/ops/index.ts') as {
  connect: (
    url: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    sendJson(value: unknown): void;
    nextMessage(timeoutMs?: number): Promise<{ data: unknown }>;
    close(code?: number, reason?: string): void;
  }>;
};

test('cross-context: 同一服务内 HTTP 请求经注册表推送给已连接的 WS 客户端（游戏/大屏场景）', async () => {
  const http = httpPlugin({ port: 0 });
  const wsEntry = wsPlugin({ port: 0 });

  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'realtime',
          routes: defineRoutes([
            // WS 端点（连接会被登记进注册表；路径由路由表匹配）
            ws('/events', () => ({ ok: true })),
            // HTTP 入口：把消息推给所有在线连接
            post(
              '/broadcast',
              defineController({
                body: ['type', 'value'],
                input: { type: { type: 'string' }, value: { type: 'number' } },
                handle: (input, ctx) => {
                  const connections = ctx.get('wsConnections') as WsConnections;
                  const sent = connections.broadcast({ type: input.type, value: input.value });
                  return { sent, ids: connections.ids().length };
                },
              }),
            ),
          ]),
        }),
      ],
      plugins: [http, wsEntry],
    }),
    { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-ctx-')), env: {} },
  );

  await app.start();
  const httpPort = http.address()?.port;
  const wsPort = wsEntry.address()?.port;
  assert.ok(httpPort && wsPort, 'HTTP 与 WS 应各就绪');

  // 一个真实 WS 客户端连上（尚未发消息，只等推送）
  const client = await connect(`ws://127.0.0.1:${String(wsPort)}/events`);

  // HTTP 请求触发推送给该客户端
  const response = await fetch(`http://127.0.0.1:${String(httpPort)}/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'score', value: 42 }),
  });
  assert.strictEqual(response.status, 200);
  const payload = (await response.json()) as { sent: number; ids: number };
  assert.strictEqual(payload.ids, 1, '注册表里应有 1 个连接');
  assert.strictEqual(payload.sent, 1, '应推送给 1 个连接');

  // 客户端真的收到了（跨上下文的关键证据）
  const pushed = JSON.parse(String((await client.nextMessage(3000)).data));
  assert.deepStrictEqual(pushed, { type: 'score', value: 42 });

  client.close();
  await app.stop();
});
