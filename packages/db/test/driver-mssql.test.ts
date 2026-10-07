import { test } from 'node:test';
import assert from 'node:assert';

import { createDatabase, createMssqlDriver, DbDriverMissingError, defineModel } from '../src/index.ts';

/**
 * SQL Server 驱动**不能真连**（离线、也不该把 `mssql` 写进依赖）→ 注入假模块验证框架侧契约：
 *   - 统一池参数如何映射进 node-mssql 的 `pool.*` 与 `connectionTimeout`；
 *   - `@pN` 位置参数如何绑定到 node-mssql 的命名参数；
 *   - 自增回读：同批次 `SELECT SCOPE_IDENTITY() AS insertId`；
 *   - 事务必须 begin/commit（出错 rollback），且复用同一个事务对象；
 *   - 驱动缺失时的错误要能照着装。
 */
function fakeMssql() {
  const calls: Array<{ sql: string; inputs: string[] }> = [];
  const poolConfigs: Record<string, unknown>[] = [];
  const lifecycle: string[] = [];

  const tables = new Set<string>();

  /** 认得 SQL 形状的假结果（否则"任何 SELECT 都返回一行"会让表存在性判断全为真）。 */
  function resultFor(sql: string, values: readonly unknown[]): unknown {
    const text = sql.trim();
    if (/INFORMATION_SCHEMA\.TABLES/i.test(text)) {
      return { recordset: tables.has(String(values[0])) ? [{ found: 1 }] : [] };
    }
    if (/INFORMATION_SCHEMA\.COLUMNS/i.test(text)) {
      // 表建好之后内省：给出与 model 一致的列（否则会被判成漂移）
      return {
        recordset: [
          { COLUMN_NAME: 'id', DATA_TYPE: 'int', CHARACTER_MAXIMUM_LENGTH: null, IS_NULLABLE: 'NO', COLUMN_DEFAULT: null },
          {
            COLUMN_NAME: 'title',
            DATA_TYPE: 'nvarchar',
            CHARACTER_MAXIMUM_LENGTH: 100,
            IS_NULLABLE: 'NO',
            COLUMN_DEFAULT: null,
          },
        ],
      };
    }
    if (/scope_identity/i.test(text)) return { recordsets: [[{ insertId: 7 }]] };
    const created = /CREATE TABLE \[([\w]+)\]/i.exec(text);
    if (created !== null) {
      tables.add(created[1]);
      return { rowsAffected: [0] };
    }
    if (/^select/i.test(text)) return { recordset: [{ ok: 1 }] };
    return { rowsAffected: [2] };
  }

  class FakeRequest {
    inputs: string[] = [];
    values: unknown[] = [];
    input(name: string, value: unknown) {
      this.inputs.push(name);
      this.values.push(value);
      return this;
    }
    async query(sql: string) {
      calls.push({ sql, inputs: [...this.inputs] });
      return resultFor(sql, this.values) as never;
    }
  }

  class FakeTransaction {
    async begin() {
      lifecycle.push('begin');
    }
    async commit() {
      lifecycle.push('commit');
    }
    async rollback() {
      lifecycle.push('rollback');
    }
    request() {
      return new FakeRequest();
    }
  }

  class FakePool {
    size = 3;
    available = 1;
    pending = 0;
    constructor(config: Record<string, unknown>) {
      poolConfigs.push(config);
    }
    async connect() {
      lifecycle.push('connect');
      return this;
    }
    request() {
      return new FakeRequest();
    }
    transaction() {
      return new FakeTransaction();
    }
    async close() {
      lifecycle.push('close');
    }
  }

  return { module: { ConnectionPool: FakePool }, calls, poolConfigs, lifecycle };
}

const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    title: { type: 'string', length: 100, notNull: true },
  },
});

