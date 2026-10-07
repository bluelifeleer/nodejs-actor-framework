import { test } from 'node:test';
import assert from 'node:assert';

import {
  columnTypeFor,
  createDatabase,
  defaultParseValue,
  defaultSerializeValue,
  defineModel,
  DbConfigError,
} from '../src/index.ts';

/** 用户反馈：① 数据类型不够（要有 bigText 等）；② 字段缺注释（JSDoc + 列注释）。 */

test('types: 新增类型逐个对照三方言（bigText / smallint / decimal / date / time / binary）', () => {
  const cases: Array<[string, string, string, string]> = [
    // 逻辑类型, pgsql, mysql, sqlite
    ['bigText', 'text', 'longtext', 'text'],
    ['smallint', 'smallint', 'smallint', 'integer'],
    ['date', 'date', 'date', 'text'],
    ['time', 'time', 'time', 'text'],
    ['binary', 'bytea', 'varbinary(255)', 'blob'],
  ];
  for (const [logical, pg, my, lite] of cases) {
    assert.strictEqual(columnTypeFor('pgsql', logical as never), pg, `pgsql ${logical}`);
    assert.strictEqual(columnTypeFor('mysql', logical as never), my, `mysql ${logical}`);
    assert.strictEqual(columnTypeFor('sqlite', logical as never), lite, `sqlite ${logical}`);
  }
  // decimal 要 precision/scale；没给就用默认值（10,2），不猜成浮点
  assert.strictEqual(columnTypeFor('pgsql', 'decimal'), 'numeric(10, 2)');
  assert.strictEqual(columnTypeFor('mysql', 'decimal'), 'decimal(10, 2)');
  assert.strictEqual(columnTypeFor('sqlite', 'decimal'), 'numeric(10, 2)');
  assert.strictEqual(columnTypeFor('pgsql', 'decimal', { precision: 18, scale: 4 }), 'numeric(18, 4)');
  assert.strictEqual(columnTypeFor('mysql', 'decimal', { precision: 18, scale: 4 }), 'decimal(18, 4)');
  // binary 可以给长度
  assert.strictEqual(columnTypeFor('mysql', 'binary', { length: 16 }), 'varbinary(16)');
  // 未知类型仍然报错
  assert.throws(() => columnTypeFor('pgsql', 'money' as never), DbConfigError);
});

test('types: date/time 的默认解析与序列化（Date ↔ 文本，不外泄时区）', () => {
  const dateField = defineModel({
    name: 'd',
    fields: { id: { type: 'string', primaryKey: true }, on: { type: 'date' } },
  }).fieldFor('on');
  const timeField = defineModel({
    name: 't',
    fields: { id: { type: 'string', primaryKey: true }, at: { type: 'time' } },
  }).fieldFor('at');

  // 解析：字符串保持"日期/时间"形态；Date 归一成同样的文本
  assert.strictEqual(defaultParseValue('sqlite', dateField, '2026-10-07'), '2026-10-07');
  assert.strictEqual(defaultParseValue('pgsql', dateField, new Date('2026-10-07T00:00:00Z')), '2026-10-07');
  assert.strictEqual(defaultParseValue('sqlite', timeField, '13:45:06'), '13:45:06');
  assert.strictEqual(defaultParseValue('pgsql', timeField, new Date('2026-10-07T13:45:06Z')), '13:45:06');

  // 序列化：Date → 文本；非法输入要报错（不静默写坏数据）
  assert.strictEqual(defaultSerializeValue('mysql', dateField, new Date('2026-10-07T05:00:00Z')), '2026-10-07');
  assert.strictEqual(defaultSerializeValue('mysql', dateField, '2026-10-07'), '2026-10-07');
  assert.strictEqual(defaultSerializeValue('mysql', timeField, new Date('2026-10-07T05:06:07Z')), '05:06:07');
  assert.throws(() => defaultSerializeValue('mysql', dateField, 'not-a-date'), DbConfigError);
});

test('comments: model/字段注释会进 DDL（mysql 内联），pg 走独立 COMMENT 语句', () => {
  const Note = defineModel({
    name: 'notes',
    comment: '用户笔记',
    fields: {
      id: { type: 'uuid', primaryKey: true },
      title: { type: 'string', length: 200, notNull: true, comment: "标题（it's required）" },
    },
  });

  // mysql：列注释内联 + 表注释在末尾
  const mysql = Note.createTableSql('mysql');
  assert.match(mysql, /`title` varchar\(200\) NOT NULL COMMENT '标题（it''s required）'/, `mysql 列注释不对：${mysql}`);
  assert.match(mysql, /\) COMMENT='用户笔记'$/, `mysql 表注释不对：${mysql}`);

  // pg/sqlite 的 CREATE TABLE 不带注释（pg 用独立语句；sqlite 不支持）
  assert.ok(!Note.createTableSql('pgsql').includes('COMMENT'), 'pg 的 CREATE TABLE 不该内联注释');
  assert.ok(!Note.createTableSql('sqlite').includes('COMMENT'), 'sqlite 的 CREATE TABLE 不该内联注释');

  // pg：独立 COMMENT 语句（列 + 表），引号转义
  const statements = Note.commentSql('pgsql');
  assert.deepStrictEqual(statements, [
    `COMMENT ON TABLE "notes" IS '用户笔记'`,
    `COMMENT ON COLUMN "notes"."title" IS '标题（it''s required）'`,
  ]);
  // sqlite：没有列/表注释这回事 → 如实返回空数组（不假装）
  assert.deepStrictEqual(Note.commentSql('sqlite'), []);
  // mysql 也返回空数组（注释已经在建表语句里，不能再发一次）
  assert.deepStrictEqual(Note.commentSql('mysql'), []);
});

test('comments: 没有注释时不生成任何 COMMENT 语句（不留噪声）', () => {
  const Plain = defineModel({ name: 'plain', fields: { id: { type: 'string', primaryKey: true } } });
  assert.deepStrictEqual(Plain.commentSql('pgsql'), []);
  assert.ok(!Plain.createTableSql('mysql').includes('COMMENT'));
});

test('comments: mysql 的注释长度上限（1024）要提前报错，而不是被数据库静默截断', () => {
  const long = 'x'.repeat(1025);
  assert.throws(
    () => defineModel({ name: 'n', fields: { id: { type: 'string', primaryKey: true, comment: long } } }).createTableSql('mysql'),
    /1024|too long/i,
  );
  // 1024 以内没问题
  const ok = 'x'.repeat(1024);
  assert.match(
    defineModel({ name: 'n', fields: { id: { type: 'string', primaryKey: true, comment: ok } } }).createTableSql('mysql'),
    /COMMENT 'x{1024}'/,
  );
});

test('comments: sync 会应用 pg 的 COMMENT 语句，并如实报告 sqlite 不支持注释', async () => {
  // sqlite 真库：sync 不该崩，且报告里说明注释没被应用
  const db = createDatabase({ dialect: 'sqlite', connection: { filename: ':memory:' } });
  await db.connect();
  try {
    const Note = defineModel({
      name: 'notes',
      comment: '用户笔记',
      fields: { id: { type: 'string', primaryKey: true }, title: { type: 'string', comment: '标题' } },
    });
    const report = await db.sync([Note]);
    assert.deepStrictEqual(report.created, ['notes']);
    assert.deepStrictEqual(report.comments, [], 'sqlite 不该假装应用了注释');
    assert.ok(
      report.unsupportedComments.some((item) => item.includes('notes')),
      `sqlite 的注释不支持要如实报告：${JSON.stringify(report.unsupportedComments)}`,
    );
  } finally {
    await db.close();
  }
});
