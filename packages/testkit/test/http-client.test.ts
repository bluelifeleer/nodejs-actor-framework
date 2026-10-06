import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import { createHttpClient } from '../src/index.ts';

test('http client: 解析 JSON、断言状态码、失败时把响应体带进错误', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/ok') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hello: 'world' }));
      return;
    }
    if (request.url === '/created') {
      response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'x' }));
      return;
    }
    if (request.url === '/text') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('not json');
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: '炸了' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = createHttpClient(base);

  try {
    const ok = await client.get<{ hello: string }>('/ok');
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body, { hello: 'world' });
    client.expect(200, ok);

    assert.strictEqual((await client.post('/created', { a: 1 })).status, 201);
    assert.strictEqual(await client.json<string>('GET', '/text'), null, '非 JSON 响应 body 为 null（text 仍可用）');

    const failed = await client.get('/boom');
    assert.strictEqual(failed.status, 500);
    assert.throws(() => client.expect(200, failed), /期望 HTTP 200，实际 500.*炸了/s, '错误里要带响应体');
    await assert.rejects(() => client.json('GET', '/boom').then(() => client.expect(200, failed)));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('http client: 超时会明确失败（不是无限等）', async () => {
  const server = http.createServer(() => {
    /* 故意不回复 */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await assert.rejects(() => createHttpClient(base).get('/never', { timeoutMs: 50 }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
