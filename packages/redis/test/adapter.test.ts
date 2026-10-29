import { test } from 'node:test';
import assert from 'node:assert';

import {
  DbDriverMissingError,
  runManagedConnectionContract,
  supervise,
  type ContractResourceFactory,
  type DriverResolver,
} from '@actor/resource';

import { describeRedis, parseRedisUrl, redisAdapter, resolveRedisDriver } from '../src/index.ts';
import { createFakeStore, type FakeStore } from './fake-store.ts';

/**
 * Redis 适配器测试：**两个驱动各跑一遍同一套连接管理契约** + 差异吸收的关键断言
 * （订阅另开连接、驱动事件只转发、安装提示）。
 */
const DRIVERS = ['redis', 'ioredis'] as const;

/** 假驱动解析：`redis` / `ioredis` 各自给一个假模块；其它一律 MODULE_NOT_FOUND。 */
function fakeResolver(store: FakeStore, allow: readonly string[] = DRIVERS): DriverResolver {
  return (specifier: string) => {
    if (allow.includes(specifier) && specifier === 'redis') return store.nodeRedisModule();
    if (allow.includes(specifier) && specifier === 'ioredis') return store.ioredisModule();
    const error = new Error(`Cannot find module '${specifier}'`);
    (error as { code?: string }).code = 'MODULE_NOT_FOUND';
    throw error;
  };
}

function makeTarget(driver: (typeof DRIVERS)[number]) {
  const store = createFakeStore();
  const make: ContractResourceFactory = (input) =>
    supervise(redisAdapter({ driver }), {
      connection: { url: 'redis://127.0.0.1:6379/0' },
      resolve: fakeResolver(store),
      onEvent: input.onEvent,
      ...(input.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: input.drainTimeoutMs }),
      ...(input.healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs: input.healthCheckIntervalMs }),
      ...(input.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: input.keepAliveIntervalMs }),
    });
  const makeFailing: ContractResourceFactory = (input) => {
    const broken = createFakeStore();
    broken.setHealthy(false);
    return supervise(redisAdapter({ driver }), {
      connection: { url: 'redis://127.0.0.1:6379/0' },
      resolve: fakeResolver(broken),
      onEvent: input.onEvent,
    });
  };
  return { store, make, makeFailing };
}

for (const driver of DRIVERS) {
  const target = makeTarget(driver);
  runManagedConnectionContract({
    name: `redis(${driver})`,
    make: target.make,
    makeFailing: target.makeFailing,
    supportsKeepAlive: true,
    setHealthy: target.store.setHealthy,
    // counters 不提供 → "关闭后定时任务停止"那条会**显式跳过**（适配器没有给计数接缝）
  });
}

test('redis adapter: 两个驱动都能连上、都能发命令（同一套 KeyValueClient）', async () => {
  for (const driver of DRIVERS) {
    const { store, make } = makeTarget(driver);
    const resource = make({ onEvent: () => {} });
    await resource.connect();
    try {
      const kv = await resource.acquire();
      assert.strictEqual(await kv.set('k', 'v'), true, `${driver}: set`);
      assert.strictEqual(await kv.get('k'), 'v', `${driver}: get`);
      assert.deepStrictEqual(await kv.command<string>(['PING']), 'PONG', `${driver}: 逃生通道 command`);
      assert.ok(kv.raw !== undefined, `${driver}: raw 逃生通道`);
      assert.ok(store.connections.raw >= 1, `${driver}: 应当建过连接`);
    } finally {
      await resource.close();
    }
  }
});

test('redis adapter: 订阅必然另开一条连接（两个驱动都靠 duplicate）', async () => {
  for (const driver of DRIVERS) {
    const { store, make } = makeTarget(driver);
    const resource = make({ onEvent: () => {} });
    await resource.connect();
    try {
      const kv = await resource.acquire();
      const received: string[] = [];
      const before = store.connections.duplicates;
      const unsubscribe = await kv.subscribe('news', (message) => received.push(message));
      assert.strictEqual(store.connections.duplicates, before + 1, `${driver}: 订阅应当 duplicate 一条连接`);

      store.deliver('news', 'hello');
      assert.deepStrictEqual(received, ['hello'], `${driver}: 订阅回调没收到消息`);
      await unsubscribe();
    } finally {
      await resource.close();
    }
  }
});

test('redis adapter: 驱动自带的重连事件只被转发成 driver_event（框架不自己重连）', async () => {
  const { make } = makeTarget('redis');
  const events: Array<{ type: string; event?: string }> = [];
  const resource = make({
    onEvent: (event) => events.push({ type: event.type, ...('event' in event ? { event: String(event.event) } : {}) }),
  });
  await resource.connect();
  await resource.close();
  const forwarded = events.filter((event) => event.type === 'driver_event');
  assert.ok(forwarded.length > 0, `应当转发驱动事件：${JSON.stringify(events)}`);
  assert.ok(
    forwarded.some((event) => event.event === 'ready'),
    `驱动 ready 事件应当被转发：${JSON.stringify(forwarded)}`,
  );
});

