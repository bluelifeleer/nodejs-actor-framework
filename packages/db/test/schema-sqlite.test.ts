import { test } from 'node:test';
import assert from 'node:assert';

import { createDatabase, defineModel } from '../src/index.ts';

/** sqlite 真库：建表、幂等、漂移检测、受控自动迁移。 */
const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'string', length: 200, notNull: true },
    body: { type: 'text', default: '' },
    tags: { type: 'json', default: [] },
    ownerId: { type: 'string', column: 'owner_id' },
    version: { type: 'integer', version: true },
  },
  indexes: [{ fields: ['ownerId'], unique: false }],
});

async function sqliteDb(extra: Record<string, unknown> = {}) {
  const db = createDatabase({ dialect: 'sqlite', connection: { filename: ':memory:' }, ...extra });
  await db.connect();
  return db;
}

test('schema/sqlite: sync 建表 + 索引，重复 sync 幂等', async () => {
  const db = await sqliteDb();
  try {
    const first = await db.sync([Note]);
    assert.deepStrictEqual(first.created, ['notes'], `第一次 sync 应当建表，实际：${JSON.stringify(first)}`);
    assert.ok(first.indexes.length >= 1, '索引没有被创建');

    const table = await db.inspectTable('notes');
    assert.deepStrictEqual(
      table.columns.map((c) => c.name).sort(),
      ['body', 'id', 'owner_id', 'tags', 'title', 'version'],
      `列不对：${JSON.stringify(table.columns)}`,
    );
    assert.strictEqual(table.columns.find((c) => c.name === 'title')?.notNull, true);

    const second = await db.sync([Note]);
    assert.deepStrictEqual(second.created, [], '第二次 sync 不该再建表（幂等）');
    assert.deepStrictEqual(second.altered, []);
  } finally {
    await db.close();
  }
});

test('schema/sqlite: 漂移检测 —— 库里缺列必须明确报错，并指出缺哪一列', async () => {
  const db = await sqliteDb();
  try {
    // 手工建一个"少了 owner_id"的同名表
    await db.rawRun('CREATE TABLE "notes" ("id" text NOT NULL PRIMARY KEY, "title" text NOT NULL)');
    await assert.rejects(
      () => db.sync([Note]),
      (err: Error & { code?: string; drift?: unknown }) => {
        assert.match(err.name, /SchemaDrift/);
        assert.match(err.message, /owner_id|ownerId/);
        assert.match(err.message, /body|tags|version/); // 其它缺列也要列出来，而不是只说一个
        return true;
      },
    );
  } finally {
    await db.close();
  }
});

test('schema/sqlite: migrations.auto=true 时自动加列（并如实报告改了什么）', async () => {
  const db = await sqliteDb({ migrations: { auto: true } });
  try {
    await db.rawRun('CREATE TABLE "notes" ("id" text NOT NULL PRIMARY KEY, "title" text NOT NULL)');
    const report = await db.sync([Note]);
    assert.deepStrictEqual(report.created, [], '表已存在，不该报 created');
    assert.ok(
      report.altered.includes('notes'),
      `自动迁移没有执行/没有报告：${JSON.stringify(report)}`,
    );
    const table = await db.inspectTable('notes');
    assert.ok(table.columns.some((c) => c.name === 'owner_id'), '自动加列没有生效');
  } finally {
    await db.close();
  }
});

test('schema/sqlite: 自动迁移只做**安全**操作 —— 缺 NOT NULL 且无默认值的列必须拒绝', async () => {
  const Strict = defineModel({
    name: 'strict',
    fields: {
      id: { type: 'uuid', primaryKey: true },
      must: { type: 'string', notNull: true }, // 没有默认值：对已有行无法安全补齐
    },
  });
  const db = await sqliteDb({ migrations: { auto: true } });
  try {
    await db.rawRun('CREATE TABLE "strict" ("id" text NOT NULL PRIMARY KEY)');
    await assert.rejects(
      () => db.sync([Strict]),
      (err: Error) => {
        assert.match(err.name, /SchemaDrift|Config/);
        assert.match(err.message, /must/);
        assert.match(err.message, /NOT NULL|default/i);
        return true;
      },
      '不安全的三自动迁移必须被拒绝（否则等于静默丢语义）',
    );
  } finally {
    await db.close();
  }
});

test('schema/sqlite: 类型不符要报告（规范化的宽松比较，不假装能认出所有别名）', async () => {
  const db = await sqliteDb();
  try {
    // owner_id 在库里是 INTEGER，model 说它是 string
    await db.rawRun(
      'CREATE TABLE "notes" ("id" text NOT NULL PRIMARY KEY, "title" text NOT NULL, "body" text, "tags" text, "owner_id" integer, "version" integer)',
    );
    const drift = await db.checkDrift(Note);
    assert.strictEqual(drift.ok, false);
    assert.ok(
      drift.typeMismatches.some((m) => m.column === 'owner_id'),
      `类型不一致没有被报告：${JSON.stringify(drift)}`,
    );
  } finally {
    await db.close();
  }
});
