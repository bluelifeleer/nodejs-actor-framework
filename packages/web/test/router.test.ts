import { test } from 'node:test';
import assert from 'node:assert';

import { buildRouteTable, defineRouter, defineRoutes, defineMiddleware, flattenRouter, get, ws } from '../src/index.ts';

const noop = () => ({ ok: true });
const mw = (name: string) =>
  defineMiddleware((() => {
    void name;
  }) as never) as never;

test('router: 前缀合成（多层嵌套、末尾斜杠、根叶子、前缀含参数）', () => {
  const { entries, issues } = flattenRouter(
    defineRouter({
      prefix: '/game/',
      name: 'game',
      children: [
        defineRouter({ prefix: '/rooms', routes: defineRoutes([get('/:id', noop), get('/', noop)]) }),
        defineRouter({ prefix: '/tenants/:tenantId', routes: defineRoutes([get('/players', noop)]) }),
      ],
    }),
  );
  assert.deepStrictEqual(issues, []);
  assert.deepStrictEqual(
    entries.map(([method, pattern]) => `${method} ${pattern}`),
    ['GET /game/rooms/:id', 'GET /game/rooms', 'GET /game/tenants/:tenantId/players'],
  );
  // 前缀里的参数与叶子参数在合成后一起交给 parsePattern（重名会被它拦下）
  const table = buildRouteTable(entries);
  assert.deepStrictEqual(table.issues, []);
  assert.deepStrictEqual(table.routes[2]?.pathParams, ['tenantId']);
});

test('router: 子树中间件在构建期烘焙，顺序 外层 → 内层 → 路由级', () => {
  const outer = mw('outer');
  const inner = mw('inner');
  const route = mw('route');
  const { entries } = flattenRouter(
    defineRouter({
      prefix: '/a',
      middleware: [outer],
      children: [
        defineRouter({ prefix: '/b', middleware: [inner], routes: defineRoutes([get('/c', noop, [route])]) }),
      ],
    }),
  );
  assert.strictEqual(entries.length, 1);
  assert.deepStrictEqual(entries[0]?.[3], [outer, inner, route]);
  assert.strictEqual(entries[0]?.[1], '/a/b/c');
});

test('router: 归属信息进 meta，重复路由报错能指名两个模块', () => {
  const first = flattenRouter(defineRouter({ prefix: '/x', name: 'game', routes: defineRoutes([get('/dup', noop)]) }));
  const second = flattenRouter(defineRouter({ prefix: '/x', name: 'admin', routes: defineRoutes([get('/dup', noop)]) }));
  const table = buildRouteTable([...first.entries, ...second.entries]);
  assert.strictEqual(table.routes.length, 1);
  assert.strictEqual(table.issues.length, 1);
  assert.match(table.issues[0]?.message ?? '', /路由重复：GET \/x\/dup/);
  assert.match(table.issues[0]?.message ?? '', /已由 game 注册/);
  assert.match(table.issues[0]?.message ?? '', /admin 想再注册一次/);
});

test('router: 非法前缀（不以 / 开头、含 ?）在构建期报错；WS 路由同样可嵌套', () => {
  const bad = flattenRouter(
    defineRouter({ prefix: 'game', children: [defineRouter({ prefix: '/x?y=', routes: [] })] }),
  );
  assert.strictEqual(bad.issues.length, 2);
  assert.match(bad.issues[0]?.message ?? '', /必须以 \/ 开头/);
  assert.match(bad.issues[1]?.message ?? '', /不能含查询声明/);

  const wsNested = flattenRouter(
    defineRouter({ prefix: '/rt', routes: defineRoutes([ws('/events?token=', noop)]) }),
  );
  const table = buildRouteTable(wsNested.entries);
  assert.deepStrictEqual(table.issues, []);
  assert.strictEqual(table.routes[0]?.method, 'WS');
  assert.strictEqual(table.routes[0]?.path, '/rt/events');
  assert.deepStrictEqual(table.routes[0]?.queryParams, ['token']);
});

test('router: 规则 3 仍按**合成后**的参数校验（前缀参数算数）', () => {
  const { entries } = flattenRouter(
    defineRouter({ routes: defineRoutes([get('/t/:tenantId/rooms', { input: { tenantId: { type: 'string' } }, handle: noop } as never)]) }),
  );
  const table = buildRouteTable(entries);
  assert.deepStrictEqual(table.issues, []);
  assert.deepStrictEqual(table.routes[0]?.pathParams, ['tenantId']);
});
