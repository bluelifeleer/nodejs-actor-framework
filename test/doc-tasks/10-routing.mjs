/**
 * 任务脚本 ①：只看 [10 路由与请求](../..//docs/guide/10-http-routing.md) 就能跑通的最小服务。
 *
 * 断言覆盖那一页的规则：路径参数/查询参数/请求体按声明取到、校验失败 400、方法不对 405、未知路径 404。
 */
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { HttpError, defineController, defineRoutes, del, get, httpPlugin, post } = await import(`${repo}packages/web/src/index.ts`);

const notes = {
  create: defineController({
    body: ['title'],
    input: { title: { type: 'string', min: 1 } },
    handle: (input) => ({ id: 1, title: String(input.title) }),
  }),
  detail: defineController({
    input: { id: { type: 'number', min: 1 } },
    handle: (input) => {
      if (Number(input.id) !== 1) throw new HttpError(404, 'note not found');
      return { id: 1, title: 'first' };
    },
  }),
  list: defineController({
    input: { limit: { type: 'number', default: 20, min: 1, max: 100 } },
    handle: (input) => ({ limit: Number(input.limit) }),
  }),
};

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'notes',
        routes: defineRoutes([
          get('/notes?limit=', notes.list),
          post('/notes', notes.create),
          get('/notes/:id', notes.detail),
          del('/notes/:id', () => undefined),
        ]),
      }),
    ],
    plugins: [http],
  }),
  { configDir: '', env: {}, kernel: { logger: false } },
);

await app.start();
try {
  const base = `http://127.0.0.1:${String(http.address()?.port)}`;
  const json = (path, init) => fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...init });

  assert.strictEqual((await json('/notes?limit=5')).status, 200);
  assert.deepStrictEqual(await (await json('/notes?limit=5')).json(), { limit: 5 }, '查询参数按声明转成 number');
  assert.strictEqual((await json('/notes?limit=999')).status, 400, '超出 max → 400');

  const created = await json('/notes', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
  assert.strictEqual(created.status, 200);
  assert.deepStrictEqual(await created.json(), { id: 1, title: 'x' });
  assert.strictEqual((await json('/notes', { method: 'POST', body: JSON.stringify({}) })).status, 400, '缺必填 → 400');

  assert.deepStrictEqual(await (await json('/notes/1')).json(), { id: 1, title: 'first' }, '路径参数按声明转成 number');
  assert.strictEqual((await json('/notes/abc')).status, 400, ':id 声明为 number，给字符串 → 400');
  assert.strictEqual((await json('/notes/2')).status, 404, 'HttpError(404) 直接映射');
  assert.strictEqual((await json('/notes/1', { method: 'POST' })).status, 405, '方法不对 → 405（不是 404）');
  assert.strictEqual((await json('/nope')).status, 404);

  console.log('task-routing-ok');
} finally {
  await app.stop();
}
