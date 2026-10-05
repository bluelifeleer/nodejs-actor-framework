/**
 * 仓储**契约测试**（M3 第 3 步）：一份断言，跑在所有适配器上。
 *
 * 存在的理由：memory 适配器是语义基准，file / SQL 必须**逐条对齐**它。把断言抽出来共享，
 * 将来加第三个适配器时对齐就是"接进这个套件"，而不是我照着 memory 的测试再抄一遍
 * （抄出来的测试会漂移，而且漂移了没人知道）。
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  RepositoryConflictError,
  RepositoryDuplicateError,
  RepositoryNotFoundError,
  RepositoryQueryError,
  type Repository,
} from '../src/index.ts';

export interface RepoDoc {
  id?: string;
  version?: number;
  owner: string;
  rank: number;
}

export interface RepoHarness {
  repo: Repository<RepoDoc>;
  cleanup?: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function repositoryContract(name: string, create: () => Promise<RepoHarness>): void {
  const withRepo = async (fn: (repo: Repository<RepoDoc>) => Promise<void>): Promise<void> => {
    const { repo, cleanup } = await create();
    try {
      await fn(repo);
    } finally {
      await cleanup?.();
    }
  };

  test(`${name}: CRUD 基本语义（副本 / version / 错误分类）`, () =>
    withRepo(async (repo) => {
      const created = await repo.insert({ owner: 'ada', rank: 1 });
      assert.match(String(created.id), /^id-/, '没给 id 时由适配器生成');
      assert.strictEqual(created.version, 1, 'insert 时 version=1');

      await assert.rejects(() => repo.insert(created), RepositoryDuplicateError, 'insert 不覆盖已存在的 id');

      const found = await repo.findById(String(created.id));
      assert.deepStrictEqual(found, created);
      assert.notStrictEqual(found, created, '返回副本：改它影响不到仓储');
      (found as RepoDoc).rank = 999;
      assert.strictEqual((await repo.findById(String(created.id)))?.rank, 1);

      const updated = await repo.update(String(created.id), { owner: 'bob' });
      assert.strictEqual(updated.owner, 'bob');
      assert.strictEqual(updated.rank, 1, 'patch 是局部更新');
      assert.strictEqual(updated.version, 2);

      assert.strictEqual(await repo.delete(String(created.id)), true);
      assert.strictEqual(await repo.findById(String(created.id)), null);
      assert.strictEqual(await repo.delete(String(created.id)), false, '重复删除返回 false');
      await assert.rejects(() => repo.update(String(created.id), { rank: 2 }), RepositoryNotFoundError);
    }));

  test(`${name}: expectedVersion —— 匹配才写，冲突不写入且字段可诊断`, () =>
    withRepo(async (repo) => {
      const doc = await repo.insert({ owner: 'ada', rank: 1 });
      await repo.update(String(doc.id), { rank: 2 }, { expectedVersion: 1 });

      await assert.rejects(
        () => repo.update(String(doc.id), { rank: 3 }, { expectedVersion: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof RepositoryConflictError);
          assert.strictEqual(err.expectedVersion, 1);
          assert.strictEqual(err.actualVersion, 2);
          return true;
        },
      );
      assert.strictEqual((await repo.findById(String(doc.id)))?.rank, 2, '冲突不写入');
      await assert.rejects(() => repo.update(String(doc.id), { rank: 3 }, { expectedVersion: 1.5 }), /必须是整数/);
    }));

  test(`${name}: where 等值过滤 + 单键排序（asc/desc）+ limit + 游标翻页`, () =>
    withRepo(async (repo) => {
      for (const [owner, rank] of [
        ['a', 3],
        ['a', 1],
        ['b', 2],
        ['a', 2],
      ] as const) {
        await repo.insert({ owner, rank });
      }

      const asc = await repo.findMany({ where: { owner: 'a' }, orderBy: 'rank', limit: 10 });
      assert.deepStrictEqual(
        asc.items.map((d) => d.rank),
        [1, 2, 3],
      );

      const first = await repo.findMany({ where: { owner: 'a' }, orderBy: 'rank', direction: 'desc', limit: 2 });
      assert.deepStrictEqual(
        first.items.map((d) => d.rank),
        [3, 2],
      );
      assert.strictEqual(typeof first.cursor, 'string');

      const second = await repo.findMany({
        where: { owner: 'a' },
        orderBy: 'rank',
        direction: 'desc',
        limit: 2,
        cursor: first.cursor,
      });
      assert.deepStrictEqual(
        second.items.map((d) => d.rank),
        [1],
      );
      assert.strictEqual(second.cursor, undefined, '最后一页不给游标');
      assert.strictEqual((await repo.findMany({ limit: 10 })).items.length, 4);
    }));

  test(`${name}: 游标分页在**并发写入**下不漏不重（offset 会重复——对照证据）`, () =>
    withRepo(async (repo) => {
      for (let i = 1; i <= 100; i += 1) {
        await repo.insert({ id: `doc-${String(i).padStart(3, '0')}`, owner: 'team', rank: i });
      }

      const seen: string[] = [];
      const mirror: string[] = Array.from({ length: 100 }, (_, i) => `doc-${String(i + 1).padStart(3, '0')}`);
      const offsetSeen: string[] = [];
      let offset = 0;
      let cursor: string | undefined;
      let page = 0;

      for (;;) {
        const result = await repo.findMany({
          where: { owner: 'team' },
          orderBy: 'id',
          limit: 7,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...result.items.map((d) => String(d.id)));
        cursor = result.cursor;
        page += 1;

        const window = mirror.slice(offset, offset + 7);
        if (window.length > 0) {
          offsetSeen.push(...window);
          offset += 7;
        }

        if (page <= 5) {
          // 'aaa-' 排在 'doc-' 之前（已翻过），'zzz-' 排在之后（后续页应当看到）
          await repo.insert({ id: `aaa-before-${page}`, owner: 'team', rank: 0 });
          await repo.insert({ id: `zzz-after-${page}`, owner: 'team', rank: 0 });
          mirror.push(`aaa-before-${page}`, `zzz-after-${page}`);
          mirror.sort();
        }
        if (cursor === undefined) break;
      }

      for (let i = 1; i <= 100; i += 1) {
        const id = `doc-${String(i).padStart(3, '0')}`;
        assert.strictEqual(seen.filter((s) => s === id).length, 1, `${id} 必须恰好出现一次`);
      }
      assert.strictEqual(new Set(seen).size, seen.length, '游标分页不得重复');
      assert.ok(seen.some((id) => id.startsWith('zzz-after-')), '排在游标之后的并发新记录应被后续页看到');
      assert.ok(!seen.some((id) => id.startsWith('aaa-before-')), '排在游标之前的并发新记录不该出现（游标语义如此）');
      assert.ok(
        offsetSeen.length > new Set(offsetSeen).size,
        `offset 分页在同样模式下重复了（${offsetSeen.length} 条只有 ${new Set(offsetSeen).size} 个不同 id）——` +
          '这就是仓储只用游标的原因',
      );
    }));

  test(`${name}: 查询参数校验都在调用期报错（limit / where / cursor / 混合类型排序键）`, () =>
    withRepo(async (repo) => {
      await repo.insert({ owner: 'a', rank: 1 });
      await assert.rejects(() => repo.findMany({ limit: 0 }), /limit 必须是 1\.\.1000 的整数/);
      await assert.rejects(() => repo.findMany({ limit: 1001 }), RepositoryQueryError);
      await assert.rejects(() => repo.findMany({ where: { owner: undefined } as never }), /是 undefined/);
      await assert.rejects(() => repo.findMany({ where: { owner: { like: 'a' } } as never }), /只支持原始值/);
      await assert.rejects(() => repo.findMany({ direction: 'sideways' as never }), /direction 只能是/);
      await assert.rejects(() => repo.findMany({ cursor: 'not-a-cursor' }), /cursor 无法解析/);

      await repo.insert({ id: 'mixed', owner: 'a', rank: 'two' as never });
      await assert.rejects(() => repo.findMany({ orderBy: 'rank', limit: 10 }), /必须是可比较的 string 或 number/);
    }));

  test(`${name}: transaction 串行化——并发读改写不丢更新`, () =>
    withRepo(async (repo) => {
      const counter = await repo.insert({ owner: 'x', rank: 0 });
      await Promise.all([
        repo.transaction(async (tx) => {
          const current = (await tx.findById(String(counter.id)))!;
          await sleep(5);
          await tx.update(String(counter.id), { rank: current.rank + 1 });
        }),
        repo.transaction(async (tx) => {
          const current = (await tx.findById(String(counter.id)))!;
          await sleep(5);
          await tx.update(String(counter.id), { rank: current.rank + 1 });
        }),
      ]);
      assert.strictEqual((await repo.findById(String(counter.id)))?.rank, 2, '两次自增都生效');
    }));

  test(`${name}: 游标不透明，同一排序下可回放`, () =>
    withRepo(async (repo) => {
      for (let i = 1; i <= 6; i += 1) await repo.insert({ id: `doc-${String(i).padStart(3, '0')}`, owner: 't', rank: i });
      const first = await repo.findMany({ orderBy: 'id', limit: 2 });
      assert.doesNotMatch(String(first.cursor), /doc-/, '游标里不该出现明文 id');
      const second = await repo.findMany({ orderBy: 'id', limit: 2, cursor: first.cursor });
      assert.deepStrictEqual(
        second.items.map((d) => d.id),
        ['doc-003', 'doc-004'],
      );
    }));
}
