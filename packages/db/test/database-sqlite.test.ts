import { test } from 'node:test';
import assert from 'node:assert';

import { createDatabase } from '../src/index.ts';

/**
 * sqlite 用 **Node 24 内置的 `node:sqlite`**：零依赖、可离线、跑的是**真 SQL** ——
 * 所以连接池/runner/事务这些"骨架"可以用真数据库验证，而不是打桩。
 */
function sqliteDb(connection: Record<string, unknown> = { filename: ':memory:' }) {
  return createDatabase({ dialect: 'sqlite', connection });
}

test('db/sqlite: connect → healthCheck → raw/rawRun → close（幂等）', async () => {
  const db = sqliteDb();
  assert.strictEqual(db.dialect, 'sqlite');
  await db.connect();

  const health = await db.healthCheck();
  assert.strictEqual(health.ok, true, `健康检查失败：${String(health.error)}`);
  assert.ok(typeof health.latencyMs === 'number');

  await db.rawRun('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const inserted = await db.rawRun('INSERT INTO t (name) VALUES (?)', ['a']);
  assert.strictEqual(inserted, 1, 'rawRun 应返回受影响行数');

  const rows = await db.raw<{ id: number; name: string }>('SELECT id, name FROM t ORDER BY id');
  assert.deepStrictEqual(rows.map((r) => r.name), ['a']);

  await db.close();
  await db.close(); // 幂等
  const afterClose = await db.healthCheck();
  assert.strictEqual(afterClose.ok, false, '关闭之后健康检查必须为 false（不能假装还活着）');
});

test('db/sqlite: runner() 的形状与 @actor/data 的 SqlRunner 兼容（all/run/transaction）', async () => {
  const db = sqliteDb();
  await db.connect();
  try {
    const runner = db.runner();
    await runner.run('CREATE TABLE docs (id TEXT PRIMARY KEY, version INTEGER NOT NULL, owner TEXT)');
    await runner.run('INSERT INTO docs (id, version, owner) VALUES (?, ?, ?)', ['d1', 1, 'alice']);
    const rows = await runner.all('SELECT * FROM docs WHERE id = ?', ['d1']);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].owner, 'alice');

    // 真事务：回滚之后写入必须不存在
    await runner.transaction?.(async (scoped) => {
      await scoped.run('INSERT INTO docs (id, version, owner) VALUES (?, ?, ?)', ['d2', 1, 'bob']);
      throw new Error('rollback please');
    }).catch(() => null);
    const after = await runner.all('SELECT id FROM docs ORDER BY id');
    assert.deepStrictEqual(after.map((r) => r.id), ['d1'], '事务回滚没有生效（d2 竟然留下了）');
  } finally {
    await db.close();
  }
});

test('db/sqlite: 事务提交后写入必须留下', async () => {
  const db = sqliteDb();
  await db.connect();
  try {
    const runner = db.runner();
    await runner.run('CREATE TABLE n (v INTEGER)');
    await runner.transaction?.(async (scoped) => {
      await scoped.run('INSERT INTO n (v) VALUES (?)', [1]);
      await scoped.run('INSERT INTO n (v) VALUES (?)', [2]);
    });
    const rows = await runner.all('SELECT v FROM n ORDER BY v');
    assert.deepStrictEqual(rows.map((r) => r.v), [1, 2]);
  } finally {
    await db.close();
  }
});

test('db/sqlite: 配置校验 —— 未知方言/缺连接配置要明确报错', async () => {
  assert.throws(() => createDatabase({ dialect: 'oracle' as never, connection: { filename: 'x' } }), /dialect|oracle/i);
  assert.throws(() => createDatabase({ dialect: 'sqlite' } as never), /connection/i);
});
