import { test } from 'node:test';
import assert from 'node:assert';

import {
  createMemoryRepository,
  RepositoryConflictError,
  RepositoryDuplicateError,
  RepositoryNotFoundError,
  RepositoryQueryError,
} from '../src/index.ts';

interface Doc {
  id?: string;
  version?: number;
  owner: string;
  rank: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedDocs(count: number, owner = 'team') {
  const repo = createMemoryRepository<Doc>();
  for (let i = 1; i <= count; i += 1) {
    await repo.insert({ id: `doc-${String(i).padStart(3, '0')}`, owner, rank: i } as Doc);
  }
  return repo;
}

test('repository(memory): insert / findById / update / delete 的基本语义与副本', async () => {
  const repo = createMemoryRepository<Doc>();
  assert.deepStrictEqual(repo.capabilities(), { conditionalUpdate: 'in-process' });

  const created = await repo.insert({ owner: 'ada', rank: 1 } as Doc);
  assert.match(String(created.id), /^id-/, '没给 id 时由适配器生成');
  assert.strictEqual(created.version, 1, 'insert 时 version=1（适配器维护）');

  await assert.rejects(() => repo.insert(created as Doc), RepositoryDuplicateError, 'insert 不覆盖已存在的 id');

  const found = await repo.findById(String(created.id));
  assert.deepStrictEqual(found, created);
  assert.notStrictEqual(found, created, '返回的是副本，改它不会影响仓储');

  (found as Doc).rank = 999;
  assert.strictEqual((await repo.findById(String(created.id)))?.rank, 1);

  const updated = await repo.update(String(created.id), { owner: 'bob' });
  assert.strictEqual(updated.owner, 'bob');
  assert.strictEqual(updated.version, 2);
  assert.strictEqual(updated.rank, 1, 'patch 是局部更新');

  assert.strictEqual(await repo.delete(String(created.id)), true);
  assert.strictEqual(await repo.findById(String(created.id)), null);
  assert.strictEqual(await repo.delete(String(created.id)), false, '重复删除返回 false');
  await assert.rejects(() => repo.update(String(created.id), { rank: 2 }), RepositoryNotFoundError);
});

test('repository(memory): expectedVersion —— 匹配才写，冲突不写入且字段可诊断', async () => {
  const repo = createMemoryRepository<Doc>();
  const doc = await repo.insert({ owner: 'ada', rank: 1 } as Doc);

  const bumped = await repo.update(String(doc.id), { rank: 2 }, { expectedVersion: 1 });
  assert.strictEqual(bumped.version, 2);

  await assert.rejects(
    () => repo.update(String(doc.id), { rank: 3 }, { expectedVersion: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof RepositoryConflictError);
      assert.strictEqual(err.id, doc.id);
      assert.strictEqual(err.expectedVersion, 1);
      assert.strictEqual(err.actualVersion, 2);
      assert.match(err.message, /版本冲突/);
      return true;
    },
  );
  assert.strictEqual((await repo.findById(String(doc.id)))?.rank, 2, '冲突的更新不得写入');

  await assert.rejects(() => repo.update(String(doc.id), { rank: 3 }, { expectedVersion: 1.5 }), /expectedVersion 必须是整数/);
});

test('repository(memory): findMany —— 等值过滤 + 单键排序（asc/desc）+ limit', async () => {
  const repo = createMemoryRepository<Doc>();
  for (const [owner, rank] of [
    ['a', 3],
    ['a', 1],
    ['b', 2],
    ['a', 2],
  ] as const) {
    await repo.insert({ owner, rank } as Doc);
  }
  // id 自动生成，这里改用 rank 排序观察顺序
  const byRank = await repo.findMany({ where: { owner: 'a' }, orderBy: 'rank', limit: 10 });
  assert.deepStrictEqual(
    byRank.items.map((d) => d.rank),
    [1, 2, 3],
  );

  const desc = await repo.findMany({ where: { owner: 'a' }, orderBy: 'rank', direction: 'desc', limit: 2 });
  assert.deepStrictEqual(
    desc.items.map((d) => d.rank),
    [3, 2],
  );
  assert.strictEqual(typeof desc.cursor, 'string', '还有下一页时要给游标');

  const nextPage = await repo.findMany({
    where: { owner: 'a' },
    orderBy: 'rank',
    direction: 'desc',
    limit: 2,
    cursor: desc.cursor,
  });
  assert.deepStrictEqual(
    nextPage.items.map((d) => d.rank),
    [1],
  );
  assert.strictEqual(nextPage.cursor, undefined, '最后一页不给游标');

  const all = await repo.findMany({ limit: 10 });
  assert.strictEqual(all.items.length, 4, '不传 where 就是全部');
});

test('repository(memory): 游标分页在**并发写入**下不漏不重（offset 会重复——对照证据）', async () => {
  const repo = await seedDocs(100);

  const seen: string[] = [];
  let cursor: string | undefined;
  let page = 0;
  // 对照：同样写入模式下 offset 分页看到的 id（用数组模拟同一个排序视图）
  const mirror: string[] = Array.from({ length: 100 }, (_, i) => `doc-${String(i + 1).padStart(3, '0')}`);
  const offsetSeen: string[] = [];
  let offset = 0;

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

    // offset 对照：取同一个窗口
    const window = mirror.slice(offset, offset + 7);
    if (window.length > 0) {
      offsetSeen.push(...window);
      offset += 7;
    }

    if (page <= 5) {
      // 边翻页边写：一条排在**已翻过**的位置（id 更小），一条排在**后面**
      // 'aaa-' 排在 'doc-' 之前（已翻过），'zzz-' 排在之后（后续页应当看到）
      await repo.insert({ id: `aaa-before-${page}`, owner: 'team', rank: 0 } as Doc);
      await repo.insert({ id: `zzz-after-${page}`, owner: 'team', rank: 0 } as Doc);
      mirror.push(`aaa-before-${page}`, `zzz-after-${page}`);
      mirror.sort();
    }
    if (cursor === undefined) break;
  }

  // 原有 100 条：恰好各出现一次（并发写入没有让任何一条被跳过或重复）
  for (let i = 1; i <= 100; i += 1) {
    const id = `doc-${String(i).padStart(3, '0')}`;
    assert.strictEqual(seen.filter((s) => s === id).length, 1, `${id} 必须在游标分页里恰好出现一次`);
  }
  assert.strictEqual(new Set(seen).size, seen.length, '游标分页不得重复');
  assert.ok(
    seen.some((id) => id.startsWith('zzz-after-')),
    '排在游标之后的并发新记录应被后续页看到（游标不是快照）',
  );
  assert.ok(
    !seen.some((id) => id.startsWith('aaa-before-')),
    '排在游标之前的并发新记录不该出现在后续页（这是游标分页的固有语义，不是 bug）',
  );

  // 对照证据：offset 分页在同样的写入模式下**会重复**
  assert.ok(
    offsetSeen.length > new Set(offsetSeen).size,
    `offset 分页在并发写入下重复了（${offsetSeen.length} 条里只有 ${new Set(offsetSeen).size} 个不同 id）——` +
      '这正是仓储只用游标的原因',
  );
});

