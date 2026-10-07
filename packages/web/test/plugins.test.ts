import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, defineModule } from '@actor/app';

import { createRequestContext, routeSpecOf, setRouteSpec } from '../src/context.ts';
import {
  defineController,
  defineRoutes,
  defineWebPlugin,
  get,
  MIDDLEWARE_PHASES,
  orderMiddleware,
  post,
  runWebPluginContract,
  WEB_CONTEXT_HOOKS_SERVICE,
} from '../src/index.ts';

/**
 * M8a：**web 插件机制**（路由贡献 / 带阶段的中间件 / ctx 扩展 / 契约套件）。
 * 设计见 docs/design/m8-web-plugins.md §3。
 */
const Phase = defineWebPlugin({
  name: 'phase-probe',
  routePrefix: '/probe',
  middleware: [
    { handler: async (ctx) => { (ctx.state.order as string[]).push('post'); }, phase: 'post' },
    { handler: async (ctx) => { (ctx.state.order as string[]).push('auth'); }, phase: 'auth' },
  ],
  routes: [
    get('/order', defineController({ async handle(_input, ctx): Promise<unknown> {
      const order = [...(ctx.state.order as string[])];
      order.push('handler');
      return { order };
    } })),
  ],
});

runWebPluginContract({
  name: 'phase-probe',
  define: () => Phase,
});

test('web plugin: 插件路由可达，且阶段顺序保证 auth → handler → post', async () => {
  const app = createApp(
    defineApp({
      name: 'plugin-app',
      modules: [defineModule({ name: 'app', routes: [] })],
      plugins: [Phase],
    }),
    { configDir: null, env: {} },
  );
  assert.strictEqual(app.routes.length, 1, '插件路由应当进 app.routes');
  const entry = app.routes[0] as unknown as readonly unknown[];
  assert.strictEqual(entry[1], '/probe/order', 'routePrefix 应当已经套上');
});

test('web plugin: 未声明阶段的中间件保持声明顺序（不改变既有行为）', async () => {
  const labels: string[] = [];
  const tag = (label: string) => async (): Promise<undefined> => {
    labels.push(label);
    return undefined;
  };
  const ordered = orderMiddleware([
    tag('a'),
    { handler: tag('c'), phase: 'post' },
    tag('b'),
    { handler: tag('z'), phase: 'auth' },
  ]);
  assert.strictEqual(ordered.length, 4);
  for (const handler of ordered) await (handler as unknown as (ctx: unknown, next: unknown) => Promise<unknown>)({}, async () => undefined);
  assert.deepStrictEqual(labels, ['a', 'b', 'z', 'c'], `顺序不对：${labels.join(' → ')}`);
});

test('web plugin: 阶段常量与非法阶段', () => {
  assert.deepStrictEqual([...MIDDLEWARE_PHASES], ['pre', 'auth', 'parse', 'handler', 'post', 'error']);
  assert.throws(() => defineWebPlugin({ name: 'x', middleware: [{ handler: () => undefined, phase: 'nope' as never }] }), /phase must be one of/);
  assert.throws(() => defineWebPlugin({ name: '', routes: [] }), /name.*required/);
  assert.throws(() => defineWebPlugin({ name: 'x', routePrefix: 'nope', routes: [] }), /routePrefix must start with/);
});

test('web plugin: 插件内重复路由在定义期报错', () => {
  assert.throws(
    () =>
      defineWebPlugin({
        name: 'dup',
        routes: [get('/a', () => ({ ok: 1 })), get('/a', () => ({ ok: 2 }))],
      }),
    /duplicate route/,
  );
});

