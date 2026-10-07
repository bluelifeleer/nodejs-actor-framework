'use strict';

/**
 * 示例冒烟门禁（审计建议新增）。
 *
 * 为什么需要它：审计发现 README **明确宣传"可直接运行"**的示例已经烂了，而 CI 全绿 ——
 * `node examples/alerts.mjs` 因为内部说明符写成 `.js`（本仓库直跑 TS）直接报
 * ERR_MODULE_NOT_FOUND，`game-server.js` / `game-cluster.js` 因为 `DATA_DIR` 没有默认值
 * 在 spawn 时抛 PersistenceError。文档指向的东西必须真的有东西在跑。
 *
 * 判据（刻意宽松，只测"起得来/不崩"）：
 *   1. 进程在给定时限内**没有异常退出**（退出码 0 = 自行结束也算通过）；
 *   2. stderr 里没有未捕获异常/堆栈；
 *   3. 优雅停机路径能走通（SIGTERM 后自行退出）。
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');

/**
 * 启动一个示例，等 readyMs 后收尾。
 * 返回 { code, signal, stdout, stderr, exitedEarly }。
 */
function runExample(args, { env = {}, readyMs = 6000, killMs = 6000 } = {}) {
  // 说明：readyMs 是"还活着就发 SIGTERM"的时刻，killMs 是"再给它多久优雅退出"。
  // 这两个值刻意给得宽松 —— 门禁要的是"不崩、能收尾"，不是"多快"。
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      clearTimeout(killTimer);
      resolve({ stdout, stderr, ...result });
    };

    child.on('exit', (code, signal) => finish({ code, signal, exitedEarly: true }));

    const readyTimer = setTimeout(() => {
      // 还活着 → 发 SIGTERM，看它能不能自己收尾
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: null, signal: 'SIGKILL', exitedEarly: false });
      }, killMs);
    }, readyMs);
    let killTimer = null;
  });
}

/** stderr 里出现这些就说明是"崩了"而不是"正常收尾"。 */
function assertNoCrash(label, result) {
  const noise = /(Error:|TypeError:|ReferenceError:|ERR_MODULE_NOT_FOUND|uncaughtException|UnhandledPromiseRejection|\n\s+at )/;
  assert.ok(!noise.test(result.stderr), `${label} 崩了：\n${result.stderr.slice(0, 600)}`);
  assert.notStrictEqual(result.signal, 'SIGKILL', `${label} 收到 SIGTERM 后没能自行退出（被强杀）`);
}

test('examples: alerts.mjs 能跑完并自行结束（README 说"完整示例：node examples/alerts.mjs"）', async () => {
  // 宽限到 60s：这条是**冒烟**门禁（"起得来/跑得完"），不是性能门禁。
// 满负载下这个示例（有固定的演示时长）实测会逼近 10s，30s 会被别的一起跑的测试挤爆。
  const result = await runExample(['examples/alerts.mjs'], { readyMs: 60000, killMs: 15000 });
  assertNoCrash('examples/alerts.mjs', result);
  assert.strictEqual(result.code, 0, `alerts.mjs 退出码 ${String(result.code)}：\n${result.stderr.slice(0, 400)}`);
  assert.match(result.stdout, /演示结束/, 'alerts.mjs 没有跑到结束');
});

test('examples: app-minimal 能启动并优雅停机', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-app-min-'));
  const result = await runExample(['examples/app-minimal/main.ts'], {
    env: { DATA_DIR: dir },
    readyMs: 5000,
  });
  assertNoCrash('examples/app-minimal', result);
  assert.match(result.stdout, /started with greeting=/, `app-minimal 没起来：\n${result.stdout.slice(0, 300)}`);
  assert.match(result.stdout, /stopped gracefully/, 'app-minimal 没有走优雅停机');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('examples: game-server 能启动（DATA_DIR 必须有默认值）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-game-'));
  const result = await runExample(['examples/game-server.js'], {
    // 端口 0 = 临时端口：避免与别的示例/并行测试抢 7777 与 9464
    env: { DATA_DIR: dir, PORT: '0', METRICS_PORT: '0' },
    readyMs: 6000,
  });
  assertNoCrash('examples/game-server.js', result);
  assert.match(result.stdout, /游戏服务器已启动/, `game-server 没起来：\n${result.stdout.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('examples: game-cluster 能启动（多节点 + WSS）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cluster-'));
  const result = await runExample(['examples/game-cluster.js'], {
    env: { DATA_DIR: dir, METRICS_PORT: '0' },
    readyMs: 14000,
    killMs: 10000,
  });
  assertNoCrash('examples/game-cluster.js', result);
  assert.match(result.stdout, /接入层/, `game-cluster 没起来：\n${result.stdout.slice(0, 400)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('examples: app-web 能启动 HTTP 并优雅停机', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-app-web-'));
  const result = await runExample(['examples/app-web/main.ts'], {
    env: { DATA_DIR: dir },
    readyMs: 6000,
  });
  assertNoCrash('examples/app-web', result);
  assert.match(result.stdout, /listening on http:\/\//, `app-web 没起来：\n${result.stdout.slice(0, 300)}`);
  assert.match(result.stdout, /stopped gracefully/, 'app-web 没有走优雅停机');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('examples: app-db 能启动（数据库接进应用 + 优雅关池）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-app-db-'));
  const result = await runExample(['examples/app-db/main.ts'], {
    env: { APP_DATA_DIR: dir, APP_DATABASE__FILE: path.join(dir, 'app-db.sqlite') },
    readyMs: 6000,
  });
  assertNoCrash('examples/app-db', result);
  assert.match(result.stdout, /listening on http:\/\//, `app-db 没起来：\n${result.stdout.slice(0, 400)}`);
  assert.match(result.stdout, /stopped gracefully/, 'app-db 没有走优雅停机（关池应当在 onStop 里）');
  fs.rmSync(dir, { recursive: true, force: true });
});
