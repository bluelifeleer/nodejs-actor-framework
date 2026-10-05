import { test } from 'node:test';
import assert from 'node:assert';

import { buildRouteTable, defineRoutes, get, matchRoute, normalizeMethod, parsePattern, post } from '../src/index.ts';

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
  // 规则 3 现在也接受"显式声明来自请求体"的字段，提示文案随之更新
  assert.match(issue?.message ?? '', /请写成 \/:roomId、\?roomId= 或 body: \['roomId'\]/);

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


test('routes: 方法归一化——小写/带空白可用，未知方法在启动期报错（不再静默失效）', () => {
  assert.strictEqual(normalizeMethod(' get '), 'GET');
  assert.strictEqual(normalizeMethod('Options'), 'OPTIONS');
  assert.strictEqual(normalizeMethod('FETCH'), null);

  // 小写注册（JS 侧常见）应可用，且结果与大写一致
  const lower = buildRouteTable([['get', '/x', handler] as never]);
  assert.deepStrictEqual(lower.issues, []);
  assert.strictEqual(lower.routes[0]?.method, 'GET');
  assert.strictEqual(matchRoute(lower.routes, { method: 'GET', url: '/x' }).kind, 'matched');

  // 未知方法：启动期报错并列出支持的方法
  const bad = buildRouteTable([['FETCH', '/y', handler] as never]);
  assert.strictEqual(bad.routes.length, 0);
  assert.match(bad.issues[0]?.message ?? '', /不支持的方法 'FETCH'/);
  assert.match(bad.issues[0]?.message ?? '', /GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS/);
});

test('routes: HEAD 回退到 GET（headOnly），OPTIONS 返回 204 + Allow 而不是 405', () => {
  const { routes } = buildRouteTable([get('/rooms', handler), post('/rooms', handler)]);

  const asHead = matchRoute(routes, { method: 'HEAD', url: '/rooms' });
  assert.strictEqual(asHead.kind, 'matched');
  if (asHead.kind === 'matched') {
    assert.strictEqual(asHead.headOnly, true);
    assert.strictEqual(asHead.route.method, 'GET');
  }

  const preflight = matchRoute(routes, { method: 'OPTIONS', url: '/rooms' });
  assert.strictEqual(preflight.kind, 'options');
  if (preflight.kind === 'options') assert.deepStrictEqual([...preflight.allow].sort(), ['GET', 'POST']);

  // 小写方法请求同样被归一化
  assert.strictEqual(matchRoute(routes, { method: 'get', url: '/rooms' }).kind, 'matched');
});
