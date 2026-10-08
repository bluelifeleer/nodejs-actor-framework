import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, defineModule } from '@actor/app';

import { defineController, inputSchemaOf, inputSourcesOf, type ControllerSpec } from '../src/controller.ts';
import { httpPlugin } from '../src/http.ts';
import { atAuth, atHandler, atPost, atPre } from '../src/middleware.ts';
import { defineWebPlugin, orderMiddleware } from '../src/plugins.ts';
import { defineRoutes, get, post, put } from '../src/routes.ts';

/**
 * M9f T2：**输入声明合一** 与 **中间件阶段简写**
 *
 * 门禁一律用"糖产出与长名写法**深比较相等**（可证伪）"：
 * 只要糖与全量写法漂移，这里的断言立刻红 —— 而不是靠"看起来能用"。
 */

function startApp(routes: readonly unknown[]): { app: ReturnType<typeof createApp>; http: ReturnType<typeof httpPlugin> } {
  const http = httpPlugin({ port: 0 });
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'm', routes: routes as never[] })], plugins: [http] }),
    { configDir: null, env: {} },
  );
  return { app, http };
}

test('T2 输入：简写展开与全量写法**深比较相等**（含自动补 body）', () => {
  const sugared = defineController({
    input: { filename: 'string', size: 'int', verbose: 'bool', tags: ['x'] },
    handle: () => undefined,
  });
  const verbose = defineController({
    input: {
      filename: { type: 'string' },
      size: { type: 'number' },
      verbose: { type: 'boolean' },
      tags: { type: 'json', default: ['x'] },
    },
    body: ['filename', 'size', 'verbose', 'tags'],
    handle: () => undefined,
  });
  assert.deepStrictEqual(
    { input: sugared.input, body: [...(sugared.body ?? [])].sort() },
    { input: verbose.input, body: [...(verbose.body ?? [])].sort() },
    '糖产出必须与手写全量写法一致（body 也是自动补齐的）',
  );
  assert.deepStrictEqual(
    [...inputSourcesOf(sugared)],
    [
      ['filename', 'body'],
      ['size', 'body'],
      ['verbose', 'body'],
      ['tags', 'body'],
    ],
    '不带 from 的输入默认来自 body',
  );
});

test('T2 输入：字符串简写覆盖四种类型（int/number、bool/boolean 别名）', () => {
  const spec = defineController({
    input: {
      a: 'string',
      b: 'int',
      c: 'number',
      d: 'bool',
      e: 'boolean',
      f: 'json',
      g: ['a'],
    },
    handle: () => undefined,
  });
  const schema = inputSchemaOf(spec) as Record<string, { type?: string } | undefined>;
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, value?.type])),
    { a: 'string', b: 'number', c: 'number', d: 'boolean', e: 'boolean', f: 'json', g: 'json' },
    '别名与类型要一一对应（int/number → number、bool/boolean → boolean）',
  );
});

test('T2 输入：from 声明保留（query / params），来源表与 schema 分离', () => {
  const spec = defineController({
    input: {
      id: { from: 'params', type: 'string', min: 1 },
      limit: { from: 'query', type: 'number', default: 20 },
      keyword: { from: 'query' },
      title: 'string',
    },
    handle: () => undefined,
  });
  assert.deepStrictEqual(
    [...inputSourcesOf(spec)],
    [
      ['id', 'params'],
      ['limit', 'query'],
      ['keyword', 'query'],
      ['title', 'body'],
    ],
  );
  const schema = inputSchemaOf(spec) as Record<string, unknown>;
  assert.deepStrictEqual(schema['limit'], { type: 'number', default: 20 }, 'from 不进 schema（只留字段约束）');
  assert.deepStrictEqual(schema['keyword'], { type: 'string' }, '只写 from = 必填字符串');
  assert.deepStrictEqual(schema['title'], { type: 'string' });
  assert.deepStrictEqual(spec.body, ['title'], '来自 body 的键被自动补进 body');
});

test('T2 输入：端到端——默认从 body 取；显式 from 不被同名 body/query 顶掉', async () => {
  const routes = defineRoutes([
    post(
      '/notes',
      defineController({
        input: { title: 'string', tags: ['x'] },
        handle: (input) => ({ title: input.title, tags: input.tags }),
      }),
    ),
    get(
      '/search?keyword=&limit=',
      defineController({
        input: { keyword: { from: 'query', type: 'string' }, limit: { from: 'query', type: 'number', default: 10 } },
        handle: (input) => ({ keyword: input.keyword, limit: input.limit }),
      }),
    ),
    put(
      '/notes/:id',
      defineController({
        input: { id: { from: 'params', type: 'string' }, title: 'string' },
        handle: (input) => ({ id: input.id, title: input.title }),
      }),
    ),
  ]);
  const { app, http } = startApp(routes);
  await app.start();
  try {
    const base = `http://127.0.0.1:${String(http.address()?.port)}`;

    const created = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hello', tags: ['a'] }),
    });
    assert.strictEqual(created.status, 200);
    assert.deepStrictEqual(await created.json(), { title: 'hello', tags: ['a'] });

    const searched = await fetch(`${base}/search?keyword=kw&limit=5`);
    assert.deepStrictEqual(await searched.json(), { keyword: 'kw', limit: 5 });

    const defaulted = await fetch(`${base}/search?keyword=only`);
    assert.deepStrictEqual(await defaulted.json(), { keyword: 'only', limit: 10 }, '缺省值来自 schema 默认值');

    const updated = await fetch(`${base}/notes/42`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', id: 'spoofed' }),
    });
    assert.deepStrictEqual(await updated.json(), { id: '42', title: 't' }, 'params 优先于 body 里的同名键');

    const bad = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(bad.status, 400);
    const payload = (await bad.json()) as { error: { message: string; details: { issues: unknown[] } } };
    assert.strictEqual(payload.error.message, 'input validation failed');
    assert.ok(Array.isArray(payload.error.details.issues));
  } finally {
    await app.stop();
  }
});

