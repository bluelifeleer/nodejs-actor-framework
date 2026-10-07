import { test } from 'node:test';
import assert from 'node:assert';

import { ResourceUnavailableError } from './errors.ts';
import type { ManagedResource } from './managed.ts';
import type { SupervisionEvent } from './managed.ts';

/**
 * **连接管理契约套件**（设计见 docs/design/m7-multi-database.md §7）。
 *
 * 为什么放在 `src/` 而不是 `test/`：适配器包（`@actor/db`/`@actor/redis`/`@actor/mongodb`）以及
 * **用户自装的适配器**都要能 import 它来自证合规 —— 发布出去的包只带 `src/`，测试目录带不出去。
 *
 * 用法（同一套断言，离线假适配器与真库都能跑）：
 *
 * ```ts
 * runManagedResourceContract({
 *   name: 'redis',
 *   make: ({ onEvent }) => supervise(redisAdapter, { connection, onEvent }),
 * });
 * ```
 *
 * 契约内容（四条纪律的可执行版本）：
 *   1. `connect()` 成功后 state 是 `ready`，事件里有 `connecting`/`connected`；
 *   2. 未连接/已关闭时 `acquire()` **快速失败**（抛 `ResourceUnavailableError`，不排队）；
 *   3. `close()` **幂等**；关闭后 `acquire()` 仍然快速失败；
 *   4. `stats()` 如实（没给驱动统计就是 `null`，不编造）；
 *   5. `track()` 的在途工作会被 `close()` drain；超时则如实上报在途数；
 *   6. 关闭后定时健康检查/保活必须停止。
 */
export interface ContractResourceInput {
  onEvent: (event: SupervisionEvent) => void;
  drainTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  keepAliveIntervalMs?: number;
}

export type ContractResourceFactory = (input: ContractResourceInput) => ManagedResource<unknown>;

export interface ManagedResourceContractOptions {
  /** 用例名里的目标名（例如 `fake` / `pgsql`）。 */
  name: string;
  /** 正常目标：能连上。 */
  make: ContractResourceFactory;
  /** 连接必定失败的目标（不提供就跳过那条用例，并把跳过原因打出来）。 */
  makeFailing?: ContractResourceFactory;
  /** 目标是否实现了 `keepAlive()`（没有就跳过保活断言）。 */
  supportsKeepAlive?: boolean;
  /** 目标是否支持 drain（默认 true；不支持就跳过在途断言）。 */
  supportsDrain?: boolean;
  /**
   * 可选：让套件观察目标内部的计数（用来证明"关闭后后台任务真的停了"）。
   * 不提供就**显式跳过**那条用例（测试输出里能看到 skip）。
   */
  counters?: { healthChecks: () => number; keepAlives?: () => number };
  /** 可选：让套件把目标切成"不健康"再切回来（验证 degraded 与恢复语义）。 */
  setHealthy?: (healthy: boolean) => void;
}

/**
 * 真库测试开关（约定：环境变量存在才跑，否则**显式跳过**）。
 *
 * 变量清单（见 `scripts/dev-databases.mjs`）：
 * `ACTOR_TEST_PG_URL` / `ACTOR_TEST_MYSQL_URL` / `ACTOR_TEST_MSSQL_URL` /
 * `ACTOR_TEST_REDIS_URL` / `ACTOR_TEST_IOREDIS_URL` / `ACTOR_TEST_MONGO_URL`。
 *
 * 为什么"跳过必须可见"：静默绿灯会让人以为真库验过了 —— 这里用 `test(name, { skip })`，
 * 测试输出里能直接看到 `skipped N`。
 */
