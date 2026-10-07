import { test } from 'node:test';
import assert from 'node:assert';

import {
  databaseAdapter,
  DbError,
  defineDatabaseAdapter,
  defineResourceAdapter,
  resourceAdapter,
  ResourceError,
  runManagedConnectionContract,
  runManagedResourceContract,
  supervise,
  type SupervisionEvent,
} from '../src/index.ts';

test('resource: 兼容别名是**同一个对象**（搬迁不改 instanceof 与行为）', () => {
  assert.strictEqual(databaseAdapter, resourceAdapter, 'databaseAdapter 应当就是 resourceAdapter');
  assert.strictEqual(defineDatabaseAdapter, defineResourceAdapter);
  assert.strictEqual(DbError, ResourceError, 'DbError 与 ResourceError 必须是同一个类');
  assert.strictEqual(runManagedConnectionContract, runManagedResourceContract);
  // instanceof 跨别名也成立
  const err = new ResourceError('x');
  assert.ok(err instanceof DbError);
});

/**
 * `resourceAdapter()`：把适配器接进应用的**结构化**插件（不依赖 `@actor/app`）。
 *
 * 这里用一个假的 app 对象驱动生命周期 —— 这正说明它是结构化的：
 * core 不需要知道应用层的实现，用户自装的适配器也能用同一套接线。
 */
interface FakeClient {
  readonly kind: string;
}

function fakeApp(config: Record<string, unknown> = {}) {
  const services = new Map<string, unknown>();
  return {
    services,
    app: {
      config: {
        get<T>(key: string): T {
          if (!(key in config)) throw new Error(`no config key ${key}`);
          return config[key] as T;
        },
      },
      provide(name: string, value: unknown) {
        services.set(name, value);
      },
      get<T>(name: string): T {
        return services.get(name) as T;
      },
    },
  };
}

const fakeAdapter = (overrides: Record<string, unknown> = {}) =>
  defineDatabaseAdapter<FakeClient>({
    kind: 'fake',
    driverPackage: 'fake-driver',
    connectionKind: 'host',
    config: { url: { type: 'string' as const, default: '' } },
    connectionFromUrl: (url) => ({ kind: 'fake', url, host: 'h' }),
    async connect() {
      return {
        client: { kind: 'fake-client' },
        async healthCheck() {},
        async close() {},
      };
    },
    ...overrides,
  });

test('resourceAdapter: 生命周期（onReady 连接 + 注册服务；onStopping 关闭）', async () => {
  let closed = 0;
  const adapter = fakeAdapter({
    async connect() {
      return {
        client: { kind: 'fake-client' },
        async healthCheck() {},
        async close() {
          closed += 1;
        },
      };
    },
  });
  const { app, services } = fakeApp({ 'plugins.cache.url': 'fake://x' });
  const plugin = resourceAdapter(adapter, { name: 'cache' });

  assert.strictEqual(plugin.name, 'cache');
  assert.deepStrictEqual(plugin.config, { url: { type: 'string', default: '' } });

  await plugin.onReady(app);
  assert.deepStrictEqual(services.get('cache'), { kind: 'fake-client' }, '客户端要注册成同名服务');
  assert.ok(services.has('cache:resource'), '受管资源也要注册（便于 stats/显式关闭）');

  await plugin.onStopping(app);
  assert.strictEqual(closed, 1, '停机要关掉连接');
  await plugin.onStopping(app); // 幂等
  assert.strictEqual(closed, 1);
});

test('resourceAdapter: 名字默认取适配器 kind；多实例用不同 name 各注册各的', async () => {
  const adapter = fakeAdapter();
  const { app, services } = fakeApp({ 'plugins.fake.url': 'fake://x' });
  const single = resourceAdapter(adapter);
  assert.strictEqual(single.name, 'fake');
  await single.onReady(app);
  assert.ok(services.has('fake'));
  await single.onStopping(app);

  // 两个同名适配器起两个实例
  const { app: app2, services: services2 } = fakeApp({ 'plugins.a.url': 'fake://a', 'plugins.b.url': 'fake://b' });
  const a = resourceAdapter(adapter, { name: 'a' });
  const b = resourceAdapter(adapter, { name: 'b' });
  await a.onReady(app2);
  await b.onReady(app2);
  assert.deepStrictEqual([...services2.keys()].sort(), ['a', 'a:resource', 'b', 'b:resource']);
  await a.onStopping(app2);
  await b.onStopping(app2);
});

test('resourceAdapter: 连不上时启动必须失败（不静默降级）', async () => {
  const adapter = fakeAdapter({
    async connect() {
      throw new Error('拒绝连接');
    },
  });
  const { app } = fakeApp({ 'plugins.broken.url': 'fake://x' });
  const plugin = resourceAdapter(adapter, { name: 'broken' });
  await assert.rejects(() => plugin.onReady(app), /拒绝连接/);
});

test('resourceAdapter: 连接后不健康也要启动失败，且错误信息说清是哪个实例', async () => {
  const adapter = fakeAdapter({
    async connect() {
      return {
        client: { kind: 'fake-client' },
        async healthCheck() {
          throw new Error('探活失败');
        },
        async close() {},
      };
    },
  });
  const { app } = fakeApp({ 'plugins.sick.url': 'fake://x' });
  const plugin = resourceAdapter(adapter, { name: 'sick' });
  await assert.rejects(
    () => plugin.onReady(app),
    (err: unknown) => {
      assert.match((err as Error).message, /resourceAdapter\("sick"\): database is not healthy: 探活失败/);
      return true;
    },
  );
});

test('resourceAdapter: 生命周期事件可以接出去（日志/指标）', async () => {
  const events: SupervisionEvent['type'][] = [];
  const { app } = fakeApp({ 'plugins.e.url': 'fake://x' });
  const plugin = resourceAdapter(fakeAdapter(), { name: 'e', onEvent: (event) => events.push(event.type) });
  await plugin.onReady(app);
  await plugin.onStopping(app);
  // 顺序：connecting → connected →（停机）draining → closed（draining 带上在途数）
  assert.deepStrictEqual(events, ['connecting', 'connected', 'draining', 'closed']);
});

test('resourceAdapter: 空名字要报错（否则服务名/配置节都会含糊）', () => {
  assert.throws(() => resourceAdapter(fakeAdapter(), { name: '  ' }), /name must be a non-empty string/);
});

void supervise; // 说明：插件内部用的就是它（同一套连接管控）