test('repository(memory): 查询参数校验（limit / where / cursor）都在调用期报错', async () => {
  const repo = await seedDocs(3);

  await assert.rejects(() => repo.findMany({ limit: 0 }), /limit 必须是 1\.\.1000 的整数/);
  await assert.rejects(() => repo.findMany({ limit: 1001 }), RepositoryQueryError);
  await assert.rejects(() => repo.findMany({ limit: 2.5 }), RepositoryQueryError);
  await assert.rejects(
    () => repo.findMany({ where: { owner: undefined } as never }),
    /where\.owner 是 undefined/,
  );
  await assert.rejects(() => repo.findMany({ where: { owner: { like: 'a' } } as never }), /只支持原始值/);
  await assert.rejects(() => repo.findMany({ direction: 'sideways' as never }), /direction 只能是/);
  await assert.rejects(() => repo.findMany({ cursor: 'not-a-cursor' }), /cursor 无法解析/);

  // 混合类型排序键：明确报错而不是"随便排一个"
  const mixed = createMemoryRepository<Record<string, unknown>>();
  await mixed.insert({ id: 'x', rank: 1 });
  await mixed.insert({ id: 'y', rank: 'two' });
  await assert.rejects(() => mixed.findMany({ orderBy: 'rank' }), /必须是可比较的 string 或 number/);
});

test('repository(memory): transaction 串行化——并发读改写不会互相覆盖', async () => {
  const repo = createMemoryRepository<{ id?: string; version?: number; n: number }>();
  const counter = await repo.insert({ n: 0 });

  await Promise.all([
    repo.transaction(async (tx) => {
      const current = (await tx.findById(String(counter.id)))!;
      await sleep(5); // 放大"读—改—写"窗口
      await tx.update(String(counter.id), { n: current.n + 1 });
    }),
    repo.transaction(async (tx) => {
      const current = (await tx.findById(String(counter.id)))!;
      await sleep(5);
      await tx.update(String(counter.id), { n: current.n + 1 });
    }),
  ]);

  assert.strictEqual((await repo.findById(String(counter.id)))?.n, 2, '两次自增都生效（没有丢更新）');
});

test('repository(memory): 游标是不透明的——同一排序下可回放，换排序即失效语义', async () => {
  const repo = await seedDocs(6);
  const first = await repo.findMany({ orderBy: 'id', limit: 2 });
  assert.strictEqual(typeof first.cursor, 'string');
  assert.doesNotMatch(String(first.cursor), /doc-/, '游标里不该出现明文 id');

  // 按同一排序继续翻页
  const second = await repo.findMany({ orderBy: 'id', limit: 2, cursor: first.cursor });
  assert.deepStrictEqual(
    second.items.map((d) => d.id),
    ['doc-003', 'doc-004'],
  );

  // 换了排序方向：游标仍然被"解释"（不会崩），但语义由调用方负责（文档已写明）
  const flipped = await repo.findMany({ orderBy: 'id', direction: 'desc', limit: 2, cursor: first.cursor });
  assert.strictEqual(flipped.items.length > 0, true);
});
