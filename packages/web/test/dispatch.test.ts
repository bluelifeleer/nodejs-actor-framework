import { test } from 'node:test';
import assert from 'node:assert';

import {
  HttpError,
  buildRouteTable,
  defineController,
  dispatch,
  get,
  post,
  reply,
} from '../src/index.ts';

const routes = buildRouteTable([
  get(
    '/rooms/:id?verbose=',   // 规则 3：input 里的 verbose 必须在模式里声明（路径参数或查询参数）
    defineController({
      input: { id: { type: 'number', min: 1 }, verbose: { type: 'boolean', default: false } },
      handle: (input, ctx) => ({ id: input.id, verbose: input.verbose, requestId: ctx.requestId }),
    }),
  ),
  get('/rooms?limit=', defineController({ input: { limit: { type: 'number', default: 10 } }, handle: () => ({ ok: true }) })),
  post('/join', defineController({ handle: () => reply.json({ joined: true }, { status: 201 }) })),
  get('/text', () => reply.text('plain')),
  get('/bytes', () => reply.protobuf(new Uint8Array([1, 2]))),
  get('/empty', () => undefined),
  get('/boom', () => {
    throw new HttpError(409, 'conflict!', { reason: 'duplicate' });
  }),
  get('/leak', () => {
    throw new Error('db password hunter2');
  }),
]).routes;

test('dispatch: 200 + JSON，路径/查询参数按 input schema 校验并转成正确类型', async () => {
  const hit = await dispatch({ routes, request: { method: 'GET', url: '/rooms/42?verbose=true' } });
  assert.strictEqual(hit.status, 200);
  assert.strictEqual(hit.response.contentType, 'application/json; charset=utf-8');
  const payload = JSON.parse(String(hit.response.body));
  assert.strictEqual(payload.id, 42, 'id 应被转成 number');
  assert.strictEqual(payload.verbose, true, 'verbose 应被转成 boolean');
  assert.match(String(payload.requestId), /^r-/, '每个请求都应有 requestId');
});

test('dispatch: 400 校验失败一次性报出全部问题（与配置校验同一格式）', async () => {
  const bad = await dispatch({ routes, request: { method: 'GET', url: '/rooms/0?verbose=maybe' } });
  assert.strictEqual(bad.status, 400);
  const payload = JSON.parse(String(bad.response.body));
  assert.strictEqual(payload.error.status, 400);
  const paths = payload.error.details.issues.map((i: { path: string }) => i.path).sort();
  assert.deepStrictEqual(paths, ['id', 'verbose']);
});

test('dispatch: 404（无路由）与 405（方法不匹配，带 Allow 头）', async () => {
  const notFound = await dispatch({ routes, request: { method: 'GET', url: '/nope' } });
  assert.strictEqual(notFound.status, 404);
  assert.strictEqual(notFound.matched, false);

  const wrongMethod = await dispatch({ routes, request: { method: 'DELETE', url: '/rooms/1' } });
  assert.strictEqual(wrongMethod.status, 405);
  assert.strictEqual(wrongMethod.response.headers.Allow, 'GET');
});

test('dispatch: 返回形态（text / protobuf / 201 / 204）', async () => {
  const text = await dispatch({ routes, request: { method: 'GET', url: '/text' } });
  assert.strictEqual(text.response.contentType, 'text/plain; charset=utf-8');
  assert.strictEqual(text.response.body, 'plain');

  const bytes = await dispatch({ routes, request: { method: 'GET', url: '/bytes' } });
  assert.strictEqual(bytes.response.contentType, 'application/x-protobuf');
  assert.deepStrictEqual(bytes.response.body, new Uint8Array([1, 2]));

  const created = await dispatch({ routes, request: { method: 'POST', url: '/join' } });
  assert.strictEqual(created.status, 201);

  const empty = await dispatch({ routes, request: { method: 'GET', url: '/empty' } });
  assert.strictEqual(empty.status, 204);
  assert.strictEqual(empty.response.body, null);
});

test('dispatch: HttpError 精确控制状态码；未捕获异常 500 且不泄露内部细节', async () => {
  const conflict = await dispatch({ routes, request: { method: 'GET', url: '/boom' } });
  assert.strictEqual(conflict.status, 409);
  assert.match(String(conflict.response.body), /conflict!/);
  assert.match(String(conflict.response.body), /duplicate/);

  const leaked = await dispatch({ routes, request: { method: 'GET', url: '/leak' } });
  assert.strictEqual(leaked.status, 500);
  assert.strictEqual(String(leaked.response.body).includes('hunter2'), false);
});

test('dispatch: 函数式控制器直接拿到已声明的输入（未声明的查询参数不进入校验）', async () => {
  const hit = await dispatch({ routes, request: { method: 'GET', url: '/rooms?limit=5&unexpected=1' } });
  assert.strictEqual(hit.status, 200);
  assert.deepStrictEqual(JSON.parse(String(hit.response.body)), { ok: true });
});

test('dispatch: 5xx 必须通过 onError 暴露给服务端（4xx 是业务语义，不报）', async () => {
  const seen: Array<{ requestId: string; route?: string; status: number }> = [];
  const onError = (error: unknown, info: { requestId: string; route?: { path: string }; status: number }) => {
    seen.push({ requestId: info.requestId, ...(info.route === undefined ? {} : { route: info.route.path }), status: info.status });
    assert.ok(error instanceof Error);
  };

  // 控制器里抛普通异常 → 500，且必须被 onError 看见
  const crashRoutes = buildRouteTable([
    get('/crash', () => {
      throw new TypeError('boom');
    }),
  ]).routes;
  const crashed = await dispatch({
    routes: crashRoutes,
    request: { method: 'GET', url: '/crash', headers: {} },
    onError,
  });
  assert.strictEqual(crashed.status, 500);
  assert.strictEqual(seen.length, 1, '5xx 没有被上报（服务端将完全没有线索）');
  assert.strictEqual(seen[0].status, 500);
  assert.strictEqual(seen[0].route, '/crash');

  // 业务语义的 4xx（HttpError）不该触发 onError
  const conflictRoutes = buildRouteTable([
    get('/conflict', () => {
      throw new HttpError(409, 'conflict!');
    }),
  ]).routes;
  const conflicted = await dispatch({
    routes: conflictRoutes,
    request: { method: 'GET', url: '/conflict', headers: {} },
    onError,
  });
  assert.strictEqual(conflicted.status, 409);
  assert.strictEqual(seen.length, 1, '4xx 不该被当成服务端错误上报');
});
