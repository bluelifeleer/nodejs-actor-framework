import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, defineApp, defineModule } from '@actor/app';

import {
  HttpError,
  buildRouteTable,
  defineController,
  defineMiddleware,
  defineRoutes,
  dispatch,
  get,
  httpPlugin,
  reply,
} from '../src/index.ts';

test('middleware: 顺序（全局 → 路由 → 控制器）、after-logic 逆序、ctx.state 可见', async () => {
  const order: string[] = [];
  const around = (name: string) =>
    defineMiddleware(async (ctx, next) => {
      order.push(`${name}:before`);
      (ctx.state as Record<string, unknown>)[name] = true;
      const result = await next();
      order.push(`${name}:after`);
      return result;
    });

  const { routes } = buildRouteTable([
    get(
      '/x',
      defineController({
        middleware: [around('controller')],
        handle: (_input, ctx) => {
          order.push('handle');
          return { state: Object.keys(ctx.state).sort() };
        },
      }),
      [around('route')],
    ),
  ]);

  const result = await dispatch({
    routes,
    request: { method: 'GET', url: '/x' },
    middleware: [around('global')],
  });

  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(order, [
    'global:before',
    'route:before',
    'controller:before',
    'handle',
    'controller:after',
    'route:after',
    'global:after',
  ]);
  assert.deepStrictEqual(JSON.parse(String(result.response.body)), { state: ['controller', 'global', 'route'] });
});

test('middleware: 短路（不调用 next() 直接返回响应）与抛 HttpError', async () => {
  const deny = defineMiddleware(() => reply.json({ error: 'unauthorized' }, { status: 401 }));
  const boom = defineMiddleware(() => {
    throw new HttpError(403, 'forbidden by policy');
  });
  let handlerCalled = 0;
  const handler = () => {
    handlerCalled += 1;
    return { ok: true };
  };

  const shortCircuit = buildRouteTable([get('/a', handler, [deny])]).routes;
  const denied = await dispatch({ routes: shortCircuit, request: { method: 'GET', url: '/a' } });
  assert.strictEqual(denied.status, 401);
  assert.strictEqual(handlerCalled, 0, '短路后不应进入控制器');

  const thrown = buildRouteTable([get('/b', handler, [boom])]).routes;
  const forbidden = await dispatch({ routes: thrown, request: { method: 'GET', url: '/b' } });
  assert.strictEqual(forbidden.status, 403);
  assert.match(String(forbidden.response.body), /forbidden by policy/);
  assert.strictEqual(handlerCalled, 0);

  // 无中间件时行为不变
  const plain = buildRouteTable([get('/c', handler)]).routes;
  assert.strictEqual((await dispatch({ routes: plain, request: { method: 'GET', url: '/c' } })).status, 200);
  assert.strictEqual(handlerCalled, 1);
});

test('middleware: 中间件在输入校验之前运行（鉴权可先拒绝），且校验失败仍是 400', async () => {
  const order: string[] = [];
  const auth = defineMiddleware(async (ctx, next) => {
    order.push('auth');
    if (!ctx.headers('authorization')) throw new HttpError(401, 'no token');
    return next();
  });
  const routes = buildRouteTable([
    // 规则 3：input 的键必须来自路径/查询参数（或 body 声明），所以这里写成 ?id=
    get('/me?id=', defineController({ input: { id: { type: 'number', min: 1 } }, handle: () => ({ ok: true }) }), [auth]),
  ]).routes;

  // 未带 token → 401（校验不会先跑）
  const unauthorized = await dispatch({ routes, request: { method: 'GET', url: '/me?id=1' } });
  assert.strictEqual(unauthorized.status, 401);
  assert.deepStrictEqual(order, ['auth']);

  // 带 token 但 id 非法 → 400（校验仍生效）
  const invalid = await dispatch({
    routes,
    request: { method: 'GET', url: '/me?id=0', headers: { authorization: 'Bearer t' } },
  });
  assert.strictEqual(invalid.status, 400);
});

test('middleware: next() 只能调用一次（重复调用报错，避免难以排查的双重执行）', async () => {
  const twice = defineMiddleware(async (_ctx, next) => {
    await next();
    return next();
  });
  const routes = buildRouteTable([get('/x', () => ({ ok: true }), [twice])]).routes;
  const result = await dispatch({ routes, request: { method: 'GET', url: '/x' } });
  assert.strictEqual(result.status, 500);
  assert.match(String(result.response.body), /internal error/);
});

test('middleware: 模块级 defineModule({ middleware }) 真的生效（全局 → 模块 → 路由 → 控制器）', async () => {
  const order: string[] = [];
  const tag = (name: string) =>
    defineMiddleware(async (_ctx, next) => {
      order.push(`${name}:before`);
      const result = await next();
      order.push(`${name}:after`);
      return result;
    });

  // 应用层把 `defineModule({ middleware })` 编译成"该模块根路由器带中间件"（子树语义），
  // 再与全局/路由/控制器三级合并 —— 这里走**完整链路**（装配 → 路由表 → 真实 HTTP 请求）。
  const http = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({
      middleware: [tag('global')],
      modules: [
        defineModule({
          name: 'game',
          middleware: [tag('module')],
          routes: defineRoutes([
            get(
              '/x',
              defineController({ middleware: [tag('controller')], handle: () => ({ ok: true }) }),
              [tag('route')],
            ),
          ]),
        }),
      ],
      plugins: [http],
    }),
    { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-module-mw-')), env: {} },
  );

  await app.start();
  try {
    const port = http.address()?.port;
    assert.ok(port, 'HTTP 入口应已就绪');
    const response = await fetch(`http://127.0.0.1:${String(port)}/x`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { ok: true });
  } finally {
    await app.stop();
  }

  assert.deepStrictEqual(order, [
    'global:before',
    'module:before',
    'route:before',
    'controller:before',
    'controller:after',
    'route:after',
    'module:after',
    'global:after',
  ]);
});
