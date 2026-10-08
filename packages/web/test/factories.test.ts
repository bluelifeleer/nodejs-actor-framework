import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, defineModule } from '@actor/app';

import { crudRoutes, healthRoutes } from '../src/factories.ts';
import { httpPlugin } from '../src/http.ts';
import { defineRoutes, del, get, post, put } from '../src/routes.ts';
import { defineController } from '../src/controller.ts';
import { flattenRoutes } from '../src/router.ts';
import type { CrudStore } from '../src/factories.ts';

/**
 * M9g T3：`crudRoutes` / `healthRoutes`
 *
 * 门禁两条：
 *   ① **行为等价（可证伪）**：工厂产出的路由表与手写五路由**深比较相等**（模式/方法/输入都要一致）；
 *   ② **逐项可覆盖**：给了 `opts.routes.xxx` 就只替换那一条，其余保持工厂产出。
 */

interface Note {
  id: string;
  title: string;
}

/** 演示用的内存仓储：实现 `CrudStore` 的最小形状（含冲突与不存在两种返回）。 */
function memoryStore(seed: Note[] = []): CrudStore & { notes: Note[] } {
  const notes = [...seed];
  return {
    notes,
    list: (input) => {
      const limit = Number(input['limit'] ?? 20);
      const offset = Number(input['offset'] ?? 0);
      return { items: notes.slice(offset, offset + limit), total: notes.length };
    },
    get: (id) => notes.find((note) => note.id === String(id)) ?? null,
    create: (body) => {
      const title = String(body['title'] ?? '');
      if (notes.some((note) => note.title === title)) {
        const error = new Error('duplicate') as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      const note = { id: `n${String(notes.length + 1)}`, title };
      notes.push(note);
      return note;
    },
    update: (id, body) => {
      const note = notes.find((item) => item.id === String(id));
      if (!note) return null;
      if (typeof body['title'] === 'string') note.title = body['title'];
      return note;
    },
    remove: (id) => {
      const index = notes.findIndex((item) => item.id === String(id));
      if (index < 0) return false;
      notes.splice(index, 1);
      return true;
    },
  };
}

function startWith(routes: readonly unknown[]): { app: ReturnType<typeof createApp>; http: ReturnType<typeof httpPlugin> } {
  const http = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'api', router: { routes: routes as never[] } })], plugins: [http] }),
    { configDir: null, env: {} },
  );
  return { app, http };
}

async function withApp(
  routes: readonly unknown[],
  run: (base: string) => Promise<void>,
): Promise<void> {
  const { app, http } = startWith(routes);
  await app.start();
  try {
    await run(`http://127.0.0.1:${String(http.address()?.port)}`);
  } finally {
    await app.stop();
  }
}

test('T3 crudRoutes：与手写五路由的**声明**深比较相等（模式/顺序/输入/body 全都要对上）', () => {
  const store = memoryStore();
  const factory = crudRoutes('/notes', store, { name: 'note', fields: ['title'] });
  const handwritten: unknown[] = [
    get('/notes?limit=&offset=', defineController({
      input: {
        limit: { from: 'query', type: 'number', default: 20, min: 1, max: 100 },
        offset: { from: 'query', type: 'number', default: 0, min: 0 },
      },
      handle: async (input) => store.list({ ...input }),
    })),
    get('/notes/:id', defineController({
      input: { id: { from: 'params', type: 'string', min: 1 } },
      handle: async (input) => (await store.get(input['id'])) ?? null,
    })),
    post('/notes', defineController({ input: { title: 'string' }, handle: async (input) => store.create(input) })),
    put('/notes/:id', defineController({
      input: {
        id: { from: 'params', type: 'string', min: 1 },
        title: { type: 'string', required: false },
        // 工厂会**自动**声明乐观锁参数（默认 expectedVersion，可选数字）
        expectedVersion: { type: 'number', min: 0, required: false },
      },
      handle: async (input) => store.update(input['id'], input),
    })),
    del('/notes/:id', defineController({
      input: { id: { from: 'params', type: 'string', min: 1 } },
      handle: async (input) => store.remove(input['id']),
    })),
  ];

  const factoryFlat = flattenRoutes([factory]);
  const handwrittenFlat = flattenRoutes(handwritten);
  assert.deepStrictEqual(factoryFlat.issues, [], '工厂产出不该自带问题');
  assert.deepStrictEqual(handwrittenFlat.issues, []);

  // 只比较**声明**（handler 是闭包，天然不同）：方法、模式、input、body
  const declaration = (entries: readonly (readonly unknown[])[]): unknown[] =>
    entries.map((entry) => {
      const controller = entry[2] as { input?: unknown; body?: unknown };
      return [String(entry[0]), String(entry[1]), controller.input ?? null, controller.body ?? null];
    });
  assert.deepStrictEqual(
    declaration(factoryFlat.entries),
    declaration(handwrittenFlat.entries),
    '糖产出必须与手写五路由逐字段一致（可证伪）',
  );

  // 关键细节单独钉住：PUT 是部分更新、POST 的写入字段必填、列表按查询来源组装
  assert.strictEqual((factory.routes?.[3]?.[2] as { input?: Record<string, { required?: boolean }> }).input?.['title']?.required, false);
  assert.notStrictEqual((factory.routes?.[2]?.[2] as { input?: Record<string, { required?: boolean }> }).input?.['title']?.required, false);
});

