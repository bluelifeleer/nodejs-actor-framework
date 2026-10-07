import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPOSE_FILE, envLines, SERVICES, TEST_URLS, USAGE } from '../scripts/dev-databases.mjs';

/**
 * `scripts/dev-databases.mjs` 的**离线契约**（真库路径需要 docker，这里只测不依赖 docker 的部分）。
 *
 * 为什么要测一个脚本：
 *   1. 它打印的 `ACTOR_TEST_*_URL` 是使用者唯一的"变量从哪来"的来源，打印错了会浪费半天；
 *   2. 端口必须与 `databases.compose.yml` **一致**（文档说一个、compose 开另一个是最典型的坑）；
 *   3. 每个 URL 必须能被框架自己认出来（`dialectFromUrl`）—— 写这条时当场发现了 mssql 的
 *      scheme 映射漏了（`mssql://` 直接报错），已修；
 *   4. 没有 docker 时必须**明确报错**，不许静默退出 0。
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dev-databases.mjs');

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });
}

function dockerAvailable() {
  return spawnSync('docker', ['--version'], { encoding: 'utf8' }).status === 0;
}

test('dev-databases: 打印的变量覆盖面（pg/mysql/mssql/redis/ioredis/mongo 都要有）', () => {
  assert.deepStrictEqual(Object.keys(TEST_URLS).sort(), [
    'ACTOR_TEST_IOREDIS_URL',
    'ACTOR_TEST_MONGO_URL',
    'ACTOR_TEST_MSSQL_URL',
    'ACTOR_TEST_MYSQL_URL',
    'ACTOR_TEST_PG_URL',
    'ACTOR_TEST_REDIS_URL',
  ]);
  const lines = envLines();
  assert.strictEqual(lines.length, 6);
  for (const line of lines) assert.match(line, /^export ACTOR_TEST_[A-Z]+_URL='\S+'$/, `导出行格式不对：${line}`);
});

test('dev-databases: 打印的 SQL URL 必须被框架认出来（dsn → 方言）', async () => {
  const { dialectFromUrl, parseConnection } = await import('../packages/db/src/index.ts');
  const expected = {
    ACTOR_TEST_PG_URL: 'pgsql',
    ACTOR_TEST_MYSQL_URL: 'mysql',
    ACTOR_TEST_MSSQL_URL: 'mssql',
  };
  for (const [name, dialect] of Object.entries(expected)) {
    const url = TEST_URLS[name];
    assert.strictEqual(dialectFromUrl(url), dialect, `${name} 推断错了：${url}`);
    assert.strictEqual(parseConnection({ url }).dialect, dialect, `${name} 解析错了`);
  }
});

test('dev-databases: 端口必须与 databases.compose.yml 一致（文档与实现不许打架）', () => {
  const compose = fs.readFileSync(COMPOSE_FILE, 'utf8');
  for (const service of SERVICES) {
    assert.match(compose, new RegExp(`\\b${service}:`), `compose 里缺少服务 ${service}`);
  }
  const published = new Set([...compose.matchAll(/'(\d+):\d+'/g)].map((match) => Number(match[1])));
  const used = new Set(
    Object.values(TEST_URLS).map((url) => {
      const withScheme = url.includes('://') ? url : `x://${url}`;
      return Number(new URL(withScheme).port);
    }),
  );
  for (const port of used) {
    assert.ok(published.has(port), `URL 里的端口 ${port} 在 compose 里没有发布：${[...published].join(', ')}`);
  }
});

test('dev-databases: env 子命令（纯打印，不依赖 docker）', () => {
  const result = run('env');
  assert.strictEqual(result.status, 0, `env 应当成功：${result.stderr}`);
  for (const name of Object.keys(TEST_URLS)) {
    assert.match(result.stdout, new RegExp(`export ${name}=`), `env 输出里缺少 ${name}`);
  }
});

test('dev-databases: 不认识的子命令要报错并给出用法（不许静默退出 0）', () => {
  const result = run('fly-to-the-moon');
  assert.strictEqual(result.status, 2, `未知子命令应当退出码 2，实际 ${String(result.status)}`);
  assert.match(result.stdout, /up\|down\|status\|env/, '应当打印用法');
  assert.match(USAGE, /up\[?|up/);
});

test(
  'dev-databases: 没有 docker 时必须明确报错（而不是静默跳过）',
  { skip: dockerAvailable() ? '本机有 docker，这条只在没有 docker 的环境有意义' : false },
  () => {
    const result = run('up', 'pg');
    assert.strictEqual(result.status, 2, `没有 docker 时应当退出码 2，实际 ${String(result.status)}`);
    assert.match(result.stderr, /找不到 docker/, '应当明确说明找不到 docker');
  },
);