test('driver/mssql: 池参数映射到 node-mssql 的字段名（pool.* 与 connectionTimeout）', async () => {
  const fake = fakeMssql();
  const db = createDatabase({
    dialect: 'mssql' as never,
    connection: { host: 'db', port: 1433, user: 'sa', password: 'secret', database: 'app' },
    pool: { min: 1, max: 20, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
    driver: createMssqlDriver(async () => fake.module),
  });
  await db.connect();
  try {
    assert.strictEqual(fake.poolConfigs.length, 1);
    const config = fake.poolConfigs[0];
    assert.strictEqual(config.server, 'db');
    assert.strictEqual(config.port, 1433);
    assert.strictEqual(config.user, 'sa');
    assert.strictEqual(config.password, 'secret');
    assert.strictEqual(config.database, 'app');
    assert.deepStrictEqual(config.pool, { min: 1, max: 20, idleTimeoutMillis: 30_000 }, '池参数没映射进 pool.*');
    assert.strictEqual(config.connectionTimeout, 5_000);
    assert.ok(fake.lifecycle.includes('connect'));
    assert.strictEqual(db.driverName, 'mssql');
    const health = await db.healthCheck();
    assert.strictEqual(health.ok, true);
    assert.deepStrictEqual(db.stats(), { kind: 'mssql', size: 3, available: 1, pending: 0 });
  } finally {
    await db.close();
  }
  assert.ok(fake.lifecycle.includes('close'), '关池必须调用 close()');
});

test('driver/mssql: 位置参数绑定成 @pN，自增回读走 SCOPE_IDENTITY 的最后一个结果集', async () => {
  const fake = fakeMssql();
  const db = createDatabase({
    dialect: 'mssql' as never,
    connection: { host: 'db', database: 'app' },
    driver: createMssqlDriver(async () => fake.module),
  });
  await db.connect();
  try {
    await db.sync([Note]);
    const created = await db.repository(Note).insert({ title: 'x' });
    const insert = fake.calls.find((call) => /^insert into/i.test(call.sql.trim()));
    assert.ok(insert, '没有发出 INSERT');
    assert.match(insert.sql, /@p1/, `占位符应当是 @pN：${insert.sql}`);
    assert.match(insert.sql, /SELECT SCOPE_IDENTITY\(\) AS insertId/i, '自增回读要拼同批次的 SCOPE_IDENTITY');
    assert.deepStrictEqual(insert.inputs, ['p1'], '参数要按 p1…pN 绑定');
    assert.strictEqual(created.id, 7, 'SCOPE_IDENTITY 的值没有回填进实体');

    // 多参数时序号递增
    const fake2 = fakeMssql();
    const db2 = createDatabase({
      dialect: 'mssql' as never,
      connection: { host: 'db', database: 'app' },
      driver: createMssqlDriver(async () => fake2.module),
    });
    await db2.connect();
    try {
      await db2.rawRun('UPDATE [notes] SET [title] = @p1 WHERE [id] = @p2', ['a', 1]);
      const update = fake2.calls.find((call) => /^update/i.test(call.sql.trim()));
      assert.deepStrictEqual(update?.inputs, ['p1', 'p2']);
    } finally {
      await db2.close();
    }
  } finally {
    await db.close();
  }
});

test('driver/mssql: 事务 begin/commit；出错 rollback（并且不会静默吞掉原错误）', async () => {
  const fake = fakeMssql();
  const db = createDatabase({
    dialect: 'mssql' as never,
    connection: { host: 'db', database: 'app' },
    driver: createMssqlDriver(async () => fake.module),
  });
  await db.connect();
  try {
    const value = await db.runner().transaction?.(async (scoped) => {
      await scoped.run('INSERT INTO [notes] ([title]) VALUES (@p1)', ['in-tx']);
      return 'ok';
    });
    assert.strictEqual(value, 'ok');
    assert.ok(fake.lifecycle.includes('begin') && fake.lifecycle.includes('commit'));

    await assert.rejects(
      () =>
        db.runner().transaction?.(async () => {
          throw new Error('业务失败');
        }) ?? Promise.resolve(),
      /业务失败/,
    );
    assert.ok(fake.lifecycle.includes('rollback'), '事务出错必须 rollback');
  } finally {
    await db.close();
  }
});

test('driver/mssql: 没装驱动时的错误要能照着装（走真实的懒加载路径）', async () => {
  // 用**默认 loader**（不走假模块）：离线环境里 require('mssql') 必然失败 → 应当是"能照着装"的错误
  const driver = createMssqlDriver();
  await assert.rejects(
    () => driver.create({ dialect: 'mssql' as never, host: 'db' }, {}, 'mssql' as never),
    (error: unknown) => {
      assert.ok(error instanceof DbDriverMissingError, `应当是 DbDriverMissingError：${String(error)}`);
      assert.match((error as Error).message, /mssql/);
      assert.match((error as Error).message, /npm i mssql/);
      return true;
    },
  );
});