test('T3 crudRoutes：CRUD 全流程（201/200/404/409/204 + 分页）', async () => {
  const store = memoryStore([{ id: 'n1', title: 'first' }, { id: 'n2', title: 'second' }]);
  const routes = crudRoutes('/notes', store, { fields: ['title'] });
  await withApp(defineRoutes([...routes.routes!]), async (base) => {
    // list（默认分页）
    const list = await fetch(`${base}/notes`);
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(await list.json(), { items: store.notes, total: 2 });

    // list（分页生效）
    const paged = await fetch(`${base}/notes?limit=1&offset=1`);
    assert.deepStrictEqual(await paged.json(), { items: [store.notes[1]], total: 2 });

    // get 命中 / 未命中
    assert.deepStrictEqual(await (await fetch(`${base}/notes/n1`)).json(), { id: 'n1', title: 'first' });
    assert.strictEqual((await fetch(`${base}/notes/missing`)).status, 404);

    // create → 201；重复标题 → 409
    const created = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'third' }),
    });
    assert.strictEqual(created.status, 201);
    const conflict = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'third' }),
    });
    assert.strictEqual(conflict.status, 409);

    // update → 200；不存在 → 404
    const updated = await fetch(`${base}/notes/n1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    });
    assert.strictEqual(updated.status, 200);
    assert.deepStrictEqual(await updated.json(), { id: 'n1', title: 'renamed' });
    assert.strictEqual(
      (await fetch(`${base}/notes/missing`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
      404,
    );

    // delete → 204；再删 → 404
    assert.strictEqual((await fetch(`${base}/notes/n2`, { method: 'DELETE' })).status, 204);
    assert.strictEqual((await fetch(`${base}/notes/n2`, { method: 'DELETE' })).status, 404);
  });
});

test('T3 crudRoutes：逐项可覆盖（只替换给到的那一条，其余保持工厂产出）', async () => {
  const store = memoryStore([{ id: 'n1', title: 'first' }]);
  const custom = {
    list: get('/notes', () => ({ custom: true })),
  } as const;
  const routes = crudRoutes('/notes', store, { fields: ['title'], routes: custom as never });
  assert.deepStrictEqual(
    routes.routes?.map((entry) => `${String(entry[0])} ${String(entry[1])}`),
    ['GET /notes', 'GET /notes/:id', 'POST /notes', 'PUT /notes/:id', 'DELETE /notes/:id'],
  );
  await withApp(defineRoutes([...routes.routes!]), async (base) => {
    assert.deepStrictEqual(await (await fetch(`${base}/notes`)).json(), { custom: true }, '覆盖生效');
    assert.deepStrictEqual(await (await fetch(`${base}/notes/n1`)).json(), store.notes[0], '其余仍是工厂产出');
  });
});

test('T3 crudRoutes：pagination:false 时不声明分页参数（列表仍可用）', async () => {
  const store = memoryStore();
  const routes = crudRoutes('/notes', store, { pagination: false });
  const flattened = flattenRoutes([routes]);
  const list = flattened.entries.find((entry) => String(entry[1]) === '/notes');
  assert.deepStrictEqual(list?.[2] && (list[2] as { input?: unknown }).input, {});
  await withApp(defineRoutes([...routes.routes!]), async (base) => {
    assert.strictEqual((await fetch(`${base}/notes`)).status, 200);
  });
});

test('T3 crudRoutes：非法前缀在**定义期**报错（不等到启动）', () => {
  assert.throws(() => crudRoutes('notes', memoryStore()), /前缀必须以 \/ 开头/);
});

test('T3 healthRoutes：GET /health 只报告进程形状（uptime + 受管资源数）', async () => {
  await withApp(defineRoutes([...healthRoutes().routes!]), async (base) => {
    const response = await fetch(`${base}/health`);
    assert.strictEqual(response.status, 200);
    const payload = (await response.json()) as { status: string; uptimeMs: number; resources: unknown };
    assert.strictEqual(payload.status, 'ok');
    assert.ok(payload.uptimeMs >= 0);
    assert.strictEqual(payload.resources, null, '没装受管资源插件时如实返回 null（不假装 0）');
  });
});

test('T3 healthRoutes：装了受管资源时给出数量；prefix 可改', async () => {
  const http = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'api', router: { routes: [...healthRoutes({ prefix: '/status' }).routes!] as never[] } })],
      plugins: [http],
    }),
    { configDir: null, env: {} },
  );
  app.provide('@actor/resource:registry', [{ name: 'cache' }, { name: 'db' }]);
  await app.start();
  try {
    const base = `http://127.0.0.1:${String(http.address()?.port)}`;
    const payload = (await (await fetch(`${base}/status/health`)).json()) as { resources: unknown };
    assert.strictEqual(payload.resources, 2);
  } finally {
    await app.stop();
  }
});

