import { test } from 'node:test';
import assert from 'node:assert';

import { createDatabase, createMysqlDriver, createPgDriver, defineModel } from '../src/index.ts';

/**
 * pg / mysql 的 schema 路径离线测不了真库，但**可以测契约**：
 *   - 内省 SQL 长什么样（information_schema 的查法）；
 *   - 建表/建索引/加列时实际发出去的 SQL 文本；
 *   - mysql 不支持 `CREATE INDEX IF NOT EXISTS` → 已存在同名索引时要**容忍**而不是炸。
 */

const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'string', length: 200, notNull: true },
    ownerId: { type: 'string', column: 'owner_id' },
  },
  indexes: [{ fields: ['ownerId'], name: 'notes_owner_idx' }],
});

function fakePgBackend(options: { tables?: string[]; columns?: Record<string, unknown>[] } = {}) {
  const calls: string[] = [];
  const tables = new Set(options.tables ?? []);
  const columns = options.columns ?? [];
  class FakePool {
    async query(sql: string, params: unknown[] = []) {
      calls.push(sql);
      if (/from information_schema\.tables/i.test(sql)) {
        return { rows: tables.has(String(params[0])) ? [{ '?column?': 1 }] : [], rowCount: 1 };
      }
      if (/from information_schema\.columns/i.test(sql)) {
        return { rows: columns, rowCount: columns.length };
      }
      // 建表语句是字面量 SQL（无参数）→ 表名必须从文本里取
      const created = /^create table(?: if not exists)?\s+["`]?([\w.]+)["`]?/i.exec(sql.trim());
      if (created !== null) tables.add(created[1]);
      return { rows: [], rowCount: 0 };
    }
    async connect() {
      return this;
    }
    async end() {
      /* closed */
    }
  }
  return { module: { Pool: FakePool }, calls, tables };
}

function fakeMysqlBackend(options: { tables?: string[]; columns?: Record<string, unknown>[]; duplicateIndex?: boolean } = {}) {
  const calls: string[] = [];
  const tables = new Set(options.tables ?? []);
  const columns = options.columns ?? [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push(sql);
      if (/from information_schema\.tables/i.test(sql)) return [tables.has(String(params[0])) ? [{ n: 1 }] : [], []];
      if (/from information_schema\.columns/i.test(sql)) return [columns, []];
      if (/^create index/i.test(sql.trim()) && options.duplicateIndex === true) {
        const err = new Error("Duplicate key name 'notes_owner_idx'") as Error & { code?: string };
        err.code = 'ER_DUP_KEYNAME';
        throw err;
      }
      // 建表语句是字面量 SQL（无参数）→ 表名必须从文本里取
      const created = /^create table(?: if not exists)?\s+["`]?([\w.]+)["`]?/i.exec(sql.trim());
      if (created !== null) tables.add(created[1]);
      return [{ affectedRows: 0 }, []];
    },
    async getConnection() {
      return this;
    },
    async end() {
      /* closed */
    },
  };
  return { module: { createPool: () => pool }, calls, tables };
}

test('schema/pg: 建表 + 建索引 + 内省走 information_schema（SQL 文本可对照）', async () => {
  const fake = fakePgBackend();
  const db = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'h', database: 'd' },
    driver: createPgDriver(async () => fake.module),
  });
  await db.connect();
  try {
    const report = await db.sync([Note]);
    assert.deepStrictEqual(report.created, ['notes']);
    const ddl = fake.calls.filter((sql) => /^create (table|index)/i.test(sql.trim()));
    assert.strictEqual(ddl.length, 2, `应当发出一条 CREATE TABLE 与一条 CREATE INDEX，实际：${JSON.stringify(ddl)}`);
    assert.match(ddl[0], /^CREATE TABLE IF NOT EXISTS "notes"/);
    assert.match(ddl[1], /^CREATE INDEX IF NOT EXISTS "notes_owner_idx" ON "notes" \("owner_id"\)/);
    assert.ok(
      fake.calls.some((sql) => /information_schema\.tables/i.test(sql)),
      '没有用 information_schema.tables 判断表是否存在',
    );
    // 表**不存在**时不该去查列内省（那是浪费）——列内省的断言放在下面"表已存在"的用例里
    assert.ok(
      !fake.calls.some((sql) => /information_schema\.columns/i.test(sql)),
      '建表路径不该查列内省',
    );
  } finally {
    await db.close();
  }
});

