import { test } from 'node:test';
import assert from 'node:assert';

import { createMemoryRepository } from '../src/index.ts';
import { repositoryContract, type RepoDoc } from './repository-suite.ts';

/**
 * 内存适配器：它同时是**语义基准**（file / SQL 必须逐条对齐它），所以主要断言都在共享契约里
 * （repository-suite.ts）。这里只补内存特有的部分。
 */
repositoryContract('repository(memory)', async () => ({ repo: createMemoryRepository<RepoDoc>() }));

test('repository(memory): 能力如实上报 + seed 预置数据', async () => {
  const repo = createMemoryRepository<RepoDoc>({
    seed: [
      { id: 'a', version: 1, owner: 'ada', rank: 1 },
      { id: 'b', version: 3, owner: 'bob', rank: 2 },
    ],
  });
  assert.deepStrictEqual(repo.capabilities(), { conditionalUpdate: 'in-process', transaction: 'in-process' });

  const page = await repo.findMany({ orderBy: 'id' });
  assert.deepStrictEqual(
    page.items.map((d) => d.id),
    ['a', 'b'],
  );
  assert.strictEqual((await repo.findById('b'))?.version, 3, 'seed 原样入库（不重置 version）');

  // 预置数据也是副本：改返回值不影响仓储
  const found = (await repo.findById('a'))!;
  found.rank = 99;
  assert.strictEqual((await repo.findById('a'))?.rank, 1);
});

test('repository(memory): 自定义 idField / versionField 生效', async () => {
  interface Row {
    key: string;
    rev: number;
    n: number;
  }
  const repo = createMemoryRepository<Row & Record<string, unknown>>({ idField: 'key', versionField: 'rev' });
  const created = await repo.insert({ key: 'k1', n: 1 });
  assert.strictEqual(created.rev, 1);

  const bumped = await repo.update('k1', { n: 2 }, { expectedVersion: 1 });
  assert.strictEqual(bumped.rev, 2);

  const renamed = await repo.update('k1', { key: 'other' } as never, { expectedVersion: 2 });
  assert.strictEqual(renamed.key, 'k1', 'id 不被 patch 覆盖（否则游标与索引都会失效）');
});
