import { test } from 'node:test';
import assert from 'node:assert';

import {
  realDatabaseUrl,
  runManagedConnectionContract,
  supervise,
  type ContractResourceFactory,
} from '@actor/db-core';

import { createDatabase, createSqlAdapter, defineModel, dialectSpec, parseConnection } from '../src/index.ts';

/**
 * **真库用例**（设计文档 §7）：设了 `ACTOR_TEST_*_URL` 才跑，否则**显式跳过**。
 *
 * 关键点：真库跑的是**同一套** `runManagedConnectionContract` 断言（不是另写一套宽松断言）——
 * 这样"契约级"与"真库"说的是一回事。
 *
 * 起库：`node scripts/dev-databases.mjs up` 然后 `eval "$(node scripts/dev-databases.mjs env)"`。
 * ⚠️ 本仓库所在环境离线无 docker，所以这三条在这里**必然跳过**：真连库那一步要在你的机器/CI 上见结果。
 */
const TARGETS = [
  { name: 'pgsql', env: 'ACTOR_TEST_PG_URL', dialect: 'pgsql' },
  { name: 'mysql', env: 'ACTOR_TEST_MYSQL_URL', dialect: 'mysql' },
  { name: 'mssql', env: 'ACTOR_TEST_MSSQL_URL', dialect: 'mssql' },
] as const;

/** 每次运行用唯一表名，避免污染其它用例 / 上次运行的残留。 */
function uniqueTable(name: string): string {
  return `actor_probe_${name}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

for (const target of TARGETS) {
  const url = realDatabaseUrl(target.env);
  const skippedReason = `${target.env} not set（真库用例：先 node scripts/dev-databases.mjs up）`;

  if (url === undefined) {
    // 每个目标都注册**可见跳过**：三条用例、两条断言各一次
    test(`real(${target.name}): 连接管理契约`, { skip: skippedReason }, () => {});
    test(`real(${target.name}): 建表 + CRUD + 清理往返`, { skip: skippedReason }, () => {});
    continue;
  }

  const connection = parseConnection({ url });
  const dialect = target.dialect;
  const driver = dialectSpec(dialect).driver();

  const make: ContractResourceFactory = (input) =>
    supervise(createSqlAdapter({ dialect, driver: dialectSpec(dialect).driver() }), {
      connection,
      onEvent: input.onEvent,
      ...(input.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: input.drainTimeoutMs }),
      ...(input.healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs: input.healthCheckIntervalMs }),
      ...(input.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: input.keepAliveIntervalMs }),
    });
  void driver;

  // 真库也跑同一套契约（setHealthy/makeFailing 不提供 → 那两条会显示为 skip）
  runManagedConnectionContract({ name: `real-${target.name}`, make });

  test(`real(${target.name}): 建表 + CRUD + 清理往返`, async () => {
    const table = uniqueTable(target.name);
    const db = createDatabase({ connection: { url }, logger: () => {} });
    await db.connect();
    const Probe = defineModel({
      name: table,
      fields: {
        id: { type: 'uuid', primaryKey: true },
        note: { type: 'string', length: 64, notNull: true },
        version: { type: 'integer', version: true },
      },
    });
    try {
      const report = await db.sync([Probe]);
      assert.deepStrictEqual(report.created, [table], '真库里应当新建了这张表');

      const repo = db.repository(Probe);
      const created = await repo.insert({ note: 'hello-real-db' });
      const found = await repo.findById(created.id);
      assert.strictEqual(found?.note, 'hello-real-db');

      const updated = await repo.update(String(created.id), { note: 'updated' }, { expectedVersion: 0 });
      assert.strictEqual(updated.note, 'updated');
      assert.strictEqual(updated.version, 1);

      // 漂移检测在真库上也要说 ok（同一张表、同一个 model）
      assert.strictEqual((await db.checkDrift(Probe)).ok, true);

      assert.strictEqual(await repo.delete(String(created.id)), true);
      assert.strictEqual(await repo.findById(created.id), null);
    } finally {
      try {
        await db.rawRun(`DROP TABLE ${dialectSpec(dialect).quote(table)}`);
      } catch {
        // 清理失败不要掩盖主断言（下一次运行会用新的唯一表名）
      }
      await db.close();
    }
  });
}