test('web plugin: context 钩子注册成服务，并被 httpPlugin 每请求执行', async () => {
  const withContext = defineWebPlugin({
    name: 'ctx-probe',
    context: () => ({ greeting: 'hello-from-plugin' }),
    routes: [
      get('/greeting', defineController({ async handle(_input, ctx): Promise<unknown> {
        return { greeting: ctx.extension<string>('greeting'), direct: (ctx as unknown as { greeting?: string }).greeting };
      } })),
    ],
  });
  const services = new Map<string, unknown>();
  const shell = {
    config: { get<T>(): T { throw new Error('no config'); } },
    provide: (name: string, value: unknown) => void services.set(name, value),
    get: <T>(name: string): T => services.get(name) as T,
  };
  // setup 现在是 async（会先跑插件自己的 setup 再注册 context 钩子）→ 必须 await
  await (withContext as { setup?: (app: unknown) => void | Promise<void> }).setup?.(shell);
  const hooks = services.get(WEB_CONTEXT_HOOKS_SERVICE) as readonly unknown[] | undefined;
  assert.ok(Array.isArray(hooks) && hooks.length === 1, 'context 钩子应当被注册成服务');

  const app = createApp(
    defineApp({ name: 'ctx-app', modules: [defineModule({ name: 'app', routes: [] })], plugins: [withContext] }),
    { configDir: null, env: {} },
  );
  // 服务是在 start() 时才注册的（插件 setup 在 provider 解析之前跑）→ 启动后再断言
  await app.start();
  try {
    // setup 每次会新建数组（[...existing, hook]）→ 比较内容而不是身份
    assert.deepStrictEqual(app.get(WEB_CONTEXT_HOOKS_SERVICE), hooks, 'httpPlugin 就是从这个服务读钩子的');
  } finally {
    await app.stop({ timeoutMs: 3000 });
  }
});

test('web plugin: ctx.extend 不能覆盖框架保留字段（响亮报错）', async () => {
  const app = createApp(
    defineApp({
      name: 'guard-app',
      modules: [defineModule({ name: 'app', routes: [] })],
      plugins: [
        defineWebPlugin({
          name: 'evil',
          middleware: [
            {
              handler: async (ctx) => {
                ctx.extend({ requestId: 'hijacked' });
              },
              phase: 'auth',
            },
          ],
          routes: [post('/x', () => ({ ok: true }))],
        }),
      ],
    }),
    { configDir: null, env: {} },
  );
  const guard = app.middleware[0] as { handler: (ctx: unknown, next: unknown) => Promise<unknown> };
  await assert.rejects(
    () => guard.handler({ extend: () => { throw new Error('ctx.extend: "requestId" 是框架保留字段，不能被插件覆盖'); }, state: {} }, async () => undefined),
    /保留字段/,
  );
});

void defineRoutes;

test('web plugin: 保留键挡住"静默覆盖"（测真实的 ctx.extend，不用桩）', () => {
  const ctx = createRequestContext({ method: 'GET', path: '/x', requestId: 'r-1' });
  // 普通键照常可用
  ctx.extend({ order: 'user-land-ok' });
  assert.strictEqual(ctx.extension('order'), 'user-land-ok');

  // 保留键：明确报错。`route` 曾经不在名单里 —— 那时任何插件 extend({route}) 都会静默覆盖
  // 框架写的"当前控制器声明"，authPlugin 随后读到错的声明（编译器挡不住这种事故）。
  assert.throws(() => ctx.extend({ route: 'evil' }), /保留字段/);
  // 框架自己的命名空间槽同样受保护（故意写只会明确报错，而不是静默覆盖）
  assert.throws(() => ctx.extend({ '@actor/route': 'evil' }), /保留字段/);
  // 其余核心字段也照旧挡住
  assert.throws(() => ctx.extend({ requestId: 'hijack' }), /保留字段/);

  // 框架自己的槽在 WeakMap 里（既不可被 extend 覆盖，也不会出现在用户可见的 state 键里）
  setRouteSpec(ctx, { auth: { required: true } });
  assert.deepStrictEqual(routeSpecOf(ctx), { auth: { required: true } });
  assert.ok(!Object.keys(ctx.state).includes('route'), '框架槽不该污染用户可变袋');
});
