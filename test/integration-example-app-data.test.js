import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EXAMPLE = path.join(import.meta.dirname, '..', 'examples', 'app-data');

/**
 * 数据层示例的**真实端到端**：真子进程、真文件、真 HTTP。
 *
 * 覆盖 doc 04 的四个卖点：仓储 CRUD + 游标分页、乐观锁冲突（409）、事件溯源聚合（写路径）、
 * 投影读模型（最终一致）——以及**重启后数据还在**（文件仓储 + 事件日志 + 快照）。
 */

async function boot(dataDir, { migrate = false } = {}) {
  const child = spawn(process.execPath, ['main.ts'], {
    cwd: EXAMPLE,
    env: {
      ...process.env,
      APP_DATA_DIR: dataDir,
      APP_PLUGINS__HTTP__PORT: '0',
      ...(migrate ? { APP_MIGRATE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`未在 30s 内监听，输出:\n${out}`)), 30_000);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`示例提前退出 code=${String(code)}，输出:\n${out}`));
    });
  });

  return {
    base: `http://127.0.0.1:${port}`,
    output: () => out,
    async stop() {
      const closed = new Promise((resolve) => child.on('close', resolve));
      child.kill('SIGTERM');
      await closed;
      return out;
    },
  };
}

const json = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });
const post = (base, url, body) =>
  fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('example app-data: CRUD + 游标分页 + 乐观锁冲突（409）+ 聚合写 + 投影读模型 + 重启后仍在', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-data-'));
  let app = await boot(dataDir, { migrate: true });

  try {
    // 迁移门：第一次跑显式应用（APP_MIGRATE=1），日志里能看到两个迁移
    assert.match(app.output(), /\[migrate\] 已应用 v1, v2/, '迁移应当被应用并记录');
    assert.ok(fs.existsSync(path.join(dataDir, 'migrations.json')), '版本表落盘');

    // ---- CRUD：写 3 条，按游标分页读回来 ----
    const created = [];
    for (const title of ['first', 'second', 'third']) {
      const response = await json(await post(app.base, '/notes', { title, tag: 'demo' }));
      assert.strictEqual(response.status, 201);
      assert.strictEqual(response.body.title, title);
      assert.strictEqual(response.body.version, 1, 'version 由仓储维护');
      created.push(response.body);
    }

    const page1 = await json(await fetch(`${app.base}/notes?limit=2`));
    assert.strictEqual(page1.status, 200);
    assert.strictEqual(page1.body.items.length, 2);
    assert.strictEqual(typeof page1.body.cursor, 'string', '还有下一页时要给游标');

    const page2 = await json(
      await fetch(`${app.base}/notes?limit=2&cursor=${encodeURIComponent(page1.body.cursor)}`),
    );
    assert.strictEqual(page2.body.items.length, 1, '第二页只剩一条');
    assert.strictEqual(page2.body.cursor, undefined, '最后一页不给游标');

    const seen = [...page1.body.items, ...page2.body.items].map((note) => note.id);
    assert.strictEqual(new Set(seen).size, 3, '游标分页不漏不重');

    // ---- 乐观锁：版本对得上才改，过期的给 409（不是 500）----
    const target = created[0];
    const ok = await json(
      await fetch(`${app.base}/notes/${target.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'first-edited', expectedVersion: 1 }),
      }),
    );
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.version, 2);

    const conflict = await json(
      await fetch(`${app.base}/notes/${target.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'stale', expectedVersion: 1 }),
      }),
    );
    assert.strictEqual(conflict.status, 409, '乐观锁冲突是业务语义，不该是 500');
    assert.strictEqual(conflict.body.error.details.expected, 1);
    assert.strictEqual(conflict.body.error.details.actual, 2);

    // ---- 写路径走 Actor（事件溯源聚合）----
    const add1 = await json(await post(app.base, '/orders/o1/items', { price: 250 }));
    assert.deepStrictEqual(add1.body, { status: 'created', totalCents: 250, items: 1 });
    const add2 = await json(await post(app.base, '/orders/o1/items', { price: 100 }));
    assert.deepStrictEqual(add2.body, { status: 'created', totalCents: 350, items: 2 });
    const confirmed = await json(await post(app.base, '/orders/o1/confirm', {}));
    assert.deepStrictEqual(confirmed.body, { status: 'confirmed', totalCents: 350, items: 2 });

    // 业务校验失败：命令抛错 → 409/400 之外走错误映射（这里是 500 + requestId，消息不外泄）
    const bad = await json(await post(app.base, '/orders/o1/items', { price: 0 }));
    assert.ok(bad.status >= 400, '非法输入必须报错');

    // ---- 读路径走投影（最终一致：轮询到追上为止）----
    let summary = { status: 0, body: null };
    for (let i = 0; i < 40; i += 1) {
      summary = await json(await fetch(`${app.base}/orders/o1/summary`));
      if (summary.status === 200 && summary.body.status === 'confirmed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.strictEqual(summary.status, 200, `投影应当追上来，实际: ${JSON.stringify(summary)}`);
    assert.deepStrictEqual(
      { items: summary.body.items, totalCents: summary.body.totalCents, status: summary.body.status },
      { items: 2, totalCents: 350, status: 'confirmed' },
      '投影把事件折成了读模型',
    );

    // 事件日志确实落在数据目录里（信封形态）
    const logFile = path.join(dataDir, 'events');
    assert.ok(fs.existsSync(logFile), '事件目录存在');

    const stopOutput = await app.stop();
    assert.match(stopOutput, /stopped gracefully/, '应当优雅停止');
    app = null;

    // ---- 重启：**不带 APP_MIGRATE**（迁移已记录，所以能直接启动）+ 数据仍在 ----
    app = await boot(dataDir);
    assert.match(app.output(), /\[migrate\] 已应用 v1, v2/, '迁移已记录，重启不需要再迁移');

    const notesAfter = await json(await fetch(`${app.base}/notes?limit=10`));
    assert.strictEqual(notesAfter.body.items.length, 3, '文件仓储重启后数据仍在');
    assert.ok(
      notesAfter.body.items.some((note) => note.title === 'first-edited' && note.version === 2),
      '改动也持久化了',
    );

    const summaryAfter = await json(await fetch(`${app.base}/orders/o1/summary`));
    assert.strictEqual(summaryAfter.status, 200);
    assert.deepStrictEqual(
      { items: summaryAfter.body.items, totalCents: summaryAfter.body.totalCents, status: summaryAfter.body.status },
      { items: 2, totalCents: 350, status: 'confirmed' },
      '读模型落盘：重启后仍然可读',
    );

    // 重启后继续写同一个聚合：seq/状态从日志续上（不是从 0 重来）
    const add3 = await json(await post(app.base, '/orders/o1/items', { price: 50 }));
    assert.ok(add3.status >= 400, '已确认的订单不能再加东西（业务规则跨重启生效）');
  } finally {
    if (app) await app.stop().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('example app-data: 有未应用迁移时**拒绝启动**（doc 04 §5 的默认姿态）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-data-pending-'));
  try {
    const child = spawn(process.execPath, ['main.ts'], {
      cwd: EXAMPLE,
      env: { ...process.env, APP_DATA_DIR: dataDir, APP_PLUGINS__HTTP__PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.notStrictEqual(code, 0, '未应用迁移时必须非零退出');
    assert.match(out, /尚未应用：v1, v2/);
    assert.match(out, /默认拒绝启动/);
    assert.ok(!out.includes('listening on http://'), '绝不能在"结构不确定"的情况下开始服务');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
