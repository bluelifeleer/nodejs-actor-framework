import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EXAMPLE = path.join(import.meta.dirname, '..', 'examples', 'app-web');

/** 真实 HTTP 端到端：示例必须能跑起来并遵守错误约定（否则"框架可用"只是纸面承诺）。 */
test('example app-web: HTTP 端到端（200/201/400/404/405/504/HEAD/OPTIONS）与优雅停止', async () => {
  const child = spawn(process.execPath, ['main.ts'], {
    cwd: EXAMPLE,
    env: { ...process.env, APP_PLUGINS__HTTP__PORT: '0' },
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

  const base = `http://127.0.0.1:${port}`;
  const json = async (response) => ({ status: response.status, body: await response.json() });

  // 200：GET 健康检查（函数式控制器）
  const health = await json(await fetch(`${base}/health`));
  assert.deepStrictEqual(health, { status: 200, body: { ok: true } });

  // 201：POST /join（输入来自 body，显式声明）
  const join = await json(
    await fetch(`${base}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'alice' }),
    }),
  );
  assert.strictEqual(join.status, 201);
  assert.deepStrictEqual(join.body, { joined: 'alice', players: 1 });

  // 400：缺少 body 字段时一次性报出问题
  const invalid = await json(
    await fetch(`${base}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  );
  assert.strictEqual(invalid.status, 400);
  assert.strictEqual(invalid.body.error.details.issues[0].path, 'playerId');

  // 200：路径参数 + 查询参数混用（verbose=true 时返回完整状态）
  const room = await json(await fetch(`${base}/rooms/1?verbose=true`));
  assert.strictEqual(room.status, 200);
  assert.deepStrictEqual(room.body.players, ['alice']);

  // 404 / 405（带 Allow）
  assert.strictEqual((await fetch(`${base}/nope`)).status, 404);
  const wrongMethod = await fetch(`${base}/health`, { method: 'DELETE' });
  assert.strictEqual(wrongMethod.status, 405);
  assert.strictEqual(wrongMethod.headers.get('allow'), 'GET');

  // 504：每请求超时（控制器把 ask 超时设为 200ms，而 Actor 睡 1000ms）
  assert.strictEqual((await fetch(`${base}/slow`)).status, 504);

  // HEAD 回退到 GET（无 body）；OPTIONS 返回 204 + Allow
  const head = await fetch(`${base}/rooms/1`, { method: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(await head.text(), '');
  const preflight = await fetch(`${base}/rooms/1`, { method: 'OPTIONS' });
  assert.strictEqual(preflight.status, 204);
  assert.match(String(preflight.headers.get('allow')), /GET/);

  // 优雅停止
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.strictEqual(code, 0, `应正常退出，输出:\n${out}`);
  assert.match(out, /\[main\] stopped gracefully/);
  // 访问日志：方法/路径/状态码/耗时/追踪 id
  assert.match(out, /\[http\] POST \/join 201 \d+ms rid=r-/, '应有访问日志并带 requestId');
  assert.match(out, /\[http\] GET \/slow 504 /, '访问日志应记录状态码');
});
