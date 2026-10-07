import { test } from 'node:test';
import assert from 'node:assert';

import {
  columnTypeFor,
  defineModel,
  DIALECTS,
  dialectFromUrl,
  dialectSpec,
  parseConnection,
  placeholderFor,
  quoteIdentifier,
} from '../src/index.ts';

/**
 * 第 4 个方言：SQL Server（T-SQL）—— 用来检验"加方言 checklist"是否真的够用。
 *
 * 离线环境装不了 `mssql`、也没有服务器 → 这个方言与 pg/mysql 一样是**契约级验证**
 * （DDL 文本、占位符、内省 SQL、池参数映射、事务归还），**真连库行为未经本仓库验证**。
 */
const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    title: { type: 'string', length: 200, notNull: true },
    tags: { type: 'json', default: [] },
    done: { type: 'boolean', default: false },
    createdAt: { type: 'timestamp', auto: 'create' },
    at: { type: 'dateTime' },
  },
  indexes: [{ fields: ['title'] }],
});

test('mssql: 注册表自动包含新方言（加方言不用改 DIALECTS/端口/驱动名）', () => {
  assert.ok(DIALECTS.includes('mssql' as never), '新方言没进 DIALECTS');
  const spec = dialectSpec('mssql' as never);
  assert.strictEqual(spec.driverPackage, 'mssql');
  assert.strictEqual(spec.defaultPort, 1433);
  assert.strictEqual(spec.connectionKind, 'host');
  assert.strictEqual(placeholderFor('mssql' as never)(3), '@p3');
  assert.strictEqual(quoteIdentifier('mssql' as never, 'a]b'), '[a]]b]', '方括号要翻倍转义');
  assert.strictEqual(spec.supportsReturning, false, 'T-SQL 没有 RETURNING');
});

test('mssql: 类型表逐条对照（含 T-SQL 的经典陷阱：timestamp 是 rowversion）', () => {
  const cases: Array<[string, string]> = [
    ['uuid', 'uniqueidentifier'],
    ['string', 'nvarchar(200)'],
    ['char', 'nchar(1)'],
    ['text', 'nvarchar(max)'],
    ['tinyText', 'nvarchar(max)'],
    ['mediumText', 'nvarchar(max)'],
    ['bigText', 'nvarchar(max)'],
    ['tinyint', 'tinyint'],
    ['smallint', 'smallint'],
    ['integer', 'int'],
    ['bigint', 'bigint'],
    ['decimal', 'decimal(10, 2)'],
    ['float', 'real'],
    ['real', 'float'],
    ['boolean', 'bit'],
    ['date', 'date'],
    ['time', 'time'],
    ['json', 'nvarchar(max)'],
    ['blob', 'varbinary(max)'],
    ['binary', 'varbinary(max)'],
  ];
  for (const [logical, expected] of cases) {
    const options = logical === 'string' ? { length: 200 } : {};
    assert.strictEqual(columnTypeFor('mssql' as never, logical as never, options), expected, `mssql ${logical}`);
  }
  // 陷阱：T-SQL 的 `timestamp` 不是时间戳，是 rowversion（8 字节版本号）——绝不能映射过去
  const tzAware = columnTypeFor('mssql' as never, 'timestamp');
  assert.strictEqual(tzAware, 'datetimeoffset(3)');
  assert.ok(!/rowversion|^timestamp/i.test(tzAware), 'T-SQL 的 timestamp 是 rowversion，不能拿来当时间戳');
  assert.strictEqual(columnTypeFor('mssql' as never, 'dateTime'), 'datetime2(3)', '不带时区的那一个');
  // 没有长度的字符串：T-SQL 用 nvarchar(max)，不是 varchar(255)
  assert.strictEqual(columnTypeFor('mssql' as never, 'string'), 'nvarchar(max)');
  assert.strictEqual(columnTypeFor('mssql' as never, 'binary'), 'varbinary(max)');
});

