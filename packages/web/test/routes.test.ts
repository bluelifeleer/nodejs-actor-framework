import { test } from 'node:test';
import assert from 'node:assert';

import { buildRouteTable, defineRoutes, get, matchRoute, parsePattern, post } from '../src/index.ts';

const handler = async () => ({ ok: true });

test('routes: 路径参数（:id）——匹配、取值、URL 解码', () => {
  const { routes, issues } = buildRouteTable([get('/rooms/:id', handler)]);
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(routes[0]?.path, '/rooms/:id');

  const hit = matchRoute(routes, { method: 'GET', url: '/rooms/42' });
  assert.strictEqual(hit.kind, 'matched');
  if (hit.kind === 'matched') {
    assert.deepStrictEqual(hit.params, { id: '42' });
    assert.deepStrictEqual(hit.query, {});
  }

  const encoded = matchRoute(routes, { method: 'GET', url: '/rooms/a%20b' });
  assert.strictEqual(encoded.kind, 'matched');
  if (encoded.kind === 'matched') assert.deepStrictEqual(encoded.params, { id: 'a b' });
});

test('routes: 查询参数（?id=）——不参与路径匹配，未声明的查询参数照常可读', () => {
  const { routes } = buildRouteTable([get('/rooms?id=', handler)]);
  assert.strictEqual(routes[0]?.path, '/rooms');
  assert.deepStrictEqual(routes[0]?.queryParams, ['id']);

  const hit = matchRoute(routes, { method: 'GET', url: '/rooms?id=42' });
  assert.strictEqual(hit.kind, 'matched');
  if (hit.kind === 'matched') assert.deepStrictEqual(hit.query, { id: '42' });

  // 规则 1：?id= 只声明"会读取"，未声明的 other 仍能匹配并读到
  const extra = matchRoute(routes, { method: 'GET', url: '/rooms?other=1' });
  assert.strictEqual(extra.kind, 'matched');
  if (extra.kind === 'matched') assert.deepStrictEqual(extra.query, { other: '1' });

  // 缺参数也能匹配（是否必填由 input schema 决定）
  assert.strictEqual(matchRoute(routes, { method: 'GET', url: '/rooms' }).kind, 'matched');
});

test('routes: 路径参数与查询参数混用', () => {
  const { routes, issues } = buildRouteTable([get('/rooms/:id/players?limit=&cursor=', handler)]);
  assert.deepStrictEqual(issues, []);
  assert.deepStrictEqual(routes[0]?.pathParams, ['id']);
  assert.deepStrictEqual(routes[0]?.queryParams, ['limit', 'cursor']);

  const hit = matchRoute(routes, { method: 'GET', url: '/rooms/7/players?limit=10' });
  assert.strictEqual(hit.kind, 'matched');
  if (hit.kind === 'matched') {
    assert.deepStrictEqual(hit.params, { id: '7' });
    assert.deepStrictEqual(hit.query, { limit: '10' });
  }
  assert.strictEqual(matchRoute(routes, { method: 'GET', url: '/rooms/7' }).kind, 'not_found');
});

test('routes: 规则 2 —— 同 method 同路径的重复注册（查询声明不参与匹配）', () => {
  const { issues } = buildRouteTable([get('/rooms?id=', handler), get('/rooms?room=', handler)]);
  assert.strictEqual(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /路由重复：GET \/rooms/);
  assert.match(issues[0]?.message ?? '', /把参数放进路径/);
});

test('routes: 规则 3 —— input 的键必须来自路径参数或已声明的查询参数', () => {
  const { issue } = parsePattern('GET', '/rooms', { input: { roomId: { type: 'string' } }, handle: handler });
  assert.match(issue?.message ?? '', /input 声明了 'roomId'/);
  assert.match(issue?.message ?? '', /请写成 \/:roomId 或 \?roomId=/);

  const ok = parsePattern('GET', '/rooms?roomId=', { input: { roomId: { type: 'string' } }, handle: handler });
  assert.strictEqual(ok.issue, undefined);
});

test('routes: 405（方法不匹配，带 Allow）与 404（路径不存在）', () => {
  const { routes } = buildRouteTable([get('/rooms', handler), post('/rooms', handler)]);
  const wrong = matchRoute(routes, { method: 'DELETE', url: '/rooms' });
  assert.strictEqual(wrong.kind, 'method_not_allowed');
  if (wrong.kind === 'method_not_allowed') assert.deepStrictEqual([...wrong.allow].sort(), ['GET', 'POST']);
  assert.strictEqual(matchRoute(routes, { method: 'GET', url: '/nope' }).kind, 'not_found');
});

test('routes: 末尾斜杠与非法模式', () => {
  const { routes } = buildRouteTable([get('/rooms/', handler)]);
  assert.strictEqual(routes[0]?.path, '/rooms');
  assert.strictEqual(matchRoute(routes, { method: 'GET', url: '/rooms' }).kind, 'matched');

  assert.match(parsePattern('GET', 'rooms', handler).issue?.message ?? '', /必须以 \/ 开头/);
  assert.match(parsePattern('GET', '/rooms/:', handler).issue?.message ?? '', /缺少名字/);
  assert.match(parsePattern('GET', '/rooms/a:id', handler).issue?.message ?? '', /必须独占一段/);
});

test('routes: defineRoutes 保留声明顺序', () => {
  const entries = defineRoutes([get('/a', handler), post('/b', handler)]);
  assert.deepStrictEqual(
    entries.map(([method, pattern]) => `${method} ${pattern}`),
    ['GET /a', 'POST /b'],
  );
});