test('schema/pg: 缺列时 sync 报漂移，指定 migrations.auto 才自动加列', async () => {
  const fake = fakePgBackend({
    tables: ['notes'],
    columns: [
      { column_name: 'id', is_nullable: 'NO', data_type: 'uuid' },
      // 真 pg 会一起报 character_maximum_length；假数据漏了它就会被判成 varchar ≠ varchar(200)
      { column_name: 'title', is_nullable: 'NO', data_type: 'character varying', character_maximum_length: 200 },
    ],
  });
  const strict = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'h', database: 'd' },
    driver: createPgDriver(async () => fake.module),
  });
  await strict.connect();
  try {
    await assert.rejects(() => strict.sync([Note]), /owner_id|SchemaDrift/i);
    assert.ok(
      fake.calls.some((sql) => /information_schema\.columns/i.test(sql) && /table_name/i.test(sql)),
      '没有用 information_schema.columns 做列内省',
    );
    assert.ok(!fake.calls.some((sql) => /^alter table/i.test(sql.trim())), '没开 auto 却改了表');
  } finally {
    await strict.close();
  }

  const auto = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'h', database: 'd' },
    migrations: { auto: true },
    driver: createPgDriver(async () => fake.module),
  });
  await auto.connect();
  try {
    const report = await auto.sync([Note]);
    assert.ok(report.altered.includes('notes'), `auto=true 应当加列并报告：${JSON.stringify(report)}`);
    assert.ok(
      fake.calls.some((sql) => /^ALTER TABLE "notes" ADD COLUMN "owner_id"/i.test(sql.trim())),
      `自动加列的 SQL 不对：${JSON.stringify(fake.calls.filter((s) => /alter/i.test(s)))}`,
    );
  } finally {
    await auto.close();
  }
});

test('schema/mysql: 已存在的索引名要容忍（mysql 不支持 CREATE INDEX IF NOT EXISTS）', async () => {
  const fake = fakeMysqlBackend({
    tables: ['notes'],
    duplicateIndex: true,
    columns: [
      { column_name: 'id', is_nullable: 'NO', column_type: 'char(36)' },
      { column_name: 'title', is_nullable: 'NO', column_type: 'varchar(200)' },
      { column_name: 'owner_id', is_nullable: 'YES', column_type: 'varchar(255)' },
    ],
  });
  const db = createDatabase({
    dialect: 'mysql',
    connection: { host: 'h', database: 'd' },
    driver: createMysqlDriver(async () => fake.module),
  });
  await db.connect();
  try {
    // 表已存在 + 索引已存在：sync 不该炸
    const report = await db.sync([Note]);
    assert.deepStrictEqual(report.created, []);
    assert.ok(
      fake.calls.some((sql) => /^CREATE INDEX `notes_owner_idx`/i.test(sql.trim())),
      'mysql 的建索引语句没有用反引号/没有去掉 IF NOT EXISTS',
    );
    // 表在、索引重复 → 报告里 indexes 不应当包含它（没真的建）
    assert.ok(!report.indexes.includes('notes_owner_idx'));
  } finally {
    await db.close();
  }
});

test('schema/pg: 注释走独立的 COMMENT ON 语句（默认只在建表时写）', async () => {
  // 表建好之后第二次 sync 会做列内省，所以假驱动要给出与 model 一致的列
  const fake = fakePgBackend({
    columns: [
      { column_name: 'id', is_nullable: 'NO', data_type: 'uuid' },
      { column_name: 'title', is_nullable: 'YES', data_type: 'character varying', character_maximum_length: 200 },
    ],
  });
  const Commented = defineModel({
    name: 'notes',
    comment: '用户笔记',
    fields: {
      id: { type: 'uuid', primaryKey: true },
      title: { type: 'string', length: 200, comment: "标题（it's ok）" },
    },
  });
  const db = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'h', database: 'd' },
    driver: createPgDriver(async () => fake.module),
  });
  await db.connect();
  try {
    const report = await db.sync([Commented]);
    const comments = fake.calls.filter((sql) => /^COMMENT ON /i.test(sql.trim()));
    assert.deepStrictEqual(
      comments,
      [`COMMENT ON TABLE "notes" IS '用户笔记'`, `COMMENT ON COLUMN "notes"."title" IS '标题（it''s ok）'`],
      `COMMENT 语句不对：${JSON.stringify(comments)}`,
    );
    assert.deepStrictEqual(report.comments, ['notes', 'notes.title']);
    assert.deepStrictEqual(report.unsupportedComments, []);

    // 再 sync 一次（表已存在）：**默认不再动注释**（注释更新不是自动的）
    const before = fake.calls.filter((sql) => /^COMMENT ON /i.test(sql)).length;
    const second = await db.sync([Commented]);
    const after = fake.calls.filter((sql) => /^COMMENT ON /i.test(sql)).length;
    assert.strictEqual(after - before, 0, '默认（comments: create）下不该更新已存在表的注释');
    assert.deepStrictEqual(second.comments, []);
    assert.ok(
      second.unsupportedComments.some((item) => item.includes('only applied when the table is created')),
      `应当如实说明注释策略：${JSON.stringify(second.unsupportedComments)}`,
    );
  } finally {
    await db.close();
  }
});
