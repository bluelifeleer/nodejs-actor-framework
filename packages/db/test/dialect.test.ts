import { test } from 'node:test';
import assert from 'node:assert';

import { columnTypeFor, dialectFor, parseConnection, placeholderFor, quoteIdentifier, quoteTable } from '../src/index.ts';

/**
 * 方言层是"三个数据库能共用一套查询构造"的前提：占位符、标识符引号、类型映射这三件事
 * 每个方言都不同，必须集中在一处，且**逐条可对照**（不靠"大概对"）。
 */
test('dialect: 占位符风格 —— pg 用 $n，mysql/sqlite 用 ?', () => {
  assert.strictEqual(placeholderFor('pgsql')(1), '$1');
  assert.strictEqual(placeholderFor('pgsql')(7), '$7');
  assert.strictEqual(placeholderFor('mysql')(1), '?');
  assert.strictEqual(placeholderFor('mysql')(7), '?');
  assert.strictEqual(placeholderFor('sqlite')(1), '?');
});

test('dialect: 标识符引号 —— pg/sqlite 双引号，mysql 反引号；名字里的引号要转义', () => {
  assert.strictEqual(quoteIdentifier('pgsql', 'notes'), '"notes"');
  assert.strictEqual(quoteIdentifier('sqlite', 'notes'), '"notes"');
  assert.strictEqual(quoteIdentifier('mysql', 'notes'), '`notes`');
  // 标识符里出现同种引号：翻倍转义（防注入经由标识符）
  assert.strictEqual(quoteIdentifier('pgsql', 'we"ird'), '"we""ird"');
  assert.strictEqual(quoteIdentifier('mysql', 'we`ird'), '`we``ird`');
  assert.strictEqual(quoteTable('pgsql', 'public', 'notes'), '"public"."notes"');
  assert.strictEqual(quoteTable('mysql', 'app', 'notes'), '`app`.`notes`');
});

test('dialect: 逻辑类型 → 各方言真实列类型', () => {
  const cases: Array<[string, string, string, string]> = [
    // 逻辑类型, pgsql, mysql, sqlite
    ['uuid', 'uuid', 'char(36)', 'text'],
    ['string', 'text', 'varchar(255)', 'text'],
    ['text', 'text', 'text', 'text'],
    ['integer', 'integer', 'int', 'integer'],
    ['bigint', 'bigint', 'bigint', 'integer'],
    ['real', 'double precision', 'double', 'real'],
    ['boolean', 'boolean', 'tinyint(1)', 'integer'],
    ['timestamp', 'timestamptz', 'datetime(3)', 'text'],
    ['json', 'jsonb', 'json', 'text'],
    ['blob', 'bytea', 'blob', 'blob'],
  ];
  for (const [logical, pg, my, lite] of cases) {
    assert.strictEqual(columnTypeFor('pgsql', logical as never), pg, `pgsql ${logical}`);
    assert.strictEqual(columnTypeFor('mysql', logical as never), my, `mysql ${logical}`);
    assert.strictEqual(columnTypeFor('sqlite', logical as never), lite, `sqlite ${logical}`);
  }
  // string 带长度：三种方言都要尊重它
  assert.strictEqual(columnTypeFor('pgsql', 'string', { length: 64 }), 'varchar(64)');
  assert.strictEqual(columnTypeFor('mysql', 'string', { length: 64 }), 'varchar(64)');
  assert.strictEqual(columnTypeFor('sqlite', 'string', { length: 64 }), 'text');
});

test('dialect: 配置/DSN 解析 —— 支持 DSN 与字段式，默认方言是 pgsql', () => {
  assert.strictEqual(dialectFor({}), 'pgsql');
  assert.strictEqual(dialectFor({ dialect: 'mysql' }), 'mysql');

  const pg = parseConnection({ url: 'pgsql://alice:s3cret@db.internal:5433/appdb' });
  assert.deepStrictEqual(
    { dialect: pg.dialect, host: pg.host, port: pg.port, user: pg.user, database: pg.database },
    { dialect: 'pgsql', host: 'db.internal', port: 5433, user: 'alice', database: 'appdb' },
  );
  assert.strictEqual(pg.password, 's3cret');

  const my = parseConnection({ url: 'mysql://bob@localhost/appdb' });
  assert.strictEqual(my.dialect, 'mysql');
  assert.strictEqual(my.port, 3306); // 方言默认端口
  assert.strictEqual(my.user, 'bob');

  const lite = parseConnection({ url: 'sqlite:./data/app.db' });
  assert.strictEqual(lite.dialect, 'sqlite');
  assert.strictEqual(lite.filename, './data/app.db');

  const fields = parseConnection({ dialect: 'pgsql', host: 'h', database: 'd' });
  assert.strictEqual(fields.port, 5432);
  assert.strictEqual(fields.dialect, 'pgsql');
});

test('dialect: DSN 里的密码不得出现在错误信息里', () => {
  assert.throws(
    () => parseConnection({ url: 'pgsql://alice:sup3r-s3cret@h:5432/d' , dialect: 'sqlite' }),
    (err: Error) => {
      assert.ok(!err.message.includes('sup3r-s3cret'), `错误信息泄漏了密码：${err.message}`);
      return true;
    },
  );
});