test('redis adapter: 前缀命名空间与 JSON 便捷方法（端到端）', async () => {
  const store = createFakeStore();
  const resource = supervise(redisAdapter({ driver: 'redis', prefix: 'app:' }), {
    connection: { url: 'redis://127.0.0.1:6379/0' },
    resolve: fakeResolver(store),
  });
  await resource.connect();
  try {
    const kv = await resource.acquire();
    await kv.setJson('obj', { a: 1 }, { ttlMs: 1000 });
    assert.deepStrictEqual(await kv.getJson('obj'), { a: 1 });
    assert.deepStrictEqual(store.commands.at(-1), ['GET', 'app:obj'], '命令必须带前缀');
  } finally {
    await resource.close();
  }
});

test('redis adapter: 没装驱动时的提示要能照着装（两个驱动各自提示各自的包）', async () => {
  for (const driver of DRIVERS) {
    const store = createFakeStore();
    const resource = supervise(redisAdapter({ driver }), {
      // 假解析器：什么都不给 → 模拟"驱动没装"
      resolve: fakeResolver(store, []),
      connection: { url: 'redis://127.0.0.1:6379/0' },
    });
    await assert.rejects(
      () => resource.connect(),
      (err: unknown) => {
        assert.ok(err instanceof DbDriverMissingError, `${driver}: 应当是 DbDriverMissingError`);
        assert.match((err as Error).message, new RegExp(`npm i ${driver}`), `${driver}: 提示里应当写 npm i ${driver}`);
        return true;
      },
    );
  }
});

test('redis adapter: 不认识的驱动名要明确报错（不静默用默认驱动）', () => {
  assert.throws(
    () => resolveRedisDriver('memcached'),
    (err: unknown) => {
      assert.match((err as Error).message, /unknown redis driver "memcached"/);
      assert.match((err as Error).message, /redis, ioredis/);
      return true;
    },
  );
  assert.strictEqual(resolveRedisDriver('redis').packageName, 'redis');
  assert.strictEqual(resolveRedisDriver('ioredis').packageName, 'ioredis');
});

test('redis adapter: DSN 解析与免密描述（含 rediss/TLS 与库索引）', () => {
  const plain = parseRedisUrl('redis://user:secret@cache.internal:6380/3');
  assert.strictEqual(plain.kind, 'redis');
  assert.strictEqual(plain.host, 'cache.internal');
  assert.strictEqual(plain.port, 6380);
  assert.strictEqual(plain.user, 'user');
  assert.strictEqual(plain.password, 'secret');
  assert.strictEqual(plain.database, '3');
  assert.strictEqual(plain.tls, false);
  assert.strictEqual(describeRedis(plain), 'redis://cache.internal:6380/3');
  assert.ok(!describeRedis(plain).includes('secret'), '描述里绝不能有密码');

  const tls = parseRedisUrl('rediss://cache.internal/1');
  assert.strictEqual(tls.tls, true);
  assert.strictEqual(parseRedisUrl('rediss://cache.internal').database, '0', '没写库索引默认 0');
  assert.strictEqual(parseRedisUrl('redis://cache.internal').port, 6379, '没写端口默认 6379');

  assert.throws(() => parseRedisUrl('pgsql://x/y'), /must start with redis:\/\//);
});

test('redis adapter: close() 必须关闭订阅用的 duplicate 连接（回归：连接泄漏）', async () => {
  const { store, make } = makeTarget('redis');
  const resource = make({});
  await resource.connect();
  const kv = await resource.acquire();
  await kv.subscribe('news', () => undefined);
  await resource.close();
  // 主连接 + 订阅连接各 quit 一次；旧实现只关主连接
  assert.ok(store.closed >= 2, `close() 之后应有 >=2 条连接被关闭，实际 ${store.closed}`);
});

test('redis adapter: 订阅回调抛错必须转成可见的 driver_event，而不是 uncaughtException（回归）', async () => {
  const { store, make } = makeTarget('redis');
  const events: Array<{ event?: string }> = [];
  const resource = make({ onEvent: (event) => events.push(event as { event?: string }) });
  await resource.connect();
  try {
    const kv = await resource.acquire();
    await kv.subscribe('news', () => {
      throw new Error('handler boom');
    });
    store.deliver('news', 'hello');
    assert.ok(
      events.some((event) => event.event === 'subscriber:handler_error'),
      '回调抛错必须变成 subscriber:handler_error 事件',
    );
  } finally {
    await resource.close();
  }
});
