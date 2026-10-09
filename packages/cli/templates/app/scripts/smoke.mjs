/**
 * 生产冒烟：把**编译产物**（`dist/main.js`）真起一次，打一个 `/health`，然后停掉。
 *
 * 部署流水线里最该有的那一步：`npm run build` 成功不等于产物能跑
 * （最常见的两个坑是"忘了拷 config"与"import 没改写成 .js"）。
 *   node scripts/smoke.mjs            # 用 0 号端口（随机）
 *   APP_PLUGINS__HTTP__PORT=9000 node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENTRY = path.join(PROJECT, 'dist', 'main.js');

if (!existsSync(ENTRY)) {
  console.error(`[smoke] 找不到 ${path.relative(PROJECT, ENTRY)}：先跑 npm run build`);
  process.exit(2);
}

const child = spawn(process.execPath, [ENTRY], {
  cwd: PROJECT,
  env: { ...process.env, APP_PLUGINS__HTTP__PORT: process.env.APP_PLUGINS__HTTP__PORT ?? '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let finished = false;
const finish = (code, message) => {
  if (finished) return;
  finished = true;
  child.kill('SIGKILL');
  if (code === 0) console.log(`[smoke] ${message}`);
  else console.error(`[smoke] ${message}`);
  process.exit(code);
};

const timer = setTimeout(() => finish(1, `启动超时（10s）。输出：\n${output}`), 10_000);

child.stdout.on('data', async (chunk) => {
  output += String(chunk);
  const match = /listening on (?:[^:\s]+):(\d+)/.exec(output);
  if (match === null) return;
  const base = `http://127.0.0.1:${match[1]}`;
  try {
    const response = await fetch(`${base}/health`);
    clearTimeout(timer);
    finish(response.ok ? 0 : 1, `/health → ${response.status}（编译产物可跑）`);
  } catch (error) {
    clearTimeout(timer);
    finish(1, `/health 请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
});
child.stderr.on('data', (chunk) => {
  output += String(chunk);
});
child.on('exit', (code) => {
  if (!finished && code !== 0) finish(1, `进程提前退出（code=${String(code)}）。输出：\n${output}`);
});