test('T3 工厂：产出的是普通 RouterSpec（可与手写路由混在一个模块里）', async () => {
  const store = memoryStore();
  const mixed = defineRoutes([get('/ping', () => ({ pong: true })), ...crudRoutes('/notes', store).routes!]);
  await withApp(mixed, async (base) => {
    assert.deepStrictEqual(await (await fetch(`${base}/ping`)).json(), { pong: true });
    assert.strictEqual((await fetch(`${base}/notes`)).status, 200);
  });
});

test('T3 工厂：CRUD 与手写路由混用时，重复路由仍在启动期报错（校验没被绕过）', async () => {
  const store = memoryStore();
  const routes = defineRoutes([
    post('/notes', () => ({ handwritten: true })),
    ...crudRoutes('/notes', store).routes!,
  ]);
  const { app } = startWith(routes);
  await assert.rejects(() => app.start(), /路由重复/);
});

test('T3 crudRoutes：乐观锁——expectedVersion 摘出来传给 store.update，数据层冲突翻成 409', async () => {
  const calls: Array<{ id: unknown; body: Record<string, unknown>; options: unknown }> = [];
  let currentVersion = 3;
  const store: CrudStore = {
    list: () => [],
    get: () => null,
    create: () => ({}),
    update: (id, body, options) => {
      calls.push({ id, body, options });
      const expected = (options as { expectedVersion?: number } | undefined)?.expectedVersion;
      if (expected !== undefined && expected !== currentVersion) {
        const error = new Error('version mismatch') as Error & { name: string };
        error.name = 'DbConflictError';
        throw error;
      }
      currentVersion += 1;
      return { id, ...body, version: currentVersion };
    },
    remove: () => true,
  };

  const routes = crudRoutes('/notes', store, { fields: ['title'] });
  // 输入里声明了 expectedVersion（可选数字），而且它**不进 body**
  const updateRoute = routes.routes?.find((entry) => String(entry[0]) === 'PUT');
  const input = (updateRoute?.[2] as { input?: Record<string, { required?: boolean }> }).input ?? {};
  assert.strictEqual(input['expectedVersion']?.required, false, 'expectedVersion 是可选输入');
  // 它来自请求体（所以要在 body 里声明来源），但**不该**出现在 store.update 的 body 参数里
  assert.ok((updateRoute?.[2] as { body?: string[] }).body?.includes('expectedVersion'), '它来自请求体，要在 body 声明里');

  await withApp(defineRoutes([...routes.routes!]), async (base) => {
    const okUpdate = await fetch(`${base}/notes/n1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ok', expectedVersion: 3 }),
    });
    assert.strictEqual(okUpdate.status, 200, '版本对得上 → 200');
    assert.deepStrictEqual(calls.at(-1)?.options, { expectedVersion: 3 }, '第三个参数拿到期望版本');
    assert.deepStrictEqual(calls.at(-1)?.body, { title: 'ok' }, 'expectedVersion 不混进 body');

    const conflict = await fetch(`${base}/notes/n1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'stale', expectedVersion: 1 }),
    });
    assert.strictEqual(conflict.status, 409, '版本对不上 → 409（不是 500）');
    assert.match(JSON.stringify(await conflict.json()), /version_conflict/);
  });
});

test('T3 crudRoutes：onConflict 可自定义冲突响应', async () => {
  const store: CrudStore = {
    list: () => [],
    get: () => null,
    create: () => ({}),
    update: () => {
      const error = new Error('conflict') as Error & { name: string };
      error.name = 'DbConflictError';
      throw error;
    },
    remove: () => true,
  };
  const routes = crudRoutes('/notes', store, {
    fields: ['title'],
    onConflict: (info) => ({ custom: true, ...info }),
  });
  await withApp(defineRoutes([...routes.routes!]), async (base) => {
    const response = await fetch(`${base}/notes/n1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', expectedVersion: 1 }),
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { custom: true, id: 'n1', expectedVersion: 1 });
  });
});

test('T3 crudRoutes：create 抛数据层冲突错误 → 409（不用每个项目自己翻译）', async () => {
  const store: CrudStore = {
    list: () => [],
    get: () => null,
    create: () => {
      const error = new Error('duplicate key') as Error & { name: string };
      error.name = 'DbConflictError';
      throw error;
    },
    update: () => null,
    remove: () => false,
  };
  const routes = crudRoutes('/notes', store, { fields: ['title'] });
  await withApp(defineRoutes([...routes.routes!]), async (base) => {
    const response = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'dup' }),
    });
    assert.strictEqual(response.status, 409);
  });
});
