import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { realDatabaseUrl, testWithDatabase } from '../src/index.ts';

/**
 * 真库开关助手的行为契约：**跳过必须可见**（设计文档 §7 明确要求）。
 *
 * 这里用子进程跑一个临时夹具：同一段代码，在设了环境变量时必须**真的执行**，
 * 没设时必须注册成**显式 skip**（输出里有 `skipped 1`），不许静默变绿。
 */
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CORE_URL = pathToFileURL(path.join(ROOT, 'packages', 'db-core', 'src', 'index.ts')).href;

function runFixture(env: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-db-fixture-'));
  const fixture = path.join(dir, 'fixture.test.ts');
  fs.writeFileSync(
    fixture,
    [
      `import { test } from 'node:test';`,
      `import assert from 'node:assert';`,
      `import { realDatabaseUrl, testWithDatabase } from ${JSON.stringify(CORE_URL)};`,
      `testWithDatabase('ACTOR_TEST_FIXTURE', '需要真库的用例', () => {`,
      `  assert.ok(realDatabaseUrl('ACTOR_TEST_FIXTURE')?.startsWith('fixture://'), '夹具里应当能读到变量');`,
      `});`,
    ].join('\n'),
  );
  // 注意：不能把父进程的测试上下文传给子进程 —— 否则 node --test 会判定"递归调用测试运行器"
  // 并直接跳过所有文件（输出里只有一句 warning，没有 test 结果）。
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NODE_TEST')) continue;
    if (value !== undefined) childEnv[key] = value;
  }
  const result = spawnSync(process.execPath, ['--test', fixture], {
    encoding: 'utf8',
    env: { ...childEnv, ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return `${result.stdout}${result.stderr}`;
}

test('real-db helpers: 没设环境变量 → 显式跳过（输出里有 skipped），不是静默不注册', () => {
  const output = runFixture({ ACTOR_TEST_FIXTURE: '' });
  assert.match(output, /skipped 1/, `没设变量时应当是可见跳过：\n${output}`);
  assert.match(output, /ACTOR_TEST_FIXTURE not set/, '跳过原因要写清是哪个变量没设');
});

test('real-db helpers: 设了环境变量 → 用例真的执行（断言跑到了）', () => {
  const output = runFixture({ ACTOR_TEST_FIXTURE: 'fixture://ok' });
  assert.match(output, /^ℹ pass 1$/m, `设了变量时应当真的跑：\n${output}`);
  assert.doesNotMatch(output, /skipped 1/, '设了变量就不该再跳过');
});

test('real-db helpers: 空串等同于没设（避免"export 了个空变量就当配了"）', () => {
  assert.strictEqual(realDatabaseUrl('ACTOR_TEST_DEFINITELY_NOT_SET_XYZ'), undefined);
  process.env.ACTOR_TEST_BLANK = '   ';
  try {
    assert.strictEqual(realDatabaseUrl('ACTOR_TEST_BLANK'), undefined);
  } finally {
    delete process.env.ACTOR_TEST_BLANK;
  }
  process.env.ACTOR_TEST_PRESENT = 'value';
  try {
    assert.strictEqual(realDatabaseUrl('ACTOR_TEST_PRESENT'), 'value');
  } finally {
    delete process.env.ACTOR_TEST_PRESENT;
  }
});
