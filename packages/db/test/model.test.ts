import { test } from 'node:test';
import assert from 'node:assert';

import { defineModel, DbConfigError } from '../src/index.ts';

/**
 * model 层：用户写声明，框架负责归一化、校验、生成 DDL。
 * 这一轮先用**纯函数**把 DDL 文本钉死（pg/mysql 离线也能测），sqlite 用真库（另一个文件）。
 */
const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'string', length: 200, notNull: true },
    body: { type: 'text', default: '' },
    tags: { type: 'json', default: [] },
    ownerId: { type: 'string', column: 'owner_id' },
    createdAt: { type: 'timestamp', auto: 'create' },
    updatedAt: { type: 'timestamp', auto: 'update' },
    version: { type: 'integer', version: true },
  },
  indexes: [
    { fields: ['ownerId'], unique: false },
    { fields: ['title'], unique: true, name: 'notes_title_key' },
  ],
});

test('model: 归一化 —— 列名/主键/版本字段/自增时间戳/索引都能读出来', () => {
  assert.strictEqual(Note.name, 'notes');
  assert.strictEqual(Note.table, 'notes'); // 默认表名 = name
  assert.strictEqual(Note.primaryKey, 'id');
  assert.strictEqual(Note.versionField, 'version');
  assert.strictEqual(Note.fields.length, 8);
  const owner = Note.fields.find((f) => f.name === 'ownerId');
  assert.strictEqual(owner?.column, 'owner_id', 'column 映射没有被保留');
  const created = Note.fields.find((f) => f.name === 'createdAt');
  assert.strictEqual(created?.auto, 'create');
  assert.strictEqual(Note.indexes.length, 2);
  assert.strictEqual(Note.indexes[1].unique, true);
  assert.strictEqual(Note.indexes[1].name, 'notes_title_key');
  // 默认索引名是确定性的（table_columns 形式），不能每次不一样
  assert.match(Note.indexes[0].name, /^notes_owner_id/);
});

test('model: 校验 —— 未知类型/没有主键/字段名重复都要明确报错', () => {
  assert.throws(
    () => defineModel({ name: 'x', fields: { a: { type: 'money' as never, primaryKey: true } } }),
    /unknown|type/i,
  );
  assert.throws(() => defineModel({ name: 'x', fields: { a: { type: 'string' } } }), /primary key/i);
  assert.throws(
    () => defineModel({ name: 'x', fields: { a: { type: 'string', primaryKey: true }, b: { type: 'string', primaryKey: true } } }),
    /primary key/i,
  );
  assert.throws(() => defineModel({ name: '', fields: { a: { type: 'string', primaryKey: true } } }), /name/i);
  assert.throws(
    () =>
      defineModel({
        name: 'x',
        fields: { a: { type: 'string', primaryKey: true }, b: { type: 'string', column: 'a' } },
      }),
    /column/i,
  );
});

test('model: CREATE TABLE 文本 —— 三个方言逐条可对照', () => {
  assert.strictEqual(
    Note.createTableSql('sqlite'),
    'CREATE TABLE IF NOT EXISTS "notes" (' +
      '"id" text NOT NULL PRIMARY KEY, ' +
      '"title" text NOT NULL, ' +
      '"body" text DEFAULT \'\', ' +
      '"tags" text DEFAULT \'[]\', ' +
      '"owner_id" text, ' +
      '"createdAt" text, ' +
      '"updatedAt" text, ' +
      '"version" integer NOT NULL DEFAULT 0' +
      ')',
  );
  assert.strictEqual(
    Note.createTableSql('pgsql'),
    'CREATE TABLE IF NOT EXISTS "notes" (' +
      '"id" uuid NOT NULL PRIMARY KEY, ' +
      '"title" varchar(200) NOT NULL, ' +
      '"body" text DEFAULT \'\', ' +
      '"tags" jsonb DEFAULT \'[]\'::jsonb, ' +
      '"owner_id" text, ' +
      '"createdAt" timestamptz, ' +
      '"updatedAt" timestamptz, ' +
      '"version" integer NOT NULL DEFAULT 0' +
      ')',
  );
  assert.strictEqual(
    Note.createTableSql('mysql'),
    'CREATE TABLE IF NOT EXISTS `notes` (' +
      '`id` char(36) NOT NULL PRIMARY KEY, ' +
      '`title` varchar(200) NOT NULL, ' +
      '`body` text, ' +
      '`tags` json, ' +
      '`owner_id` varchar(255), ' +
      '`createdAt` datetime(3), ' +
      '`updatedAt` datetime(3), ' +
      '`version` int NOT NULL DEFAULT 0' +
      ')',
  );
});

