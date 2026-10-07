import { test } from 'node:test';
import assert from 'node:assert';

import {
  runManagedConnectionContract,
  supervise,
  type ContractResourceFactory,
} from '@actor/db-core';

import { createDatabase, createSqlAdapter, type NormalizedConnection } from '../src/index.ts';

/**
 * **等价性证明**（设计文档 M7a 第二部分）：SQL 侧接上 core 的 `supervise()` 之后，
 * 它必须与其它适配器一样通过**同一套**连接管理契约。
 *
 * 这里用假 SQL 驱动跑契约（离线可跑）；真库路径在 M7b 的 env 开关用例里。
 */
function fakeSqlTarget() {
  let healthy = true;
  const counters = { healthChecks: 0, keepAlives: 0, closed: 0 };

  const makeFakeDriver = () => ({
    name: 'fake-sql',
    async create() {
      return {
        async all() {
          return [];
        },
        async run() {
          return 0;
        },
        async healthCheck() {
          counters.healthChecks += 1;
          if (!healthy) throw new Error('pg 探活超时');
        },
        async close() {
          counters.closed += 1;
        },
        stats: () => ({ kind: 'fake-sql', total: 1, idle: 1 }),
      };
    },
  });

  const connection = { dialect: 'pgsql', host: 'db', port: 5432, database: 'app' } as NormalizedConnection;

  const make: ContractResourceFactory = (input) =>
    supervise(createSqlAdapter({ dialect: 'pgsql', driver: makeFakeDriver() as never }), {
      connection,
      onEvent: input.onEvent,
      ...(input.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: input.drainTimeoutMs }),
      ...(input.healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs: input.healthCheckIntervalMs }),
      ...(input.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: input.keepAliveIntervalMs }),
    });

  const makeFailing: ContractResourceFactory = (input) =>
    supervise(
      createSqlAdapter({
        dialect: 'pgsql',
        driver: {
          name: 'fake-sql-broken',
          async create() {
            throw new Error('ECONNREFUSED 127.0.0.1:5432');
          },
        } as never,
      }),
      { connection, onEvent: input.onEvent },
    );

  return {
    make,
    makeFailing,
    counters: { healthChecks: () => counters.healthChecks, keepAlives: () => counters.keepAlives },
    closedCount: () => counters.closed,
    setHealthy: (value: boolean) => (healthy = value),
  };
}

const target = fakeSqlTarget();

runManagedConnectionContract({
  name: 'sql(fake driver)',
  make: target.make,
  makeFailing: target.makeFailing,
  counters: target.counters,
  setHealthy: target.setHealthy,
});

test('sql-adapter: 建连失败要包成 DbConnectionError（保住既有错误语义）', async () => {
  const db = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'db', database: 'app' },
    driver: {
      name: 'fake-sql-broken',
      async create() {
        throw new Error('ECONNREFUSED 127.0.0.1:5432');
      },
    } as never,
  });
  await assert.rejects(
    () => db.connect(),
    (err: unknown) => {
      assert.strictEqual((err as Error).name, 'DbConnectionError');
      assert.match((err as Error).message, /cannot connect to pgsql:\/\/db:5432\/app/);
      return true;
    },
  );
  // 失败后不能假装健康：注意 `healthCheck()` 是**返回报告**（{ ok:false }），不是抛错（既有设计）
  const health = await db.healthCheck();
  assert.strictEqual(health.ok, false);
  assert.match(String(health.error), /ECONNREFUSED/);
  // 也不假装能查
  await assert.rejects(() => db.raw('SELECT 1'), (err: unknown) => {
    assert.strictEqual((err as Error).name, 'DbNotConnectedError');
    return true;
  });
});

test('sql-adapter: 建连失败要关掉半开的池（不泄漏连接）', async () => {
  let closed = 0;
  const db = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'db', database: 'app' },
    driver: {
      name: 'fake-sql-halfopen',
      async create() {
        return {
          async all() {
            return [];
          },
          async run() {
            return 0;
          },
          async healthCheck() {
            throw new Error('探活失败');
          },
          async close() {
            closed += 1;
          },
        };
      },
    } as never,
  });
  await assert.rejects(() => db.connect(), /探活失败/);
  assert.strictEqual(closed, 1, '建连失败后必须关掉半开的池');
});

test('sql-adapter: 未连接时仍然是 DbNotConnectedError（边界翻译，不改既有错误类型）', async () => {
  const db = createDatabase({ dialect: 'sqlite', connection: { filename: ':memory:' } });
  await assert.rejects(
    () => db.raw('SELECT 1'),
    (err: unknown) => {
      assert.strictEqual((err as Error).name, 'DbNotConnectedError');
      return true;
    },
  );
  await db.connect();
  await db.close();
  await assert.rejects(
    () => db.raw('SELECT 1'),
    (err: unknown) => {
      assert.strictEqual((err as Error).name, 'DbNotConnectedError');
      assert.match((err as Error).message, /already closed/);
      return true;
    },
  );
});

test('sql-adapter: stats 如实透传驱动统计；驱动没给就是 null（不编造）', async () => {
  const withStats = target.make({ onEvent: () => {} });
  await withStats.connect();
  assert.deepStrictEqual(withStats.stats().driver, { kind: 'fake-sql', total: 1, idle: 1 });
  await withStats.close();

  const bare = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'db', database: 'app' },
    driver: {
      name: 'fake-sql-no-stats',
      async create() {
        return {
          async all() {
            return [];
          },
          async run() {
            return 0;
          },
          async healthCheck() {},
          async close() {},
        };
      },
    } as never,
  });
  await bare.connect();
  try {
    assert.strictEqual(bare.stats(), null, '驱动没给统计就应当是 null');
  } finally {
    await bare.close();
  }
});