test('mssql: DDL 必须用 T-SQL 的写法（没有 CREATE TABLE IF NOT EXISTS / ADD COLUMN）', () => {
  const ddl = Note.createTableSql('mssql' as never);
  assert.ok(!/CREATE TABLE IF NOT EXISTS/i.test(ddl), `T-SQL 没有 CREATE TABLE IF NOT EXISTS：${ddl}`);
  assert.match(ddl, /IF OBJECT_ID\(N'\[notes\]', N'U'\) IS NULL/, `建表要先判存在：${ddl}`);
  assert.match(ddl, /CREATE TABLE \[notes\] /);
  // IDENTITY(1,1) 的位置：类型之后、NOT NULL 之前
  assert.match(ddl, /\[id\] int IDENTITY\(1,1\) NOT NULL PRIMARY KEY/, `自增写法不对：${ddl}`);
  // 布尔默认值用 1/0，字符串字面量要带 N 前缀
  assert.match(ddl, /\[done\] bit DEFAULT 0/);
  assert.match(ddl, /\[title\] nvarchar\(200\) NOT NULL/);
  // 动态 SQL 里的字符串字面量要再翻倍一层（EXEC(N'…') 的转义）
  assert.match(ddl, /\[tags\] nvarchar\(max\) DEFAULT N''\[\]''/, `动态 SQL 里的引号要翻倍：${ddl}`);
  // 字面量本身带 N 前缀（Unicode）
  assert.strictEqual(dialectSpec('mssql' as never).defaultLiteral(Note.fieldFor('tags')), "N'[]'");
  assert.strictEqual(
    dialectSpec('mssql' as never).defaultLiteral(Note.fieldFor('title')),
    null,
    '没有默认值的字段不该编一个',
  );

  // 加列：T-SQL 是 ALTER TABLE t ADD col …（**没有** COLUMN 关键字）
  const addSql = Note.addColumnSql('mssql' as never, Note.fieldFor('title'));
  assert.ok(!/\bADD COLUMN\b/i.test(addSql), `T-SQL 的 ADD 后面不写 COLUMN：${addSql}`);
  assert.match(addSql, /ALTER TABLE \[notes\] ADD \[title\] nvarchar\(200\) NOT NULL/);

  // 索引：T-SQL 没有 IF NOT EXISTS（能力位应当是 false，SQL 里不该出现）
  const indexSql = Note.createIndexSql('mssql' as never, { name: 'notes_title', columns: ['title'], unique: false });
  assert.ok(!/IF NOT EXISTS/i.test(indexSql), `T-SQL 没有索引 IF NOT EXISTS：${indexSql}`);
  assert.strictEqual(indexSql, 'CREATE INDEX [notes_title] ON [notes] ([title])');
  assert.strictEqual(dialectSpec('mssql' as never).indexIfNotExists, false);
  assert.strictEqual(dialectSpec('mssql' as never).isDuplicateIndexError(new Error('...error 1913... already exists')), true);
  assert.strictEqual(dialectSpec('mssql' as never).isDuplicateIndexError(new Error('timeout')), false);
});

test('mssql: 注释走扩展属性（既不是内联、也不是 COMMENT ON），并且是幂等写法', () => {
  const Commented = defineModel({
    name: 'notes',
    comment: '用户笔记',
    fields: { id: { type: 'integer', primaryKey: true }, title: { type: 'string', comment: "标题（it's）" } },
  });
  const spec = dialectSpec('mssql' as never);
  assert.strictEqual(spec.comments, 'statements');
  assert.strictEqual(spec.inlineComment(Commented.fieldFor('title')), null, 'T-SQL 没有内联列注释');

  const statements = Commented.commentSql('mssql' as never);
  assert.strictEqual(statements.length, 2, `表注释 + 列注释各一条：${JSON.stringify(statements)}`);
  assert.match(statements[0], /sp_addextendedproperty/);
  assert.match(statements[0], /@level1name = N'notes'/);
  assert.match(statements[1], /@level2name = N'title'/);
  // 扩展属性重复添加会报错 → 必须是"先判存在再 EXEC"的幂等写法
  for (const statement of statements) {
    assert.match(statement, /IF NOT EXISTS/, `扩展属性要写成幂等的：${statement}`);
    assert.match(statement, /sys\.extended_properties/);
  }
  // 引号转义
  assert.match(statements[1], /N'标题（it''s）'/);
  // 建表语句里不该出现注释（T-SQL 既没有内联列注释，也没有表后缀）
  assert.ok(!/COMMENT/i.test(Commented.createTableSql('mssql' as never)));
});