test('model: CREATE INDEX 文本 —— mysql 不支持 IF NOT EXISTS（要按方言区分）', () => {
  const plain = Note.indexes[0];
  const unique = Note.indexes[1];
  assert.strictEqual(
    Note.createIndexSql('pgsql', plain),
    'CREATE INDEX IF NOT EXISTS "notes_owner_id" ON "notes" ("owner_id")',
  );
  assert.strictEqual(
    Note.createIndexSql('pgsql', unique),
    'CREATE UNIQUE INDEX IF NOT EXISTS "notes_title_key" ON "notes" ("title")',
  );
  assert.strictEqual(Note.createIndexSql('mysql', plain), 'CREATE INDEX `notes_owner_id` ON `notes` (`owner_id`)');
  assert.strictEqual(Note.createIndexSql('sqlite', unique), 'CREATE UNIQUE INDEX IF NOT EXISTS "notes_title_key" ON "notes" ("title")');
});

test('model: 加列文本（自动迁移只允许安全操作）', () => {
  const extra = defineModel({
    name: 'notes',
    fields: { id: { type: 'uuid', primaryKey: true }, ownerId: { type: 'string', column: 'owner_id' } },
  });
  const ownerField = extra.fields.find((f) => f.name === 'ownerId');
  assert.ok(ownerField);
  assert.strictEqual(
    extra.addColumnSql('pgsql', ownerField),
    'ALTER TABLE "notes" ADD COLUMN "owner_id" text',
  );
  assert.strictEqual(
    extra.addColumnSql('mysql', ownerField),
    'ALTER TABLE `notes` ADD COLUMN `owner_id` varchar(255)',
  );
});

test('model: 字符串/布尔/时间戳默认值的字面量渲染（不同方言不一样）', () => {
  const m = defineModel({
    name: 'flags',
    fields: {
      id: { type: 'uuid', primaryKey: true },
      label: { type: 'string', default: "it's fine" },
      active: { type: 'boolean', default: true },
      score: { type: 'real', default: 1.5 },
    },
  });
  const sql = m.createTableSql('sqlite');
  assert.match(sql, /"label" text DEFAULT 'it''s fine'/, '单引号必须转义（否则默认值能破坏 DDL）');
  assert.match(sql, /"active" integer DEFAULT 1/);
  assert.match(sql, /"score" real DEFAULT 1.5/);
  const mysql = m.createTableSql('mysql');
  assert.match(mysql, /`active` tinyint\(1\) DEFAULT 1/);
});

test('model: 表名里的引号要转义（标识符不能逃逸）', () => {
  const weird = defineModel({ name: 'we"ird', fields: { id: { type: 'string', primaryKey: true } } });
  assert.match(weird.createTableSql('pgsql'), /^CREATE TABLE IF NOT EXISTS "we""ird"/);
  assert.throws(() => defineModel({ name: 'x; DROP TABLE y', fields: { id: { type: 'string', primaryKey: true } } }), /name/i);
});

test('model: 未知方言/未知逻辑类型走同一个配置错误类型', () => {
  assert.throws(() => Note.createTableSql('oracle' as never), DbConfigError);
});
