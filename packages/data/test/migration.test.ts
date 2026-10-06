import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createFileMigrationStore,
  createMemoryMigrationStore,
  createMigrationRunner,
  createSqlMigrationStore,
  MigrationInterruptedError,
  MigrationPendingError,
  MigrationVersionError,
  type Migration,
  type MigrationSqlRunner,
} from '../src/index.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-migrations-'));
}

/** 一个会记录调用次数的迁移；`failTimes` 用来模拟"跑一半崩了"。 */
function makeMigration(version: number, options: { failTimes?: number; calls?: number[]; down?: boolean } = {}): Migration {
  const calls = options.calls ?? [];
  let remainingFailures = options.failTimes ?? 0;
  return {
    version,
    description: `migration ${version}`,
    async up() {
      calls.push(version);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error(`模拟 v${version} 执行中断`);
      }
    },
    ...(options.down === false
      ? {}
      : {
          async down() {
            calls.push(-version);
          },
        }),
  };
}

test('migration: 定义写错在构造期报错（重复版本 / 非整数 / 缺 up / down 不是函数）', () => {
  assert.throws(
    () =>
      createMigrationRunner({
        store: createMemoryMigrationStore(),
        migrations: [{ version: 0, up: () => undefined }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof MigrationVersionError);
      assert.match(err.message, /version 必须是 >= 1 的整数/);
      return true;
    },
  );

  assert.throws(
    () =>
      createMigrationRunner({
        store: createMemoryMigrationStore(),
        migrations: [
          { version: 1, up: () => undefined },
          { version: 1, up: () => undefined },
        ],
      }),
    /v1 被声明了两次/,
  );

  assert.throws(
    () =>
      createMigrationRunner({
        store: createMemoryMigrationStore(),
        migrations: [{ version: 1, up: undefined as never }],
      }),
    /v1 缺少 up\(\) 函数/,
  );

  assert.throws(
    () =>
      createMigrationRunner({
        store: createMemoryMigrationStore(),
        migrations: [{ version: 1, up: () => undefined, down: 'nope' as never }],
      }),
    /down 必须是函数/,
  );
});

test('migration: status / migrate —— 按版本升序执行，每个先记 started 再记 completed', async () => {
  const calls: number[] = [];
  const logs: string[] = [];
  const store = createMemoryMigrationStore();
  const runner = createMigrationRunner({
    store,
    migrations: [makeMigration(2, { calls }), makeMigration(1, { calls }), makeMigration(3, { calls })],
    log: (message) => logs.push(message),
  });

  const before = await runner.status();
  assert.deepStrictEqual(before.applied, []);
  assert.deepStrictEqual(before.pending, [1, 2, 3], 'pending 是版本号数组（与 applied 一致）');

  const result = await runner.migrate();
  assert.deepStrictEqual(
    result.applied.map((m) => m.version),
    [1, 2, 3],
  );
  assert.deepStrictEqual(calls, [1, 2, 3], '按版本升序执行');
  assert.match(logs.join('\n'), /应用迁移 v1/);

  const records = await store.read();
  assert.deepStrictEqual(
    records.map((r) => [r.version, r.status]),
    [
      [1, 'completed'],
      [2, 'completed'],
      [3, 'completed'],
    ],
  );

  // 再跑一次：什么都不做（不会重复执行）
  const again = await runner.migrate();
  assert.deepStrictEqual(again.applied, []);
  assert.deepStrictEqual(calls, [1, 2, 3], '已完成的迁移不会被重复执行');
  await runner.assertApplied();
});

test('migration: 默认拒绝启动——有未应用迁移就抛错（带版本列表）', async () => {
  const store = createMemoryMigrationStore();
  const runner = createMigrationRunner({
    store,
    migrations: [makeMigration(1), makeMigration(2)],
  });

  await assert.rejects(
    () => runner.assertApplied(),
    (err: unknown) => {
      assert.ok(err instanceof MigrationPendingError);
      assert.deepStrictEqual(err.pending, [1, 2]);
      assert.match(err.message, /尚未应用：v1, v2/);
      assert.match(err.message, /默认拒绝启动/);
      return true;
    },
  );

  await runner.migrate();
  const status = await runner.assertApplied();
  assert.deepStrictEqual(status.applied, [1, 2]);
});

test('migration: 数据比代码新 → 拒绝（既不自动跑，也不允许降级）', async () => {
  const store = createMemoryMigrationStore([{ version: 5, status: 'completed', at: 1 }]);
  const runner = createMigrationRunner({
    store,
    migrations: [makeMigration(1), makeMigration(2)],
  });

  await assert.rejects(
    () => runner.assertApplied(),
    (err: unknown) => {
      assert.ok(err instanceof MigrationVersionError);
      assert.match(err.message, /应用过 v5/);
      assert.match(err.message, /请先升级代码/);
      return true;
    },
  );
  await assert.rejects(() => runner.migrate(), /不能降级执行/);
});

test('migration: 执行中断可重入——版本表留下 started，重跑会再次执行它（所以 up() 必须幂等）', async () => {
  const calls: number[] = [];
  const store = createMemoryMigrationStore();
  const runner = createMigrationRunner({
    store,
    migrations: [
      makeMigration(1, { calls }),
      makeMigration(2, { calls, failTimes: 1 }), // 第一次执行到一半就崩
      makeMigration(3, { calls }),
    ],
  });

  await assert.rejects(() => runner.migrate(), /模拟 v2 执行中断/);
  const afterCrash = await store.read();
  assert.deepStrictEqual(
    afterCrash.map((r) => [r.version, r.status]),
    [
      [1, 'completed'],
      [2, 'started'], // ← 中断留下的记录：框架能说出是哪一个
    ],
    '崩溃前完成的记录保留，中断的那个是 started',
  );

  await assert.rejects(
    () => runner.assertApplied(),
    (err: unknown) => err instanceof MigrationInterruptedError && err.versions[0] === 2,
    '中断状态同样不允许直接启动',
  );

  // 重跑：v2 再来一次（这就是"up() 必须幂等"的原因），随后 v3 继续
  const resumed = await runner.migrate();
  assert.deepStrictEqual(
    resumed.applied.map((m) => m.version),
    [2, 3],
  );
  assert.deepStrictEqual(calls, [1, 2, 2, 3], 'v2 被执行了两次：第一次中断、第二次续上');
  await runner.assertApplied();
});

test('migration: rollback 按降序执行 down；缺 down 的迁移明确报错', async () => {
  const calls: number[] = [];
  const store = createMemoryMigrationStore();
  const runner = createMigrationRunner({
    store,
    migrations: [makeMigration(1, { calls }), makeMigration(2, { calls }), makeMigration(3, { calls })],
  });
  await runner.migrate();

  const rolled = await runner.rollback({ to: 1 });
  assert.deepStrictEqual(
    rolled.rolledBack.map((m) => m.version),
    [3, 2],
    '按版本降序回滚',
  );
  assert.deepStrictEqual(calls.slice(3), [-3, -2]);
  const status = await runner.status();
  assert.deepStrictEqual(status.applied, [1]);
  assert.deepStrictEqual(status.pending, [2, 3], '回滚过的迁移又变成"未应用"');

  // 没有 down 的迁移无法回滚：明确报错，而不是默默跳过
  const noDownStore = createMemoryMigrationStore();
  const noDown = createMigrationRunner({
    store: noDownStore,
    migrations: [makeMigration(1, { down: false })],
  });
  await noDown.migrate();
  await assert.rejects(() => noDown.rollback({ to: 0 }), /没有 down\(\).*无法回滚/);
  await assert.rejects(() => noDown.rollback({ to: -1 }), /需要 to/);
});

test('migration: file 版本表跨实例存在、写盘是原子的', async () => {
  const dir = tempDir();
  try {
    const store = createFileMigrationStore({ dir });
    const runner = createMigrationRunner({ store, migrations: [makeMigration(1), makeMigration(2)] });
    await runner.migrate();

    // 新实例（≈ 进程重启）读到同样的版本表
    const reopened = createMigrationRunner({
      store: createFileMigrationStore({ dir }),
      migrations: [makeMigration(1), makeMigration(2)],
    });
    const status = await reopened.assertApplied();
    assert.deepStrictEqual(status.applied, [1, 2]);

    // 内容损坏时明确报错（而不是当成"没有迁移"然后重跑一遍）
    fs.writeFileSync(path.join(dir, 'migrations.json'), '{ not json');
    const broken = createMigrationRunner({
      store: createFileMigrationStore({ dir }),
      migrations: [makeMigration(1)],
    });
    await assert.rejects(() => broken.status(), /内容损坏/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: SQL 版本表（node:sqlite）自动建表并正常工作', async () => {
  const db = new DatabaseSync(':memory:');
  const runnerSql: MigrationSqlRunner = {
    async all(sql, params) {
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    async run(sql, params) {
      return Number(db.prepare(sql).run(...(params as never[])).changes);
    },
  };
  try {
    const store = createSqlMigrationStore({ runner: runnerSql });
    const migrations = [makeMigration(1), makeMigration(2)];
    const runner = createMigrationRunner({ store, migrations });

    // 表还不存在：assertApplied 会先 ensure（建框架自己的账本表），然后报"有未应用迁移"
    await assert.rejects(() => runner.assertApplied(), MigrationPendingError);

    await runner.migrate();
    const rows = await store.read();
    assert.deepStrictEqual(
      rows.map((r) => [r.version, r.status, r.description]),
      [
        [1, 'completed', 'migration 1'],
        [2, 'completed', 'migration 2'],
      ],
    );

    await runner.rollback({ to: 0 });
    assert.deepStrictEqual(await store.read(), [], '回滚会把版本表的记录删掉');
  } finally {
    db.close();
  }
});

test('migration: 状态对象里的四个字段都是**版本号数组**（同一结构不混类型）', async () => {
  // 曾经的形状：applied/interrupted/unknown 是 number[]，pending 却是 Migration[] ——
  // CLI 打印"待应用"时输出 v[object Object] 才暴露出来。
  const runner = createMigrationRunner({
    store: createMemoryMigrationStore(),
    migrations: [
      { version: 1, description: 'a', async up() {} },
      { version: 2, description: 'b', async up() {} },
    ],
  });
  const status = await runner.status();
  for (const [field, value] of Object.entries(status)) {
    assert.ok(
      Array.isArray(value) && value.every((item) => typeof item === 'number'),
      `status.${field} 应当是 number[]，实际 ${JSON.stringify(value)}`,
    );
  }
});
