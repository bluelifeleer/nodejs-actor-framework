import { test } from 'node:test';
import assert from 'node:assert';

import { createSqlRepository } from '@actor/data';

import { createDatabase } from '../src/index.ts';

/**
 * 设计里最重要的一条分工：`@actor/db` 负责**连接与方言**，`@actor/data` 负责**仓储语义**
 * （乐观锁冲突错误、游标分页……）。两者通过**结构兼容**的 runner 组合 —— `db.runner()` 直接喂给
 * `createSqlRepository`，双方都不 import 对方（`@actor/db` 只在 devDependencies 里引 data 做测试）。
 */
test('compose: db.runner() 直接喂给 @actor/data 的 createSqlRepository（结构兼容，不互相依赖）', async () => {
  const db = createDatabase({ dialect: 'sqlite', connection: { filename: ':memory:' } });
  await db.connect();
  try {
    await db.rawRun('CREATE TABLE notes (id TEXT PRIMARY KEY, version INTEGER NOT NULL, title TEXT NOT NULL)');
    const notes = createSqlRepository<{ id: string; version: number; title: string }>({
      runner: db.runner(), // ← 关键：无需适配器
      table: 'notes',
      fields: ['id', 'version', 'title'],
    });

    await notes.insert({ id: 'n1', title: 'first' });
    const found = await notes.findById('n1');
    assert.strictEqual(found?.title, 'first');

    // 乐观锁：@actor/data 的语义（版本对不上抛它自己的冲突错误）在 db 的 runner 上照样成立
    await notes.update('n1', { title: 'second' }, { expectedVersion: found?.version });
    await assert.rejects(
      () => notes.update('n1', { title: 'third' }, { expectedVersion: 1 }),
      (err: Error) => {
        assert.match(err.name, /Conflict/);
        return true;
      },
    );
    // 而且 @actor/data 的事务也走 db 的事务
    await notes.transaction?.(async (tx) => {
      await tx.update('n1', { title: 'in-tx' }, { expectedVersion: 2 });
    });
    assert.strictEqual((await notes.findById('n1'))?.title, 'in-tx');
  } finally {
    await db.close();
  }
});
