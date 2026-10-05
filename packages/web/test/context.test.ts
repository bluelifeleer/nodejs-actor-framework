import { test } from 'node:test';
import assert from 'node:assert';

import { HttpError, createRequestContext, reply, toErrorResponse, toResponse } from '../src/index.ts';

const ctx = (extra: Partial<Parameters<typeof createRequestContext>[0]> = {}) =>
  createRequestContext({
    method: 'GET',
    path: '/rooms',
    requestId: 'r-1',
    query: { page: '2', q: 'hello' },
    params: { id: '42' },
    headers: { accept: 'application/json', 'x-tag': ['a', 'b'] },
    ...extra,
  });

test('ctx: 访问器两种写法等价（qs/params/headers）', () => {
  const c = ctx();
  assert.strictEqual(c.qs('page'), '2');
  assert.strictEqual(c.qs().get('page'), '2');
  assert.deepStrictEqual(c.qs().all(), { page: '2', q: 'hello' });
  assert.ok(c.qs().has('page'));
  assert.strictEqual(c.qs().has('nope'), false);
  assert.strictEqual(c.qs('nope'), undefined);

  assert.strictEqual(c.params('id'), '42');
  assert.strictEqual(c.params().get('id'), '42');
  assert.deepStrictEqual(c.params().all(), { id: '42' });

  // 请求头大小写不敏感；重复头保留数组；header() 取第一个
  assert.deepStrictEqual(c.headers('X-Tag'), ['a', 'b']);
  assert.deepStrictEqual(c.headers().get('x-tag'), ['a', 'b']);
  assert.strictEqual(c.headers('Accept'), 'application/json');
  assert.strictEqual(c.header('x-tag'), 'a');
  assert.strictEqual(c.header('missing'), undefined);
});

test('ctx: 未接线的能力给出明确错误，而不是静默 undefined', () => {
  const c = ctx();
  assert.throws(() => c.actor('Room'), /ctx\.actor 尚未接线/);
  assert.throws(() => c.get('leaderboard'), /ctx\.get 尚未接线/);
});

test('response: 默认形态由返回值决定（对象→JSON 200，字符串→text，buffer→octet-stream，undefined→204）', () => {
  const asJson = toResponse({ ok: true });
  assert.strictEqual(asJson.status, 200);
  assert.strictEqual(asJson.contentType, 'application/json; charset=utf-8');
  assert.strictEqual(asJson.body, '{"ok":true}');

  const asText = toResponse('hi');
  assert.strictEqual(asText.contentType, 'text/plain; charset=utf-8');
  assert.strictEqual(asText.body, 'hi');

  const asBuffer = toResponse(new Uint8Array([1, 2, 3]));
  assert.strictEqual(asBuffer.contentType, 'application/octet-stream');
  assert.deepStrictEqual(asBuffer.body, new Uint8Array([1, 2, 3]));

  const empty = toResponse(undefined);
  assert.strictEqual(empty.status, 204);
  assert.strictEqual(empty.body, null);
});

test('response: 显式指定状态码与内容类型（json/text/html/buffer/protobuf/send）', () => {
  const created = reply.json({ id: 1 }, { status: 201 });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body, '{"id":1}');

  assert.strictEqual(reply.text('p').contentType, 'text/plain; charset=utf-8');
  assert.strictEqual(reply.html('<h1>hi</h1>').contentType, 'text/html; charset=utf-8');
  assert.strictEqual(reply.buffer(new Uint8Array()).contentType, 'application/octet-stream');
  assert.strictEqual(reply.protobuf(new Uint8Array()).contentType, 'application/x-protobuf');

  const custom = reply.send('<x/>', { status: 202, contentType: 'application/xml', headers: { 'x-trace': 't' } });
  assert.strictEqual(custom.status, 202);
  assert.strictEqual(custom.contentType, 'application/xml');
  assert.deepStrictEqual(custom.headers, { 'x-trace': 't' });

  // 显式返回优先于隐式推断
  assert.strictEqual(toResponse(reply.html('<b/>')).contentType, 'text/html; charset=utf-8');
});

test('errors: HttpError 精确控制状态码，未捕获异常不泄露内部信息', () => {
  const notFound = toErrorResponse(new HttpError(404, 'room not found', { room: 'x' }));
  assert.strictEqual(notFound.status, 404);
  assert.match(String(notFound.body), /room not found/);
  assert.match(String(notFound.body), /"room":"x"/);

  const timeout = new Error('actor did not answer');
  timeout.name = 'AskTimeoutError';
  const asTimeout = toErrorResponse(timeout);
  assert.strictEqual(asTimeout.status, 504);
  assert.match(String(asTimeout.body), /did not answer in time/);

  const boom = new Error('database password is hunter2');
  const as500 = toErrorResponse(boom);
  assert.strictEqual(as500.status, 500);
  assert.strictEqual(
    String(as500.body).includes('hunter2'),
    false,
    '500 响应不得泄露内部错误细节（只进日志）',
  );
});
