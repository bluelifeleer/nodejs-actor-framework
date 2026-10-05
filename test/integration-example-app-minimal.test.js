import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples', 'app-minimal');

/** 用户示例必须真的能跑起来——否则"无侵入装配"只是纸面承诺。 */
test('example app-minimal: 启动、ask、SIGTERM 优雅退出', async () => {
  const child = spawn(process.execPath, ['main.ts'], {
    cwd: EXAMPLE,
    env: { ...process.env, APP_STEP: '4' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`示例未在 30s 内完成，输出:\n${out}`)), 30_000);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (out.includes('[main] counter=3 then 7') && !child.killed) {
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    // 注意：必须等 'close'（stdio 流关闭后触发），'exit' 可能早于最后一块 stdout 到达，
    // 会把「stopped gracefully」这类收尾输出丢掉，造成假失败。
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const code = await done;
  assert.strictEqual(code, 0, `示例应正常退出，实际 code=${String(code)}，输出:\n${out}`);
  assert.match(out, /\[module\] ready: greeting=hello/, '模块 onStart 应执行并读到配置');
  assert.match(out, /\[main\] started with greeting=hello/);
  // 第一次显式 by=3，第二次不给 by → 走配置 step（APP_STEP=4）→ 3 + 4 = 7
  assert.match(out, /\[main\] counter=3 then 7/, 'APP_STEP=4 应作为默认步长生效');
  assert.match(out, /\[main\] stopped gracefully/, 'SIGTERM 应触发优雅退出');
});
