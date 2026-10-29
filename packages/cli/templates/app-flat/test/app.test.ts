import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '@actor/app';

import app, { http } from '../src/app.ts';

/**
 * 端到端测试：**真 HTTP**（不是 mock），随机端口。
 *
 * 骨架自带这些用例是有意的：它们同时演示了三件事——怎么起应用、怎么做 HTTP 断言、
 * 怎么让每个测试自己清理（临时目录 + finally 停止应用）。其中"重启后数据还在"那条最容易
 * 被跳过，但它恰恰是持久化唯一真正的验收方式（自己写项目时也别省）。
 */

/** 起一个应用实例（端口取 0 = 随机；每个测试自己一个数据目录）。 */
async function boot(dataDir: string): Promise<{ application: Awaited<ReturnType<typeof createApp>>; base: string }> {
  process.env.APP_PLUGINS__HTTP__PORT = '0';
  const application = createApp(app, {
    configDir: fileURLToPath(new URL('../config', import.meta.url)),
    kernel: { logger: false, persistence: { dir: dataDir } },
  });
  await application.start();
  const address = http.address();
  return { application, base: `http://${String(address?.host)}:${String(address?.port)}` };
}

async function withApp(run: (base: string, dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-'));
  const { application, base } = await boot(dataDir);
  try {
    await run(base, dataDir);
  } finally {
    await application.stop({ timeoutMs: 5000 });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const json = async (response: Response) => ({ status: response.status, body: await response.json() });
const postJson = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('CRUD：创建 201 → 列表 200 → 乐观锁冲突 409 → 删除 204', async () => {
  await withApp(async (base) => {
    const created = await json(await postJson(`${base}/notes`, { title: 'first' }));
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.version, 1);

    const list = await json(await fetch(`${base}/notes?limit=10`));
    assert.strictEqual(list.body.items.length, 1);

    // 版本对得上 → 200；用旧版本号再来一次 → 409（业务语义，不是 500）
    const rename = (version: number) =>
      fetch(`${base}/notes/${created.body.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'renamed', expectedVersion: version }),
      });
    assert.strictEqual((await rename(1)).status, 200);
    const conflict = await json(await rename(1));
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.body.error.details.actual, 2);

    assert.strictEqual((await fetch(`${base}/notes/${created.body.id}`, { method: 'DELETE' })).status, 204);
  });
});

test('Actor：写路径走 Actor（命令 → 状态 → 回复）', async () => {
  await withApp(async (base) => {
    assert.deepStrictEqual(await (await fetch(`${base}/counter`)).json(), { count: 0 });
    assert.deepStrictEqual(await (await postJson(`${base}/counter/add`, { by: 2 })).json(), { count: 2 });
    assert.deepStrictEqual(await (await postJson(`${base}/counter/add`, {})).json(), { count: 3 });
  });
});

test('持久化：**重启之后** Actor 状态与仓储数据都还在', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-restart-'));
  try {
    const first = await boot(dataDir);
    await postJson(`${first.base}/counter/add`, { by: 5 });
    await postJson(`${first.base}/notes`, { title: 'survive-restart' });
    assert.deepStrictEqual(await (await fetch(`${first.base}/counter`)).json(), { count: 5 });
    await first.application.stop({ timeoutMs: 5000 });

    // 同一个数据目录、新的应用实例
    const second = await boot(dataDir);
    try {
      assert.deepStrictEqual(
        await (await fetch(`${second.base}/counter`)).json(),
        { count: 5 },
        'Actor 的状态从快照恢复（注意：快照存的是 this.state）',
      );
      const notes = await json(await fetch(`${second.base}/notes?limit=10`));
      assert.strictEqual(notes.body.items.length, 1, '仓储数据也从文件恢复');
    } finally {
      await second.application.stop({ timeoutMs: 5000 });
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('校验与错误语义：缺字段 400、未知路径 404、方法不对 405', async () => {
  await withApp(async (base) => {
    const invalid = await json(await postJson(`${base}/notes`, {}));
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.body.error.details.issues[0].path, 'title');

    assert.strictEqual((await fetch(`${base}/nope`)).status, 404);
    assert.strictEqual((await fetch(`${base}/notes`, { method: 'DELETE' })).status, 405);
    assert.strictEqual((await fetch(`${base}/health`)).status, 200);
  });
});
