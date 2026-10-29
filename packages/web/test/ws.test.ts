import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createApp, defineApp, defineModule } from '@actor/app';

import { defineController, defineMiddleware, defineRoutes, httpPlugin, reply, ws, wsPlugin } from '../src/index.ts';

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


test('ws: 每条消息走同一套中间件链（全局 → 路由 → 控制器），可短路', async () => {
  const order: string[] = [];
  const tag = (name: string) =>
    defineMiddleware(async (ctx, next) => {
      order.push(`${name}:before`);
      (ctx.state as Record<string, unknown>)[name] = true;
      const result = await next();
      order.push(`${name}:after`);
      return result;
    });
  const deny = defineMiddleware(() => reply.json({ error: 'denied' }, { status: 401 }));

  const plugin = wsPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      middleware: [tag('global')],
      modules: [
        defineModule({
          name: 'ws2',
          routes: defineRoutes([
            ws('/ok', defineController({ middleware: [tag('controller')], handle: (_i, ctx) => ({ state: Object.keys(ctx.state).sort() }) }), [tag('route')]),
            ws('/deny', () => ({ unreachable: true }), [deny]),
          ]),
        }),
      ],
      plugins: [plugin],
    }),
    { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-ws2-')), env: {} },
  );
  await app.start();
  const port = plugin.address()?.port;

  const okClient = await connect(`ws://127.0.0.1:${String(port)}/ok`);
  okClient.sendJson({ type: 'hi' });
  const okReply = JSON.parse(String((await okClient.nextMessage(3000)).data));
  assert.deepStrictEqual(okReply, { state: ['controller', 'global', 'route'] });
  assert.deepStrictEqual(order, [
    'global:before',
    'route:before',
    'controller:before',
    'controller:after',
    'route:after',
    'global:after',
  ]);
  okClient.close();

  // 短路：路由级中间件直接返回响应，控制器不执行
  const denyClient = await connect(`ws://127.0.0.1:${String(port)}/deny`);
  denyClient.sendJson({ type: 'hi' });
  const denied = JSON.parse(String((await denyClient.nextMessage(3000)).data));
  assert.deepStrictEqual(denied, { error: 'denied' });
  denyClient.close();

  await app.stop();
});

test('ws: 畸形百分号编码的 URL 不会打崩进程（回归：一条消息曾触发 unhandled rejection）', async () => {
  const plugin = wsPlugin({ port: 0 });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'api',
          routes: defineRoutes([
            ws(
              '/chat/:room',
              defineController({
                body: ['type'],
                input: { room: { type: 'string' }, type: { type: 'string' } },
                handle: (input) => ({ room: input.room, type: input.type }),
              }),
            ),
          ]),
        }),
      ],
      plugins: [plugin],
    }),
    { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-ws-bad-url-')), env: {} },
  );

  await app.start();
  const address = plugin.address();
  assert.ok(address && address.port > 0);

  const bad = await connect(`ws://127.0.0.1:${String(address.port)}/chat/%E0%A4%A`);
  bad.sendJson({ type: 'say' });
  const response = JSON.parse(String((await bad.nextMessage(3000)).data));
  assert.strictEqual(response.error.status, 400, '畸形 URL 应回 400，而不是让进程退出');

  // 进程还在：同一个应用仍能服务一条正常连接
  const ok = await connect(`ws://127.0.0.1:${String(address.port)}/chat/lobby`);
  ok.sendJson({ type: 'say' });
  assert.deepStrictEqual(JSON.parse(String((await ok.nextMessage(3000)).data)), { room: 'lobby', type: 'say' });

  ok.close();
  bad.close();
  await app.stop();
});

test('ws: 共享 HTTP 端口时按实际绑定地址执行安全守卫（回归：曾绕过非回环检查）', async () => {
  const make = (wsOptions: Parameters<typeof wsPlugin>[0]) => {
    const http = httpPlugin({ host: '0.0.0.0', port: 0 });
    const ws = wsPlugin(wsOptions);
    const app = createApp(
      defineApp({ modules: [defineModule({ name: 'api', routes: [] })], plugins: [http, ws] }),
      { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-ws-shared-')), env: {} },
    );
    return { app, ws };
  };

  const guarded = make({});
  await assert.rejects(
    () => guarded.app.start(),
    (err: unknown) => err instanceof Error && /refusing to bind the websocket server/.test(err.message),
    '共享 0.0.0.0 的 HTTP 端口时，WS 也必须拒绝无 TLS/verifyClient 的入口',
  );
  await guarded.app.stop().catch(() => undefined);

  const allowed = make({ allowInsecureBinding: true });
  await allowed.app.start();
  assert.ok(allowed.ws.address()?.port !== undefined, '显式 allowInsecureBinding 后应能启动');
  await allowed.app.stop();
});

test('ws: 同一连接的消息串行处理，identify 设置 playerId（回归）', async () => {
  const plugin = wsPlugin({
    port: 0,
    identify: (req) => (String(req?.url ?? '').includes('alice') ? 'alice' : null),
  });
  const seen: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'api',
          routes: defineRoutes([
            ws('/chat/:room', defineController({
              body: ['n'],
              input: { room: { type: 'string' }, n: { type: 'number' } },
              async handle(input) {
                seen.push(input.n as number);
                if (seen.length === 1) await gate;
                return { n: input.n };
              },
            })),
          ]),
        }),
      ],
      plugins: [plugin],
    }),
    { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-ws-queue-')), env: {} },
  );
  await app.start();
  const address = plugin.address();
  assert.ok(address && address.port > 0);
  const client = await connect(`ws://127.0.0.1:${String(address.port)}/chat/alice`);
  try {
    const connections = app.get('wsConnections') as { byPlayer(id: string): unknown[] };
    assert.strictEqual(connections.byPlayer('alice').length, 1, 'identify 应把连接归到 playerId 下');

    client.sendJson({ n: 1 });
    client.sendJson({ n: 2 });
    client.sendJson({ n: 3 });
    // 第一条被 gate 卡住：如果并发处理，seen 会立刻变成 [1,2,3]
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(seen, [1], '同一连接必须串行（后一条要等前一条完成）');
    release();
    const replies = [];
    for (let index = 0; index < 3; index += 1) replies.push(JSON.parse(String((await client.nextMessage(3000)).data)));
    assert.deepStrictEqual(replies.map((reply) => reply.n), [1, 2, 3], '回复顺序必须与发送顺序一致');
  } finally {
    client.close();
    await app.stop();
  }
});
