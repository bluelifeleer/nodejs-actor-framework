import { test } from 'node:test';
import assert from 'node:assert';

import { createDatabase, createMysqlDriver, createPgDriver } from '../src/index.ts';

/**
 * pg / mysql 的驱动这轮**不能真连**（离线、也不该把驱动写进依赖），
 * 所以这里注入一个**假驱动模块**，验证框架侧的契约：
 *   - 连接配置如何映射成各驱动真实的池参数；
 *   - 占位符风格（pg `$n` / mysql `?`）；
 *   - 事务必须走**专用连接**并且**无论如何都 release**；
 *   - 驱动缺失时的错误要能照着装。
 */

/** 假的 pg 模块：记录收到的配置与执行的 SQL。 */
function fakePg() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const released: number[] = [];
  let clientSeq = 0;
  const poolConfigs: Record<string, unknown>[] = [];
  class FakeClient {
    id = (clientSeq += 1);
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/^select 1/i.test(sql.trim())) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/^select/i.test(sql.trim())) return { rows: [{ id: 'r1' }], rowCount: 1 };
      return { rows: [], rowCount: 3 };
    }
    release() {
      released.push(this.id);
    }
  }
  class FakePool {
    constructor(config: Record<string, unknown>) {
      poolConfigs.push(config);
    }
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/^select 1/i.test(sql.trim())) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (/^select/i.test(sql.trim())) return { rows: [{ id: 'p1' }], rowCount: 1 };
      return { rows: [], rowCount: 2 };
    }
    async connect() {
      return new FakeClient();
    }
    async end() {
      /* closed */
    }
  }
  return { module: { Pool: FakePool }, calls, released, poolConfigs };
}

/** 假的 mysql2/promise 模块。 */
function fakeMysql() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const released: number[] = [];
  let connectionSeq = 0;
  const poolConfigs: Record<string, unknown>[] = [];
  const connection = () => {
    const id = (connectionSeq += 1);
    return {
      id,
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (/^select 1/i.test(sql.trim())) return [[{ ok: 1 }], []];
        if (/^select/i.test(sql.trim())) return [[{ id: 'm1' }], []];
        return [{ affectedRows: 4 }, []];
      },
      async beginTransaction() {
        calls.push({ sql: 'BEGIN', params: [] });
      },
      async commit() {
        calls.push({ sql: 'COMMIT', params: [] });
      },
      async rollback() {
        calls.push({ sql: 'ROLLBACK', params: [] });
      },
      release() {
        released.push(id);
      },
    };
  };
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/^select 1/i.test(sql.trim())) return [[{ ok: 1 }], []];
      if (/^select/i.test(sql.trim())) return [[{ id: 'm1' }], []];
      // 写语句：mysql2 返回 ResultSetHeader（affectedRows）
      return [{ affectedRows: 4 }, []];
    },
    async getConnection() {
      return connection();
    },
    async end() {
      /* closed */
    },
  };
  return {
    module: {
      createPool(config: Record<string, unknown>) {
        poolConfigs.push(config);
        return pool;
      },
    },
    calls,
    released,
    poolConfigs,
  };
}

test('db/pg: 连接配置映射成 pg.Pool 的真实字段，事务用专用连接且必定 release', async () => {
  const fake = fakePg();
  const db = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'db', port: 5433, user: 'u', password: 'p', database: 'appdb' },
    pool: { max: 7, idleTimeoutMs: 1234, connectionTimeoutMs: 4321 },
    driver: createPgDriver(async () => fake.module),
  });
  await db.connect();
  try {
    assert.deepStrictEqual(
      fake.poolConfigs[0],
      {
        host: 'db',
        port: 5433,
        user: 'u',
        password: 'p',
        database: 'appdb',
        // 框架默认池参数（DEFAULT_POOL）里 min 就是 0，pg 支持它，所以会一起传下去
        min: 0,
        max: 7,
        idleTimeoutMillis: 1234,
        connectionTimeoutMillis: 4321,
      },
      'pg 池参数没有按真实字段名映射',
    );

    const runner = db.runner();
    await runner.all('SELECT id FROM notes WHERE owner = $1', ['alice']);
    assert.ok(
      fake.calls.some((c) => c.sql.includes('$1') && c.params.length === 1),
      `pg 应当用 $1 占位符，实际调用：${JSON.stringify(fake.calls.slice(-2))}`,
    );

    await runner.transaction?.(async (scoped) => {
      await scoped.run('UPDATE notes SET owner = $1 WHERE id = $2', ['bob', 'n1']);
    });
    const sqls = fake.calls.map((c) => c.sql.trim().toUpperCase());
    assert.ok(sqls.includes('BEGIN'), '事务没有 BEGIN');
    assert.ok(sqls.includes('COMMIT'), '事务没有 COMMIT');
    assert.strictEqual(fake.released.length, 1, '事务用的专用 client 没有 release（连接会泄漏）');

    // 事务抛错：必须 ROLLBACK 且照样 release
    await runner.transaction?.(async () => {
      throw new Error('boom');
    }).catch(() => null);
    const sqls2 = fake.calls.map((c) => c.sql.trim().toUpperCase());
    assert.ok(sqls2.includes('ROLLBACK'), '事务异常没有 ROLLBACK');
    assert.strictEqual(fake.released.length, 2, '异常路径没有 release');
  } finally {
    await db.close();
  }
});

