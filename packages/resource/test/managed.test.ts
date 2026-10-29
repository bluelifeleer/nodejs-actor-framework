import { test } from 'node:test';
import assert from 'node:assert';

import {
  DbDriverMissingError,
  DbUnavailableError,
  defineDatabaseAdapter,
  defineManagedResource,
  loadDriverModule,
  mapPoolOptions,
  runManagedConnectionContract,
  supervise,
  type ContractResourceFactory,
} from '../src/index.ts';

/**
 * `@actor/db-core` 的**连接管理契约套件**（设计见 docs/design/m7-multi-database.md §4.3）。
 *
 * 四条纪律在这里被钉死：
 *   1. 未就绪/已关闭时 `acquire()` **快速失败**（不排队等死）；
 *   2. 驱动自带重连 → 框架**只转发** `driver_event`，不自己重连；
 *   3. `stats` 如实（拿不到池数字就报连接状态，不编造）；
 *   4. `close()` 幂等 + drain（等在途归零，超时则如实上报在途数）。
 */
interface FakeClient {
  readonly id: string;
  closed: number;
}

function fakeAdapter(overrides: Record<string, unknown> = {}) {
  const log: string[] = [];
  const adapter = defineDatabaseAdapter<FakeClient>({
    kind: 'fake',
    driverPackage: 'fake-driver',
    connectionKind: 'host',
    async connect({ connection, pool, emitDriverEvent }) {
      log.push(`connect:${String(connection.host)}:${String(pool.max)}`);
      emitDriverEvent?.('reconnecting', { attempt: 1 }); // 模拟驱动自带的日志事件
      const client: FakeClient = { id: 'c1', closed: 0 };
      return {
        client,
        async healthCheck() {
          log.push('health');
        },
        async close() {
          client.closed += 1;
          log.push('close');
        },
        stats: () => ({ kind: 'fake' }),
        ...overrides,
      };
    },
    ...overrides,
  });
  return { adapter, log };
}

/**
 * 目标工厂：假适配器 + 计数器 + 可切换健康状态（契约套件需要的观察点）。
 */
function fakeTarget() {
  let healthy = true;
  let closedCount = 0;
  const counters = { healthChecks: 0, keepAlives: 0 };
  const makeClient = (label: string) => ({
    client: { id: label, get closed() { return closedCount; } },
    async healthCheck() {
      counters.healthChecks += 1;
      if (!healthy) throw new Error('ping 超时');
    },
    async close() {
      closedCount += 1;
    },
    stats: () => ({ kind: 'fake' }),
    async keepAlive() {
      counters.keepAlives += 1;
    },
  });

  const make: ContractResourceFactory = (input) => {
    const adapter = defineDatabaseAdapter<{ id: string }>({
      kind: 'fake',
      driverPackage: 'fake-driver',
      connectionKind: 'host',
      async connect({ emitDriverEvent }) {
        emitDriverEvent?.('reconnecting', { attempt: 1 }); // 模拟驱动自带的重连事件（框架只转发）
        return makeClient('c1');
      },
    });
    return supervise(adapter, {
      connection: { kind: 'fake', host: 'h' },
      onEvent: input.onEvent,
      ...(input.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: input.drainTimeoutMs }),
      ...(input.healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs: input.healthCheckIntervalMs }),
      ...(input.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: input.keepAliveIntervalMs }),
    });
  };

  const makeFailing: ContractResourceFactory = (input) => {
    const adapter = defineDatabaseAdapter({
      kind: 'broken',
      driverPackage: 'broken',
      connectionKind: 'host',
      async connect() {
        throw new Error('拒绝连接');
      },
    });
    return supervise(adapter, { connection: { kind: 'broken', host: 'h' }, onEvent: input.onEvent });
  };

  return {
    make,
    makeFailing,
    // 套件要的是"读计数"的函数（不是数字），保证它随时读到最新值
    counters: { healthChecks: () => counters.healthChecks, keepAlives: () => counters.keepAlives },
    closedCount: () => closedCount,
    setHealthy: (value: boolean) => (healthy = value),
  };
}

// 连接管理契约：同一套断言，离线（假适配器）与真库都跑它 —— 见 src/testing.ts
// 注意：make / counters / setHealthy 必须来自**同一个**目标对象，否则观察点对不上
const contractTarget = fakeTarget();
runManagedConnectionContract({
  name: 'fake',
  make: contractTarget.make,
  makeFailing: contractTarget.makeFailing,
  supportsKeepAlive: true,
  counters: contractTarget.counters,
  setHealthy: contractTarget.setHealthy,
});

test('managed: 驱动自带的重连事件只被转发（框架不自己重连）', async () => {
  const target = fakeTarget();
  const events: Array<{ type: string; event?: string }> = [];
  const resource = target.make({ onEvent: (event) => events.push({ type: event.type, ...('event' in event ? { event: String(event.event) } : {}) }) });
  await resource.connect();
  await resource.close();
  assert.deepStrictEqual(
    events.filter((event) => event.type === 'driver_event'),
    [{ type: 'driver_event', event: 'reconnecting' }],
    '驱动事件应当原样转发（含事件名）',
  );
});

