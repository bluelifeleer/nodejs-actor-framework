import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, defineModule, type ModuleSpec, type PluginSpec } from '@actor/app';

import { defineController } from '../src/controller.ts';
import { debugPlugin } from '../src/debug.ts';
import { httpPlugin } from '../src/http.ts';
import { defineWebPlugin } from '../src/plugins.ts';
import { defineRoutes, get } from '../src/routes.ts';

/**
 * M9g：debug 的**四层可见性作用域**（全局 / 路由前缀 / 模块 / 控制器）。
 *
 * 语义边界（本文件同时把它钉住）：作用域**只影响诊断输出**，不影响路由是否可用、也不改变鉴权。
 * 所以每个"被隐藏"的用例都要顺带断言"路由本身照样能用"（否则这条边界就只写在文档里）。
 */

const TOKEN = 'a-very-long-debug-token';

async function withApp(
  run: (base: string) => Promise<void>,
  modules: ModuleSpec[],
  extra: { plugins?: readonly PluginSpec[]; prefix?: string; hidePrefixes?: readonly string[] } = {},
): Promise<void> {
  const http = httpPlugin({ port: 0 });
  const debug = debugPlugin({
    enabled: true,
    token: TOKEN,
    ...(extra.prefix === undefined ? {} : { prefix: extra.prefix }),
    ...(extra.hidePrefixes === undefined ? {} : { expose: { hidePrefixes: extra.hidePrefixes } }),
  });
  const app = createApp(
    defineApp({ modules, plugins: [http, ...(extra.plugins ?? []), debug] }),
    { configDir: null, env: {} },
  );
  await app.start();
  try {
    await run(`http://127.0.0.1:${String(http.address()?.port)}`);
  } finally {
    await app.stop();
  }
}

async function routesOf(base: string, prefix = '/__debug'): Promise<string[]> {
  const response = await fetch(`${base}${prefix}/routes?token=${TOKEN}`);
  const payload = (await response.json()) as { routes: Array<{ method: string; pattern: string }> };
  return payload.routes.map((route) => `${route.method} ${route.pattern}`);
}

const ok = (): { ok: true } => ({ ok: true });
const visible = defineController({ handle: ok });
const internal = defineController({ debug: 'off', handle: ok });

test("debug 作用域：控制器层 debug:'off' 不出现在 /__debug/routes，但路由本身照样可用", async () => {
  await withApp(
    async (base) => {
      const listed = await routesOf(base);
      assert.ok(listed.includes('GET /public'), `公开路由必须在：${listed.join(', ')}`);
      assert.ok(!listed.includes('GET /internal'), `debug:'off' 的路由不该出现：${listed.join(', ')}`);
      // 语义边界：隐藏的是诊断输出，不是路由
      assert.strictEqual((await fetch(`${base}/internal`)).status, 200, '隐藏不等于下线');
    },
    [
      defineModule({
        name: 'site',
        routes: defineRoutes([get('/public', visible), get('/internal', internal)]),
      }),
    ],
  );
});

test('debug 作用域：模块层 debug.expose=false 让整棵子树消失（控制器设置不变）', async () => {
  await withApp(
    async (base) => {
      const listed = await routesOf(base);
      assert.ok(listed.includes('GET /open/x'), `未隐藏模块的路由必须在：${listed.join(', ')}`);
      assert.ok(!listed.some((item) => item.includes('/secret')), `整模块都要隐藏：${listed.join(', ')}`);
      assert.strictEqual((await fetch(`${base}/secret/x`)).status, 200, '隐藏不等于下线');
    },
    [
      defineModule({ name: 'open', routes: defineRoutes([get('/open/x', visible)]) }),
      defineModule({
        name: 'secret',
        debug: { expose: false },
        routes: defineRoutes([get('/secret/x', visible), get('/secret/y', visible)]),
      }),
    ],
  );
});

test('debug 作用域：模块层 hidePrefixes 按前缀批量隐藏（叠加在全局之上）', async () => {
  await withApp(
    async (base) => {
      const listed = await routesOf(base);
      assert.ok(listed.includes('GET /admin/keep'), `未命中的路由要留着：${listed.join(', ')}`);
      assert.ok(!listed.includes('GET /admin/audit/log'), `模块级前缀要隐藏：${listed.join(', ')}`);
      assert.strictEqual((await fetch(`${base}/admin/audit/log`)).status, 200);
    },
    [
      defineModule({
        name: 'admin',
        debug: { hidePrefixes: ['/admin/audit'] },
        routes: defineRoutes([get('/admin/keep', visible), get('/admin/audit/log', visible)]),
      }),
    ],
  );
});

test('debug 作用域：全局 expose.hidePrefixes 生效，且**不是安全边界**（门是 token）', async () => {
  await withApp(
    async (base) => {
      const listed = await routesOf(base);
      assert.ok(listed.includes('GET /notes'), `未命中的路由要留着：${listed.join(', ')}`);
      assert.ok(!listed.some((item) => item.includes('/internal')), `全局前缀要隐藏：${listed.join(', ')}`);
      assert.strictEqual((await fetch(`${base}/__debug/routes`)).status, 401, 'token 才是门');
      assert.strictEqual(
        (await fetch(`${base}/internal/x`, { headers: { 'x-debug-token': 'wrong-token-wrong-token' } })).status,
        200,
        '业务路由不受 debug 作用域影响',
      );
    },
    [defineModule({ name: 'site', routes: defineRoutes([get('/notes', visible), get('/internal/x', visible)]) })],
    { hidePrefixes: ['/internal'] },
  );
});

test('debug 作用域：自定义 prefix 时判定仍按业务路径（与 debug 挂载点无关）', async () => {
  await withApp(
    async (base) => {
      const listed = await routesOf(base, '/admin/debug');
      assert.ok(listed.includes('GET /notes'));
      assert.ok(!listed.includes('GET /internal/x'));
    },
    [defineModule({ name: 'site', routes: defineRoutes([get('/notes', visible), get('/internal/x', visible)]) })],
    { prefix: '/admin/debug', hidePrefixes: ['/internal'] },
  );
});

test('debug 作用域：插件路由（无模块归属）默认可见；模块声明不影响别人的路由', async () => {
  const pluginRoutes = defineWebPlugin({
    name: 'extra',
    framework: false,
    routes: [get('/from-plugin', visible)],
  });
  await withApp(
    async (base) => {
      const listed = await routesOf(base);
      assert.ok(listed.includes('GET /from-plugin'), `插件路由要在：${listed.join(', ')}`);
      assert.ok(!listed.includes('GET /module-secret'), `模块声明同样生效：${listed.join(', ')}`);
    },
    [
      defineModule({
        name: 'site',
        debug: { expose: false },
        routes: defineRoutes([get('/module-secret', visible)]),
      }),
    ],
    { plugins: [pluginRoutes as unknown as PluginSpec] },
  );
});
