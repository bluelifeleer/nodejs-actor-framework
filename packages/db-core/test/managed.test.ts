import { test } from 'node:test';
import assert from 'node:assert';

import {
  DbDriverMissingError,
  DbUnavailableError,
  defineDatabaseAdapter,
  defineManagedResource,
  loadDriverModule,
  mapPoolOptions,
  supervise,
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

test('managed: connect → ready；事件顺序 connecting → connected → closed', async () => {
  const { adapter } = fakeAdapter();
  const events: string[] = [];
  const resource = supervise(adapter, {
    connection: { kind: 'fake', host: 'h' },
    pool: { max: 7 },
    onEvent: (event) => events.push(event.type),
  });

  await resource.connect();
  assert.strictEqual(resource.state, 'ready');
  // 顺序：connecting 一定在最前；驱动事件按**发生时刻**如实转发（框架不重排、不缓冲）
  assert.strictEqual(events[0], 'connecting');
  assert.ok(events.includes('connected'), `缺少 connected：${events.join(' → ')}`);
  assert.ok(events.includes('driver_event'), `缺少 driver_event：${events.join(' → ')}`);
  assert.ok(events.indexOf('connected') > 0);
  assert.strictEqual(resource.stats().state, 'ready');
  assert.deepStrictEqual(resource.stats().driver, { kind: 'fake' });

  await resource.close();
  assert.strictEqual(resource.state, 'closed');
  assert.strictEqual(events[events.length - 1], 'closed', `closed 必须是最后一个事件：${events.join(' → ')}`);
});

test('managed: 未连接/已关闭时 acquire 快速失败（不排队等死）', async () => {
  const { adapter } = fakeAdapter();
  const resource = supervise(adapter, { connection: { kind: 'fake', host: 'h' } });

  await assert.rejects(() => resource.acquire(), (err: unknown) => {
    assert.ok(err instanceof DbUnavailableError, `应当是 DbUnavailableError：${String(err)}`);
    assert.match((err as Error).message, /not connected/i);
    return true;
  });

  await resource.connect();
  const client = await resource.acquire();
  assert.strictEqual(client.id, 'c1');

  await resource.close();
  assert.rejects(() => resource.acquire(), DbUnavailableError);
});

test('managed: 连接失败要如实抛出，且状态回到 idle（不假装 ready）', async () => {
  const events: string[] = [];
  const adapter = defineDatabaseAdapter({
    kind: 'broken',
    driverPackage: 'broken',
    connectionKind: 'host',
    async connect() {
      throw new Error('拒绝连接');
    },
  });
  const resource = supervise(adapter, { connection: { kind: 'broken', host: 'h' }, onEvent: (e) => events.push(e.type) });
  await assert.rejects(() => resource.connect(), /拒绝连接/);
  assert.strictEqual(resource.state, 'idle', '连接失败后不该假装 ready');
  assert.ok(events.includes('connecting'));
  assert.ok(!events.includes('connected'));
  assert.rejects(() => resource.acquire(), DbUnavailableError);
});

test('managed: close 幂等（第二次 close 不再调用适配器，也不抛）', async () => {
  const { adapter, log } = fakeAdapter();
  const resource = supervise(adapter, { connection: { kind: 'fake', host: 'h' } });
  await resource.connect();
  await resource.close();
  await resource.close();
  assert.strictEqual(log.filter((line) => line === 'close').length, 1, '适配器的 close 只该被调用一次');
});

test('managed: 健康检查失败 → degraded + health_failed 事件；仍可 acquire（驱动可能自己恢复）', async () => {
  let healthy = false;
  const { adapter } = fakeAdapter({
    async healthCheck() {
      if (!healthy) throw new Error('ping 超时');
    },
  });
  const events: Array<{ type: string; error?: string }> = [];
  const resource = supervise(adapter, {
    connection: { kind: 'fake', host: 'h' },
    onEvent: (event) => events.push({ type: event.type, ...('error' in event ? { error: String(event.error) } : {}) }),
  });
  await resource.connect();
  await assert.rejects(() => resource.checkHealth(), /ping 超时/);
  assert.strictEqual(resource.state, 'degraded');
  assert.ok(events.some((e) => e.type === 'health_failed' && /ping 超时/.test(String(e.error))));
  // degraded 仍然允许取连接（不是静默降级：状态与事件都报出来了）
  const client = await resource.acquire();
  assert.strictEqual(client.id, 'c1');

  healthy = true;
  await resource.checkHealth();
  assert.strictEqual(resource.state, 'ready', '健康恢复后应当回到 ready');
  await resource.close();
});

test('managed: drain —— close 等在途归零；超时则如实上报在途数', async () => {
  const { adapter } = fakeAdapter();
  const events: Array<{ type: string; inFlight?: number }> = [];
  const resource = supervise(adapter, {
    connection: { kind: 'fake', host: 'h' },
    drainTimeoutMs: 50,
    onEvent: (event) => events.push({ type: event.type, ...('inFlight' in event ? { inFlight: event.inFlight } : {}) }),
  });
  await resource.connect();

  let release: () => void = () => {};
  const inFlight = resource.track(new Promise<void>((resolve) => (release = resolve)));
  release();
  await inFlight;
  await resource.close();
  assert.strictEqual(events.filter((e) => e.type === 'draining').length, 1, '应当有一次 draining 事件');
  assert.strictEqual(events.find((e) => e.type === 'draining')?.inFlight, 0);

  // 永不结束的在途：close 必须在 drainTimeoutMs 后如实上报在途数并强制关闭
  const { adapter: adapter2 } = fakeAdapter();
  const events2: Array<{ type: string; inFlight?: number }> = [];
  const resource2 = supervise(adapter2, {
    connection: { kind: 'fake', host: 'h' },
    drainTimeoutMs: 30,
    onEvent: (event) => events2.push({ type: event.type, ...('inFlight' in event ? { inFlight: event.inFlight } : {}) }),
  });
  await resource2.connect();
  void resource2.track(new Promise<void>(() => {})); // 永不 resolve
  await resource2.close();
  const drainEvent = events2.find((e) => e.type === 'draining');
  assert.strictEqual(drainEvent?.inFlight, 1, `超时也必须如实报出还有几个在途：${JSON.stringify(events2)}`);
  assert.strictEqual(resource2.state, 'closed');
});

test('managed: keepAlive 与定时健康检查（驱动自带重连时框架只转发事件）', async () => {
  let healthChecks = 0;
  let keeps = 0;
  const { adapter } = fakeAdapter({
    async healthCheck() {
      healthChecks += 1;
    },
    async keepAlive() {
      keeps += 1;
    },
  });
  const events: string[] = [];
  const resource = supervise(adapter, {
    connection: { kind: 'fake', host: 'h' },
    healthCheckIntervalMs: 10,
    keepAliveIntervalMs: 10,
    onEvent: (event) => events.push(event.type),
  });
  await resource.connect();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await resource.close();
  assert.ok(healthChecks >= 2, `定时健康检查没跑起来：${healthChecks}`);
  assert.ok(keeps >= 2, `保活没跑起来：${keeps}`);
  // 关闭后定时器必须停掉（否则测试会挂在未清理的 timer 上）
  const after = healthChecks;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(healthChecks, after, '关闭后定时健康检查必须停止');
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