test('db/mysql: 连接配置映射成 mysql2 的真实字段，事务用 getConnection + release', async () => {
  const fake = fakeMysql();
  const db = createDatabase({
    dialect: 'mysql',
    connection: { host: 'db', port: 3307, user: 'u', password: 'p', database: 'appdb' },
    pool: { max: 5, idleTimeoutMs: 999, connectionTimeoutMs: 111 },
    driver: createMysqlDriver(async () => fake.module),
  });
  await db.connect();
  try {
    assert.deepStrictEqual(
      fake.poolConfigs[0],
      { host: 'db', port: 3307, user: 'u', password: 'p', database: 'appdb', connectionLimit: 5, idleTimeout: 999, connectTimeout: 111 },
      'mysql 池参数没有按真实字段名映射',
    );

    const runner = db.runner();
    await runner.run('UPDATE notes SET owner = ? WHERE id = ?', ['bob', 'n1']);
    assert.ok(
      fake.calls.some((c) => c.sql.includes('?') && c.params.length === 2),
      'mysql 应当用 ? 占位符',
    );
    assert.strictEqual(await runner.run('DELETE FROM notes WHERE id = ?', ['x']), 4, 'run 应返回 affectedRows');

    await runner.transaction?.(async (scoped) => {
      await scoped.run('UPDATE notes SET owner = ? WHERE id = ?', ['c', 'n1']);
    });
    const sqls = fake.calls.map((c) => c.sql.trim().toUpperCase());
    assert.ok(sqls.includes('BEGIN'), '事务没有 beginTransaction');
    assert.ok(sqls.includes('COMMIT'), '事务没有 commit');
    assert.strictEqual(fake.released.length, 1, '事务连接没有 release');
  } finally {
    await db.close();
  }
});

test('db: 驱动没装时错误要能照着装（方言 + 驱动名 + 安装命令）', async () => {
  // 刻意**不注入**驱动：走真实的默认加载器（从应用根 find `pg`）。本仓库没装 pg，
  // 所以这里验证的正是用户会遇到的那条路径与那句话。
  const db = createDatabase({ dialect: 'pgsql', connection: { host: 'h', database: 'd' } });
  await assert.rejects(
    () => db.connect(),
    (err: Error & { code?: string; driverPackage?: string }) => {
      assert.strictEqual(err.name, 'DbDriverMissingError', `错误类型不对：${err.name}: ${err.message}`);
      assert.strictEqual(err.code, 'DB_DRIVER_MISSING');
      assert.strictEqual(err.driverPackage, 'pg');
      assert.match(err.message, /pgsql/);
      assert.match(err.message, /npm i pg/);
      return true;
    },
  );
  // 连接失败之后不能假装健康
  const health = await db.healthCheck();
  assert.strictEqual(health.ok, false);
  await db.close();
});

test('db: 健康检查失败要如实返回 ok:false 与原因（不假装健康）', async () => {
  const fake = fakePg();
  // 让 pool.query 在 SELECT 1 上抛错
  const original = fake.module.Pool.prototype.query;
  fake.module.Pool.prototype.query = async function query(sql: string) {
    if (/^select 1/i.test(sql.trim())) throw new Error('connection refused');
    return original.call(this, sql);
  } as never;
  const db = createDatabase({
    dialect: 'pgsql',
    connection: { host: 'h', database: 'd' },
    driver: createPgDriver(async () => fake.module),
  });
  await db.connect().catch(() => null);
  const health = await db.healthCheck();
  assert.strictEqual(health.ok, false);
  assert.match(String(health.error), /connection refused|refused/i);
  await db.close();
});