test('managed: close 幂等 —— 适配器的 close 只被调用一次', async () => {
  const target = fakeTarget();
  const resource = target.make({ onEvent: () => {} });
  await resource.connect();
  await resource.close();
  await resource.close();
  assert.strictEqual(target.closedCount(), 1, '适配器 close 只该调用一次');
});

test('managed: defineManagedResource —— 非数据库也能纳入同一套生命周期', async () => {
  const events: string[] = [];
  const etcd = defineManagedResource({
    kind: 'etcd',
    driverPackage: 'etcd3',
    connectionKind: 'url',
    async connect({ load }) {
      // 这里必然失败（没装 etcd3）→ 用来验证"缺失驱动给安装提示"的路径也走同一套
      load('etcd3');
      throw new Error('unreachable');
    },
  });
  const resource = supervise(etcd, { connection: { kind: 'etcd', url: 'http://127.0.0.1:2379' }, onEvent: (e) => events.push(e.type) });
  await assert.rejects(
    () => resource.connect(),
    (err: unknown) => {
      assert.ok(err instanceof DbDriverMissingError, `应当是 DbDriverMissingError：${String(err)}`);
      assert.match((err as Error).message, /npm i etcd3/);
      return true;
    },
  );
  assert.strictEqual(resource.state, 'idle');
});

test('managed: 池参数映射助手（统一形状 → 驱动字段名）', () => {
  assert.deepStrictEqual(
    mapPoolOptions({ min: 1, max: 20, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 }, {
      min: 'min',
      max: 'connectionLimit',
      idleTimeoutMs: 'idleTimeout',
      connectionTimeoutMs: 'connectTimeout',
    }),
    { min: 1, connectionLimit: 20, idleTimeout: 30_000, connectTimeout: 5_000 },
  );
  assert.deepStrictEqual(mapPoolOptions({ max: 5 }, { max: 'maxPoolSize' }), { maxPoolSize: 5 });
  // 没给的键不出现（严格模式下不能塞 undefined）
  assert.deepStrictEqual(mapPoolOptions({}, { max: 'max' }), {});
});

test('managed: loadDriverModule 的安装提示（从应用根解析，不假装能加载）', () => {
  assert.throws(
    () => loadDriverModule('this-package-does-not-exist-xyz', 'mydb', 'this-package-does-not-exist-xyz'),
    (err: unknown) => {
      assert.ok(err instanceof DbDriverMissingError);
      assert.match((err as Error).message, /npm i this-package-does-not-exist-xyz/);
      return true;
    },
  );
});

test('supervise: onEvent/logger 抛错不会卡死 connect（回归：永久 connecting/连接泄漏）', async () => {
  let connects = 0;
  const adapter = defineDatabaseAdapter<{ id: string }>({
    kind: 'event-throw',
    driverPackage: 'none',
    connectionKind: 'host',
    async connect() {
      connects += 1;
      return {
        client: { id: 'c' },
        async healthCheck() {},
        async close() {},
      };
    },
  });
  const resource = supervise(adapter, {
    connection: { host: 'h' },
    onEvent: () => {
      throw new Error('sink down');
    },
    logger: () => {
      throw new Error('logger down');
    },
  });
  await resource.connect();
  assert.strictEqual(connects, 1);
  assert.strictEqual(resource.state, 'ready');
  await resource.close();
});

test('supervise: 并发 connect 只建一条连接；close 与 connect 竞态不得让资源复活（回归）', async () => {
  let connects = 0;
  let closes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = defineDatabaseAdapter<{ id: string }>({
    kind: 'race',
    driverPackage: 'none',
    connectionKind: 'host',
    async connect() {
      connects += 1;
      await gate;
      return { client: { id: `c${connects}` }, async healthCheck() {}, async close() { closes += 1; } };
    },
  });
  const resource = supervise(adapter, { connection: { host: 'h' } });

  const first = resource.connect();
  const second = resource.connect();
  release();
  await Promise.all([first, second]);
  assert.strictEqual(connects, 1, '并发 connect 必须复用同一个在途操作');
  assert.strictEqual(resource.state, 'ready');
  await resource.close();
  assert.strictEqual(closes, 1);

  // close 在 connect 之前发生：connect 完成后 close 仍然要把它关掉，不能停在 ready
  let release2!: () => void;
  const gate2 = new Promise<void>((resolve) => {
    release2 = resolve;
  });
  let connects2 = 0;
  let closes2 = 0;
  const adapter2 = defineDatabaseAdapter<{ id: string }>({
    kind: 'race-close',
    driverPackage: 'none',
    connectionKind: 'host',
    async connect() {
      connects2 += 1;
      await gate2;
      return { client: { id: 'c' }, async healthCheck() {}, async close() { closes2 += 1; } };
    },
  });
  const resource2 = supervise(adapter2, { connection: { host: 'h' } });
  const pendingConnect = resource2.connect();
  const pendingClose = resource2.close();
  release2();
  await Promise.allSettled([pendingConnect, pendingClose]);
  assert.strictEqual(connects2, 1);
  assert.strictEqual(resource2.state, 'closed');
  assert.strictEqual(closes2, 1, 'close 返回后不能留下活连接');
  await assert.rejects(() => resource2.acquire(), /not connected|closed/i);
});