test('T2 输入：既有写法（手写 body + 全量 input）零回归', async () => {
  const routes = defineRoutes([
    post(
      '/legacy',
      defineController({
        body: ['filename', 'size'],
        input: { filename: { type: 'string', min: 1 }, size: { type: 'number' } },
        handle: (input) => input,
      }),
    ),
  ]);
  const { app, http } = startApp(routes);
  await app.start();
  try {
    const base = `http://127.0.0.1:${String(http.address()?.port)}`;
    const ok = await fetch(`${base}/legacy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'f', size: 3 }),
    });
    assert.deepStrictEqual(await ok.json(), { filename: 'f', size: 3 });
  } finally {
    await app.stop();
  }
});

test('T2 中间件阶段：`atAuth(fn)` 与 `{ handler: fn, phase: \'auth\' }` 排序结果一致', () => {
  const label = (name: string): (() => void) => {
    const fn = (): void => undefined;
    Object.defineProperty(fn, 'label', { value: name });
    return fn;
  };
  const order = (chain: readonly unknown[]): string[] =>
    orderMiddleware(chain).map((item) => String((item as { label?: unknown }).label));

  // 简写：阶段即函数名（`atPost(fn)` 会给 fn 包一层并把阶段记在包装上 —— 所以标签查那层包装）
  const phases = [atPost, atPre, atAuth] as const;
  const names = ['p', 'a', 'h'];
  const sugared = order([
    ...phases.map((tag, index) => {
      const wrapped = tag(label(names[index] as string));
      Object.defineProperty(wrapped, 'label', { value: names[index] });
      return wrapped;
    }),
    label('q'),
  ]);
  // 全量：同一批阶段，写成 { handler, phase }
  const verbose = order([
    { handler: label('p'), phase: 'post' },
    { handler: label('a'), phase: 'pre' },
    { handler: label('h'), phase: 'auth' },
    label('q'),
  ]);
  assert.deepStrictEqual(sugared, verbose, '简写与全量写法的排序结果必须一致（可证伪）');
  // 声明顺序是 post, pre, auth, 无阶段 → 排序后 pre → 无阶段 → auth → post
  assert.deepStrictEqual(verbose, ['a', 'q', 'h', 'p'], '阶段顺序由框架保证（与声明顺序无关）');

  const short = atAuth(label('x'), 'auth-mw');
  assert.strictEqual(typeof short, 'function');
  assert.strictEqual((short as { phase?: string }).phase, 'auth');
  assert.strictEqual((short as { name?: string }).name, 'auth-mw', 'name 只影响诊断显示');
});

test('T2 中间件阶段：端到端执行顺序与全量写法一致（含 post 阶段的后置展开）', async () => {
  const trace: string[] = [];
  const routes = defineRoutes([
    get(
      '/trace',
      defineController({
        middleware: [
          atAuth(async (_ctx, next) => {
            trace.push('auth');
            return next();
          }),
          atPost(async (_ctx, next) => {
            const value = await next();
            trace.push('post');
            return value;
          }),
          atPre(async (_ctx, next) => {
            trace.push('pre');
            return next();
          }),
        ],
        handle: () => ({ ok: true }),
      }),
    ),
  ]);
  const { app, http } = startApp(routes);
  await app.start();
  try {
    const base = `http://127.0.0.1:${String(http.address()?.port)}`;
    assert.deepStrictEqual(await (await fetch(`${base}/trace`)).json(), { ok: true });
    assert.deepStrictEqual(trace, ['pre', 'auth', 'post'], '阶段顺序由框架保证（不靠声明顺序）');
  } finally {
    await app.stop();
  }
});

test('T2 中间件阶段：非法项仍在启动期被拒（简写不能绕过校验）', () => {
  // 不是函数也不是 { handler, phase } 的项
  assert.throws(() => orderMiddleware([{ phase: 'auth' } as never]), /unsupported item/);
  assert.throws(() => orderMiddleware(['nope' as never]), /unsupported item/);
  // 阶段名拼错在**定义期**就被 defineWebPlugin 拒（orderMiddleware 只做排序，不负责校验声明）
  assert.throws(
    () => defineWebPlugin({ name: 'bad', middleware: [{ handler: () => undefined, phase: 'atuh' as never }] }),
    /phase must be one of/,
  );
});

test('T2：ControllerSpec 类型上 body 由输入声明推导（文档与实现一致）', () => {
  const spec: ControllerSpec = defineController({ input: { a: 'string' }, handle: () => undefined });
  assert.deepStrictEqual(spec.body, ['a']);
});
