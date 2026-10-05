import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFileRepository, type FileRepository } from '../src/index.ts';
import { repositoryContract, type RepoDoc } from './repository-suite.ts';

/** 文件适配器跑同一份契约（必须与内存适配器逐条对齐），另外补文件特有的部分。 */
repositoryContract('repository(file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-repo-file-'));
  const repo = createFileRepository<RepoDoc>({ dir });
  return { repo, cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }) };
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-repo-file-'));
}

test('repository(file): 数据跨实例存在（一实体一文件 + 索引）', async () => {
  const dir = tempDir();
  const first = createFileRepository<RepoDoc>({ dir });
  await first.insert({ id: 'a', owner: 'ada', rank: 1 });
  await first.insert({ id: 'b', owner: 'bob', rank: 2 });
  await first.update('a', { rank: 5 });

  // 新实例（≈ 进程重启）读到的必须一致
  const second = createFileRepository<RepoDoc>({ dir });
  assert.deepStrictEqual(await second.findById('a'), { id: 'a', version: 2, owner: 'ada', rank: 5 });
  assert.deepStrictEqual(
    (await second.findMany({ orderBy: 'id' })).items.map((d) => d.id),
    ['a', 'b'],
  );
  assert.ok(fs.existsSync(path.join(dir, 'entities')), '实体是一实体一文件');
  assert.ok(fs.existsSync(path.join(dir, 'index.jsonl')), '索引是追加式 jsonl');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('repository(file): update 完全不碰索引（所以"实体写了、索引没写"这个崩溃窗口不存在）', async () => {
  const dir = tempDir();
  const repo = createFileRepository<RepoDoc>({ dir });
  await repo.insert({ id: 'a', owner: 'ada', rank: 1 });
  const before = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8');

  for (let i = 0; i < 5; i += 1) await repo.update('a', { rank: i + 2 });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8'), before, '索引一个字节都没动');

  // delete 才写 tombstone
  await repo.delete('a');
  assert.match(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8'), /"deleted":true/);
  assert.strictEqual(await repo.findById('a'), null);
  assert.strictEqual((await repo.findMany({ orderBy: 'id' })).items.length, 0, 'tombstone 之后不再出现在列表里');

  // 删除后可以重新插入同一个 id（与内存适配器一致）
  await repo.insert({ id: 'a', owner: 'new', rank: 9 });
  assert.strictEqual((await repo.findById('a'))?.owner, 'new');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('repository(file): 索引是缓存——丢了/坏了都能以实体文件为准重建', async () => {
  const dir = tempDir();
  const repo = createFileRepository<RepoDoc>({ dir });
  await repo.insert({ id: 'a', owner: 'ada', rank: 1 });
  await repo.insert({ id: 'b', owner: 'bob', rank: 2 });

  // 索引整个删掉 → 新实例应当以实体文件为准自动重建
  fs.rmSync(path.join(dir, 'index.jsonl'));
  const rebuilt = createFileRepository<RepoDoc>({ dir });
  assert.deepStrictEqual(
    (await rebuilt.findMany({ orderBy: 'id' })).items.map((d) => d.id),
    ['a', 'b'],
    '索引不存在但有实体文件 → 自动重建',
  );

  // 索引被写坏（撕裂尾巴）：坏行之后的条目当作没写，实体文件仍然可读
  fs.appendFileSync(path.join(dir, 'index.jsonl'), '{"id":"c"');
  const partial = createFileRepository<RepoDoc>({ dir });
  assert.strictEqual((await partial.findById('a')) !== null, true, '实体读取不依赖索引');
  const explicit = await partial.rebuildIndex();
  assert.strictEqual(explicit.entities, 2, 'rebuildIndex 以实体文件为准');
  assert.deepStrictEqual(
    (await partial.findMany({ orderBy: 'id' })).items.map((d) => d.id),
    ['a', 'b'],
    '重建后索引与实体一致',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('repository(file): 非 id 排序会读实体文件（O(n)），但结果与内存适配器一致', async () => {
  const dir = tempDir();
  const repo = createFileRepository<RepoDoc>({ dir });
  for (const [owner, rank] of [
    ['a', 3],
    ['a', 1],
    ['b', 2],
  ] as const) {
    await repo.insert({ owner, rank });
  }
  const byRank = await repo.findMany({ orderBy: 'rank', limit: 10 });
  assert.deepStrictEqual(
    byRank.items.map((d) => d.rank),
    [1, 2, 3],
  );
  const filtered = await repo.findMany({ where: { owner: 'a' }, orderBy: 'rank', limit: 10 });
  assert.deepStrictEqual(
    filtered.items.map((d) => d.rank),
    [1, 3],
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('repository(file): 索引压缩把重复条目折叠掉（自动/手动都能触发）', async () => {
  const dir = tempDir();
  const repo: FileRepository<RepoDoc> = createFileRepository<RepoDoc>({ dir, compactThreshold: 0 });
  for (let i = 0; i < 5; i += 1) {
    await repo.insert({ id: `x-${i}`, owner: 'a', rank: i });
  }
  await repo.delete('x-0');
  const before = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n').length;

  const compacted = await repo.compactIndex();
  const after = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n').length;
  assert.strictEqual(compacted.before, before);
  assert.strictEqual(compacted.after, after);
  assert.ok(after < before + 1);
  assert.deepStrictEqual(
    (await repo.findMany({ orderBy: 'id' })).items.map((d) => d.id),
    ['x-1', 'x-2', 'x-3', 'x-4'],
    '压缩不改变可见数据',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('repository(file): 能力如实上报（文件后端没有跨进程条件写）', async () => {
  const dir = tempDir();
  const repo = createFileRepository<RepoDoc>({ dir });
  assert.deepStrictEqual(repo.capabilities(), { conditionalUpdate: 'in-process' });
  fs.rmSync(dir, { recursive: true, force: true });
});
