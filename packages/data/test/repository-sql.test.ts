import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import {
  createSqlRepository,
  RepositoryConflictError,
  RepositoryDuplicateError,
  RepositoryQueryError,
  type SqlRunner,
} from '../src/index.ts';
import { repositoryContract, type RepoDoc } from './repository-suite.ts';

/**
 * SQL 适配器的契约测试跑在**真 SQL** 上：Node 24 内置的 `node:sqlite`（零依赖，
 * 与框架"不引驱动"的取向一致）。文档里另有 pg / mysql2 / better-sqlite3 的 runner 示例。
 */
const FIELDS = ['id', 'version', 'owner', 'rank'];

function makeRunner(): SqlRunner & { close: () => void; raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, version INTEGER NOT NULL, owner TEXT, rank INTEGER)');
  const runnerApi: SqlRunner = {
    async all(sql, params) {
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    async run(sql, params) {
      return Number(db.prepare(sql).run(...(params as never[])).changes);
    },
  };
  return {
    ...runnerApi,
    raw: db,
    // sqlite 是单连接，所以"事务范围的 runner"和外面是同一个（这是它的真实语义）
    async transaction<R>(fn: (scoped: SqlRunner) => Promise<R>): Promise<R> {
      db.exec('BEGIN');
      try {
        const result = await fn(runnerApi);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}

function makeSqlRepo(runner: SqlRunner) {
  return createSqlRepository<RepoDoc>({
    runner,
    table: 'docs',
    fields: FIELDS,
    isUniqueViolation: (err) => /UNIQUE constraint failed/.test(String((err as Error)?.message)),
  });
}

/** 同一份契约（与 memory / file 逐条对齐）；类型守卫那条按真实差异关掉。 */
repositoryContract(
  'repository(sql)',
  async () => {
    const runner = makeRunner();
    return { repo: makeSqlRepo(runner), cleanup: async () => runner.close() };
  },
  { mixedTypeGuard: false },
);

test('repository(sql): 能力如实上报——条件写是数据库级 CAS，事务是真的', () => {
  const runner = makeRunner();
  const repo = makeSqlRepo(runner);
  assert.deepStrictEqual(repo.capabilities(), { conditionalUpdate: 'atomic', transaction: 'database' });
  runner.close();

  // runner 不提供 transaction 时：退化为本进程串行，能力也要跟着变
  const bare: SqlRunner = { all: runner.all, run: runner.run };
  const bareRepo = createSqlRepository<RepoDoc>({ runner: bare, table: 'docs', fields: FIELDS });
  assert.strictEqual(bareRepo.capabilities().transaction, 'in-process');
  assert.strictEqual(bareRepo.capabilities().conditionalUpdate, 'atomic', 'CAS 仍然是数据库给的');
});

test('repository(sql): 乐观锁是**真 CAS**——同一版本并发更新只有一个成功', async () => {
  const runner = makeRunner();
  const repo = makeSqlRepo(runner);
  const doc = await repo.insert({ owner: 'ada', rank: 1 });

  const results = await Promise.allSettled([
    repo.update(String(doc.id), { rank: 2 }, { expectedVersion: 1 }),
    repo.update(String(doc.id), { rank: 3 }, { expectedVersion: 1 }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.strictEqual(ok.length, 1, '并发同版本更新只能有一个成功');
  assert.strictEqual(failed.length, 1);
  assert.ok(failed[0].reason instanceof RepositoryConflictError);
  assert.strictEqual((await repo.findById(String(doc.id)))?.version, 2, 'version 只自增一次');
  runner.close();
});

test('repository(sql): 标识符走白名单——字段名不是注入点', async () => {
  const runner = makeRunner();
  const repo = makeSqlRepo(runner);
  await repo.insert({ owner: 'ada', rank: 1 });

  await assert.rejects(
    () => repo.findMany({ where: { 'evil; DROP TABLE docs': 1 } as never }),
    RepositoryQueryError,
  );
  await assert.rejects(() => repo.findMany({ orderBy: 'rank; DROP TABLE docs' }), RepositoryQueryError);
  await assert.rejects(() => repo.update('x', { 'evil OR 1=1': 1 } as never), RepositoryQueryError);
  assert.throws(
    () => createSqlRepository({ runner, table: 'docs; DROP TABLE docs', fields: FIELDS }),
    /table 必须是简单标识符/,
    '表名是配置项（构造期校验）；字段名才来自查询，所以两者都要挡',
  );

  // 表还在
  assert.strictEqual((await repo.findMany({ limit: 10 })).items.length, 1);
  runner.close();
});

test('repository(sql): 值永远参数化（注入字符串只是普通值）', async () => {
  const runner = makeRunner();
  const repo = makeSqlRepo(runner);
  const evil = "'; DROP TABLE docs; --";
  await repo.insert({ owner: evil, rank: 1 });

  const page = await repo.findMany({ where: { owner: evil }, limit: 10 });
  assert.strictEqual(page.items.length, 1);
  assert.strictEqual((await repo.findMany({ where: { owner: 'nobody' }, limit: 10 })).items.length, 0);
  assert.strictEqual((await repo.findMany({ limit: 10 })).items.length, 1, '表还在，数据完好');
  runner.close();
});

test('repository(sql): where 的 null 走 IS NULL（SQL 里 = NULL 永远不成立）', async () => {
  const runner = makeRunner();
  const repo = makeSqlRepo(runner);
  await repo.insert({ owner: null as never, rank: 1 });
  await repo.insert({ owner: 'ada', rank: 2 });

  const nulls = await repo.findMany({ where: { owner: null }, limit: 10 });
  assert.deepStrictEqual(
    nulls.items.map((d) => d.rank),
    [1],
  );
  const ada = await repo.findMany({ where: { owner: 'ada' }, limit: 10 });
  assert.deepStrictEqual(
    ada.items.map((d) => d.rank),
    [2],
  );
  runner.close();
});

test('repository(sql): insert 撞唯一约束 → RepositoryDuplicateError（由 isUniqueViolation 判定）', async () => {
  const runner = makeRunner();
  const repo = makeSqlRepo(runner);
  await repo.insert({ id: 'dup', owner: 'ada', rank: 1 });
  await assert.rejects(() => repo.insert({ id: 'dup', owner: 'bob', rank: 2 }), RepositoryDuplicateError);
  assert.strictEqual((await repo.findById('dup'))?.owner, 'ada', '原记录不被覆盖');
  runner.close();
});

test('repository(sql): 声明之外的表/字段组合由 fields 决定（不接管 schema）', async () => {
  const runner = makeRunner();
  // 只声明一部分字段：SELECT 只查这些列，其它列不出现
  const repo = createSqlRepository({ runner, table: 'docs', fields: ['id', 'version', 'owner'] });
  runner.raw.exec("INSERT INTO docs (id, version, owner, rank) VALUES ('a', 1, 'ada', 7)");
  const found = (await repo.findById('a')) as Record<string, unknown>;
  assert.deepStrictEqual(found, { id: 'a', version: 1, owner: 'ada' }, 'rank 未声明就不出现在实体里');
  runner.close();
});

test('repository(sql): 事务内的语句必须走到**事务连接**上（否则"数据库事务"是假的）', async () => {
  const runner = makeRunner();
  const outerSql: string[] = [];
  const scopedSql: string[] = [];
  const instrumented: SqlRunner = {
    async all(sql, params) {
      outerSql.push(sql);
      return runner.all(sql, params);
    },
    async run(sql, params) {
      outerSql.push(sql);
      return runner.run(sql, params);
    },
    async transaction<R>(fn: (scoped: SqlRunner) => Promise<R>): Promise<R> {
      const scoped: SqlRunner = {
        async all(sql, params) {
          scopedSql.push(sql);
          return runner.all(sql, params);
        },
        async run(sql, params) {
          scopedSql.push(sql);
          return runner.run(sql, params);
        },
      };
      return fn(scoped);
    },
  };

  const repo = createSqlRepository<RepoDoc>({ runner: instrumented, table: 'docs', fields: FIELDS });
  const doc = await repo.insert({ owner: 'ada', rank: 1 });
  const insertsOutside = outerSql.length;
  assert.ok(insertsOutside > 0, '事务外走外层 runner');

  await repo.transaction(async (tx) => {
    await tx.findById(String(doc.id));
    await tx.update(String(doc.id), { rank: 2 });
  });

  assert.strictEqual(outerSql.length, insertsOutside, '事务内不再走外层 runner');
  assert.deepStrictEqual(
    scopedSql.map((sql) => sql.slice(0, 6)),
    ['SELECT', 'UPDATE', 'SELECT'],
    '事务内的读与写都走事务连接（第三条是 update 的"回读权威行"）',
  );
  runner.close();
});
