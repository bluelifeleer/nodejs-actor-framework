import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RepositoryConflictError, createFileRepository } from '../src/index.ts';

/**
 * 审计 F4 的回归：`conditionalUpdate: 'in-process'` 是给使用者的承诺，而 `update()` 原本是
 * "读 → 检查 version → 写"，中间没有串行化 —— 同进程并发两次更新会双双成功（其中一次的内容其实没落盘，
 * 返回值却报成功；另一次拿到裸 ENOENT，调用方无法按冲突处理）。
 *
 * 这里用**两个指向同一目录的仓储实例**（正是审计的场景），要求：恰好一个成功、另一个抛
 * `RepositoryConflictError`，且盘上内容是成功那一次写的。
 */
test('audit/repository: 同进程两个实例的并发条件更新必须恰好一个成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-repo-'));
  try {
    const a = createFileRepository<{ id: string; name: string; version: number }>({ dir });
    const b = createFileRepository<{ id: string; name: string; version: number }>({ dir });
    const row = await a.insert({ name: 'base' } as never);

    const results = await Promise.allSettled([
      a.update(row.id, { name: 'from-a' } as never, { expectedVersion: 1 }),
      b.update(row.id, { name: 'from-b' } as never, { expectedVersion: 1 }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.strictEqual(ok.length, 1, `并发条件更新应当恰好一个成功，实际 ${ok.length} 个`);
    assert.strictEqual(failed.length, 1);
    assert.ok(
      failed[0].reason instanceof RepositoryConflictError,
      `失败的那个应当是 RepositoryConflictError（可被调用方按冲突处理），实际 ${String(failed[0].reason)}`,
    );

    // 落盘内容必须与"成功那一次"一致（不能出现"返回成功但写的是对方内容"）
    const winner = (ok[0] as PromiseFulfilledResult<{ name: string; version: number }>).value;
    const onDisk = await a.findById(row.id);
    assert.strictEqual(onDisk?.name, winner.name, '落盘内容与返回成功的那次不一致（lost update）');
    assert.strictEqual(onDisk?.version, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit/repository(file): 同 id 并发 insert 必须恰好一个成功（回归：双成功破坏去重）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-repo-insert-'));
  try {
    const a = createFileRepository<{ id: string; name: string; version: number }>({ dir });
    const b = createFileRepository<{ id: string; name: string; version: number }>({ dir });
    const results = await Promise.allSettled([
      a.insert({ id: 'same', name: 'a' } as never),
      b.insert({ id: 'same', name: 'b' } as never),
    ]);
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1, '同 id 并发 insert 只能有一个成功');
    assert.strictEqual(await a.findById('same') !== null, true);
    assert.strictEqual((await a.findMany()).items.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit/repository(file): delete 与 update 并发不得让实体复活，也不得抛裸 ENOENT（回归）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-repo-delete-'));
  try {
    const a = createFileRepository<{ id: string; name: string; version: number }>({ dir });
    const b = createFileRepository<{ id: string; name: string; version: number }>({ dir });
    const row = await a.insert({ name: 'base' } as never);

    const [del, upd] = await Promise.allSettled([
      a.delete(row.id),
      b.update(row.id, { name: 'changed' } as never),
    ]);
    assert.strictEqual(del.status, 'fulfilled');
    if (upd.status === 'rejected') {
      assert.doesNotMatch(String(upd.reason), /ENOENT/, '并发删除应转成可处理的错误，而不是裸 ENOENT');
    }
    const remaining = await a.findById(row.id);
    const listed = (await a.findMany()).items;
    assert.strictEqual(remaining === null, listed.length === 0, 'findById 与 findMany 必须一致（不能复活/幽灵）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit/repository(file): 并发 delete 至多一个返回 true，且不抛裸 ENOENT（回归）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-repo-double-delete-'));
  try {
    const a = createFileRepository<{ id: string; name: string; version: number }>({ dir });
    const b = createFileRepository<{ id: string; name: string; version: number }>({ dir });
    const row = await a.insert({ name: 'base' } as never);

    const results = await Promise.allSettled([a.delete(row.id), b.delete(row.id)]);
    for (const result of results) {
      assert.strictEqual(result.status, 'fulfilled', `并发 delete 不应抛错：${String((result as PromiseRejectedResult).reason)}`);
    }
    const truths = results.filter((r) => r.status === 'fulfilled' && r.value === true);
    assert.strictEqual(truths.length, 1, '同一实体只能被成功删除一次');
    assert.strictEqual(await a.findById(row.id), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