test('mssql: 内省 SQL 与行映射（INFORMATION_SCHEMA + 精度列）', () => {
  const spec = dialectSpec('mssql' as never);
  const exists = spec.introspection.tableExists('notes');
  assert.deepStrictEqual(exists.params, ['notes']);
  assert.match(exists.sql, /INFORMATION_SCHEMA\.TABLES/);
  assert.match(exists.sql, /@p1/);

  const columns = spec.introspection.columns('notes');
  assert.ok('sql' in columns);
  assert.match(columns.sql, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(columns.sql, /ORDINAL_POSITION/);

  assert.deepStrictEqual(
    spec.introspection.toColumn({
      COLUMN_NAME: 'title',
      DATA_TYPE: 'nvarchar',
      CHARACTER_MAXIMUM_LENGTH: 200,
      IS_NULLABLE: 'NO',
      COLUMN_DEFAULT: null,
    }),
    { name: 'title', type: 'nvarchar(200)', rawType: 'nvarchar', notNull: true, hasDefault: false },
  );
  // 时间类型的精度来自 DATETIME_PRECISION（否则内省结果与 DDL 对不上 → 假漂移）
  assert.strictEqual(
    spec.introspection.toColumn({
      COLUMN_NAME: 'createdAt',
      DATA_TYPE: 'datetimeoffset',
      DATETIME_PRECISION: 3,
      IS_NULLABLE: 'YES',
      COLUMN_DEFAULT: null,
    }).type,
    'datetimeoffset(3)',
  );
  assert.strictEqual(spec.normalizeDbType('NVARCHAR', { length: 4 }), 'nvarchar(4)');
  assert.strictEqual(spec.normalizeDbType('uniqueidentifier', {}), 'uniqueidentifier');
  assert.strictEqual(spec.normalizeDbType('bit', {}), 'bit');
});

test('mssql: 连接形状与值表示', () => {
  const spec = dialectSpec('mssql' as never);
  assert.deepStrictEqual(spec.connectionFromUrl('mssql://sa:secret@db:1433/app'), {
    dialect: 'mssql',
    url: 'mssql://sa:secret@db:1433/app',
    host: 'db',
    port: 1433,
    user: 'sa',
    password: 'secret',
    database: 'app',
  });
  assert.strictEqual(spec.describe({ dialect: 'mssql' as never, host: 'db' }), 'mssql://db:1433/');
  assert.strictEqual(spec.serializeBoolean(true), 1);
  const when = new Date('2026-10-07T13:45:06.000Z');
  assert.strictEqual(spec.serializeTimestamp(when), when);
});

test('mssql: DSN 也能推断方言（此前 scheme 映射漏了 mssql —— 真库脚本 URL 一跑就暴露）', () => {
  const spec = dialectSpec('mssql' as never);
  assert.deepStrictEqual([...spec.urlSchemes].sort(), ['mssql', 'sqlserver'], 'mssql 的 URL scheme 要能被认出');
  assert.strictEqual(dialectFromUrl('mssql://sa:pw@db:1433/app'), 'mssql');
  assert.strictEqual(dialectFromUrl('sqlserver://sa:pw@db:1433/app'), 'mssql', 'sqlserver 是常见别名');
  const parsed = parseConnection({ url: 'mssql://sa:pw@db:1433/app' });
  assert.strictEqual(parsed.dialect, 'mssql');
  assert.strictEqual(parsed.host, 'db');
  assert.strictEqual(parsed.database, 'app');
  // 每个方言都要声明 scheme，且互相不冲突（否则 DSN 会被推成别的方言）
  const seen = new Map<string, string>();
  for (const dialect of DIALECTS) {
    const schemes = dialectSpec(dialect).urlSchemes;
    assert.ok(schemes.length > 0, `${dialect} 没声明 urlSchemes`);
    for (const scheme of schemes) {
      const owner = seen.get(scheme);
      assert.strictEqual(owner, undefined, `scheme "${scheme}" 同时属于 ${String(owner)} 与 ${dialect}`);
      seen.set(scheme, dialect);
      assert.strictEqual(dialectFromUrl(`${scheme}://user:pw@host:1/db`), dialect, `${scheme} 推断错了`);
    }
  }
});
