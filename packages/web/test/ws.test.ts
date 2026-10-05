import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createApp, defineApp, defineModule } from '@actor/app';

import { defineController, defineRoutes, ws, wsPlugin } from '../src/index.ts';

// 内核是 CJS：客户端辅助函数也用 createRequire 取（与 wsPlugin 内部一致）
const require = createRequire(import.meta.url);
const { connect } = require('nodejs-actor-framework/src/ops/index.ts') as {
  connect: (
    url: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    sendJson(value: unknown): void;
    nextMessage(timeoutMs?: number): Promise<{ data: unknown; isBinary: boolean }>;
    close(code?: number, reason?: string): void;
  }>;
};

test('ws: 真实连接 → 发消息 → 收回复（路径/查询/消息体输入）→ 校验失败 → 优雅停止', async () => {
  const plugin = wsPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'api',
          actors: { Room: async (msg: unknown) => ({ echo: msg }) },
          routes: defineRoutes([
            ws(
              '/chat/:room?token=',
              defineController({
                body: ['type', 'text'],
                input: {
                  room: { type: 'string' },
                  token: { type: 'string', default: 'none' },
                  type: { type: 'string' },
                  text: { type: 'string', default: '' },
                },
                handle: (input) => ({ room: input.room, token: input.token, type: input.type, text: input.text }),
              }),
            ),
          ]),
        }),
      ],
      plugins: [plugin],
    }),
    { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-ws-')), env: {} },
  );

  await app.start();
  const address = plugin.address();
  assert.ok(address && address.port > 0, 'start() 返回后应已拿到真实端口');

  const client = await connect(`ws://127.0.0.1:${String(address.port)}/chat/lobby?token=t1`);

  // 正常消息：路径参数 room、查询参数 token、消息体 type/text 三者合一
  client.sendJson({ type: 'say', text: 'hi' });
  const reply = await client.nextMessage(3000);
  assert.deepStrictEqual(JSON.parse(String(reply.data)), {
    room: 'lobby',
    token: 't1',
    type: 'say',
    text: 'hi',
  });

  // 校验失败：type 是必填（无默认值），应回 400 语义且带 issues（与 HTTP 一致）
  client.sendJson({ text: 'no type' });
  const invalid = JSON.parse(String((await client.nextMessage(3000)).data));
  assert.strictEqual(invalid.error.status, 400);
  assert.strictEqual(invalid.error.details.issues[0].path, 'type');

  // 未知路径（没有对应 WS 路由）
  const unknown = await connect(`ws://127.0.0.1:${String(address.port)}/nope`);
  unknown.sendJson({ type: 'x' });
  const notFound = JSON.parse(String((await unknown.nextMessage(3000)).data));
  assert.strictEqual(notFound.error.status, 404);
  unknown.close();

  client.close();
  await app.stop();
});