export function realResourceUrl(envVar: string): string | undefined {
  const value = process.env[envVar];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** 注册一个"有真库才跑"的用例；没配就注册显式跳过（不是不注册）。 */
export function testWithResource(envVar: string, name: string, fn: () => void | Promise<void>): void {
  if (realResourceUrl(envVar) === undefined) {
    test(name, { skip: `${envVar} not set（真库用例：先 node scripts/dev-databases.mjs up）` }, () => {});
    return;
  }
  test(name, fn);
}

/** 跑一遍连接管理契约。用例注册在调用方所在的测试文件里。 */
export function runManagedResourceContract(options: ManagedResourceContractOptions): void {
  const { name } = options;
  const supportsDrain = options.supportsDrain !== false;

  test(`contract(${name}): connect → ready，事件里有 connecting/connected`, async () => {
    const events: string[] = [];
    const resource = options.make({ onEvent: (event) => events.push(event.type) });
    await resource.connect();
    try {
      assert.strictEqual(resource.state, 'ready');
      assert.strictEqual(events[0], 'connecting', `第一个事件必须是 connecting：${events.join(' → ')}`);
      assert.ok(events.includes('connected'), `缺少 connected：${events.join(' → ')}`);
      const stats = resource.stats();
      assert.strictEqual(stats.state, 'ready');
      assert.strictEqual(typeof stats.inFlight, 'number');
      // 驱动统计要么是 null，要么是对象 —— 不许编造标量
      assert.ok(stats.driver === null || typeof stats.driver === 'object', `stats.driver 形状不对：${String(stats.driver)}`);
    } finally {
      await resource.close();
    }
    assert.strictEqual(resource.state, 'closed');
  });

  test(`contract(${name}): 未连接与已关闭时 acquire 快速失败（不排队）`, async () => {
    const resource = options.make({ onEvent: () => {} });
    await assert.rejects(() => resource.acquire(), (err: unknown) => {
      assert.ok(err instanceof ResourceUnavailableError, `应当是 ResourceUnavailableError：${String(err)}`);
      return true;
    });
    await resource.connect();
    await resource.acquire(); // 就绪时能拿到
    await resource.close();
    await assert.rejects(() => resource.acquire(), ResourceUnavailableError);
  });

  test(`contract(${name}): close 幂等（第二次不抛）`, async () => {
    const resource = options.make({ onEvent: () => {} });
    await resource.connect();
    await resource.close();
    await resource.close();
    assert.strictEqual(resource.state, 'closed');
  });

  if (options.makeFailing !== undefined) {
    test(`contract(${name}): 连接失败要如实抛出，且不假装 ready`, async () => {
      const events: string[] = [];
      const resource = options.makeFailing?.({ onEvent: (event) => events.push(event.type) }) as ManagedResource<unknown>;
      await assert.rejects(() => resource.connect());
      assert.notStrictEqual(resource.state, 'ready', '连接失败后不该是 ready');
      assert.ok(!events.includes('connected'), `不该出现 connected：${events.join(' → ')}`);
      await assert.rejects(() => resource.acquire(), ResourceUnavailableError);
    });
  } else {
    // 显式 skip：测试输出里能看到"跳过了什么"，不许静默变绿
    test(`contract(${name}): 连接失败要如实抛出，且不假装 ready`, { skip: '目标没提供 makeFailing' }, () => {});
  }

  if (options.setHealthy !== undefined) {
    const setHealthy = options.setHealthy;
    test(`contract(${name}): 健康检查失败 → degraded + health_failed；恢复后回到 ready`, async () => {
      const events: Array<{ type: string; error?: string }> = [];
      const resource = options.make({
        onEvent: (event) => events.push({ type: event.type, ...('error' in event ? { error: String(event.error) } : {}) }),
      });
      await resource.connect();
      try {
        setHealthy(false);
        await assert.rejects(() => resource.checkHealth());
        assert.strictEqual(resource.state, 'degraded', '健康检查失败后应当是 degraded（不是假装 ready）');
        const failure = events.find((event) => event.type === 'health_failed');
        assert.ok(failure, `缺少 health_failed 事件：${JSON.stringify(events)}`);
        // 只要求"带上原因"，**不规定措辞**（套件不该强迫别人用英文/某种文案）
        assert.ok(String(failure.error ?? '').length > 0, 'health_failed 事件必须带上失败原因');
        // 恢复：回到 ready，且原因被清掉
        setHealthy(true);
        await resource.checkHealth();
        assert.strictEqual(resource.state, 'ready');
        assert.strictEqual(resource.stats().lastHealthError, null, '恢复后不该还留着旧错误');
      } finally {
        setHealthy(true);
        await resource.close();
      }
    });
  } else {
    test(`contract(${name}): 健康检查失败 → degraded`, { skip: '调用方没提供 setHealthy' }, () => {});
  }

  if (supportsDrain) {
    test(`contract(${name}): close 会等在途归零；超时则如实上报在途数`, async () => {
      const clean: Array<{ type: string; inFlight?: number }> = [];
      const resource = options.make({
        onEvent: (event) => clean.push({ type: event.type, ...('inFlight' in event ? { inFlight: event.inFlight } : {}) }),
        drainTimeoutMs: 50,
      });
      await resource.connect();
      await resource.track(Promise.resolve('done'));
      await resource.close();
      const drained = clean.find((event) => event.type === 'draining');
      assert.ok(drained, `缺少 draining 事件：${JSON.stringify(clean)}`);
      assert.strictEqual(drained.inFlight, 0, '在途已归零时应当报 0');

      const stuck: Array<{ type: string; inFlight?: number }> = [];
      const resource2 = options.make({
        onEvent: (event) => stuck.push({ type: event.type, ...('inFlight' in event ? { inFlight: event.inFlight } : {}) }),
        drainTimeoutMs: 30,
      });
      await resource2.connect();
      void resource2.track(new Promise<void>(() => {})); // 永不结束
      await resource2.close();
      assert.strictEqual(
        stuck.find((event) => event.type === 'draining')?.inFlight,
        1,
        `超时也必须如实报出在途数：${JSON.stringify(stuck)}`,
      );
      assert.strictEqual(resource2.state, 'closed');
    });
  } else {
    test(`contract(${name}): close 会等在途归零`, { skip: '目标声明不支持 drain' }, () => {});
  }

  if (options.counters === undefined) {
    test(`contract(${name}): 关闭后定时健康检查必须停止`, { skip: '调用方没提供 counters' }, () => {});
    return;
  }
  const counters = options.counters;

  test(`contract(${name}): 定时健康检查真的在跑，且关闭后必须停止`, async () => {
    const resource = options.make({
      onEvent: () => {},
      healthCheckIntervalMs: 5,
      ...(options.supportsKeepAlive === true ? { keepAliveIntervalMs: 5 } : {}),
    });
    await resource.connect();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const whileRunning = counters.healthChecks();
    assert.ok(whileRunning > 0, `定时健康检查没跑起来（计数 ${whileRunning}）`);

    await resource.close();
    assert.strictEqual(resource.state, 'closed');
    const afterClose = counters.healthChecks();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.strictEqual(counters.healthChecks(), afterClose, '关闭后健康检查必须停止（不能留后台任务）');

    if (counters.keepAlives !== undefined && options.supportsKeepAlive === true) {
      const keepAfterClose = counters.keepAlives();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.strictEqual(counters.keepAlives(), keepAfterClose, '关闭后保活必须停止');
    }
  });
}

// --- 兼容别名（同一函数对象与类型）------------------------------------------
export { runManagedResourceContract as runManagedConnectionContract };
export type { ManagedResourceContractOptions as ManagedConnectionContractOptions };

// --- 兼容别名（同一函数对象）------------------------------------------------
export { realResourceUrl as realDatabaseUrl, testWithResource as testWithDatabase };
