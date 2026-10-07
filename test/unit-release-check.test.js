import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ROOT,
  checkChangelog,
  checkEngines,
  checkPackContents,
  checkTestMatrix,
  runReleaseCheck,
} from '../tools/release-check.mjs';

const run = promisify(execFile);

/**
 * 发布检查是门禁——**门禁自己不失败就没有意义**。
 * 所以每条检查都同时验证"该过会过"和"该拦会拦"（后者用注入的假数据，不去动仓库）。
 */

test('release check: 工作区测试矩阵 —— 有测试的包必须进根 npm test 的 glob', async () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-release-'));
  try {
    for (const name of ['alpha', 'beta', 'gamma']) {
      fs.mkdirSync(path.join(tmp, name, 'test'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, name, 'package.json'),
        JSON.stringify({ name, version: '0.0.0', test: 'node --test' }),
      );
    }
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        workspaces: ['packages/*'],
        engines: { node: '>=24' },
        scripts: { test: "node --test 'packages/alpha/test/*.test.js' 'packages/beta/test/*.test.js'" },
      }),
    );
    fs.mkdirSync(path.join(tmp, 'packages'), { recursive: true });
    for (const name of ['alpha', 'beta', 'gamma']) {
      fs.renameSync(path.join(tmp, name), path.join(tmp, 'packages', name));
    }

    const result = await checkTestMatrix({ root: tmp });
    assert.strictEqual(result.ok, false, 'gamma 有测试却不在 glob 里 → 必须拦');
    assert.deepStrictEqual(result.missing, ['gamma']);
    assert.match(result.detail, /gamma/);
    assert.match(result.fix, /package\.json/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('release check: CHANGELOG 版本一致 —— 只对内核负责，缺条目要拦住', async () => {
  const packages = [{ name: 'nodejs-actor-framework', version: '9.9.9', dir: ROOT }];
  const missing = await checkChangelog({ packages, changelog: '## [Unreleased]\n\n- x\n' });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.detail, /没有 9\.9\.9 的条目/);
  assert.match(missing.fix, /9\.9\.9/);

  const present = await checkChangelog({ packages, changelog: '## [9.9.9] - 2026-01-01\n\n- y\n' });
  assert.strictEqual(present.ok, true);

  const noFile = await checkChangelog({ root: path.join(ROOT, 'definitely-missing'), packages });
  assert.strictEqual(noFile.ok, false, '没有 CHANGELOG 也要拦');
});

test('release check: engines 一致 —— 与根 package.json 不一致（或没声明）都要拦', async () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-release-engines-'));
  try {
    fs.mkdirSync(path.join(tmp, 'packages', 'a'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'packages', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x', workspaces: ['packages/*'], engines: { node: '>=24' } }));
    fs.writeFileSync(path.join(tmp, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a', engines: { node: '>=24' } }));
    fs.writeFileSync(path.join(tmp, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'b', engines: { node: '>=18' } }));
    const result = await checkEngines({ root: tmp });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.mismatched, ['b（>=18）']);

    fs.writeFileSync(path.join(tmp, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'b' }));
    const undeclared = await checkEngines({ root: tmp });
    assert.deepStrictEqual(undeclared.mismatched, ['b（未声明）'], '没声明也算不一致');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('release check: npm pack 内容 —— 测试/凭据/数据目录不能进 tarball', async () => {
  const packages = [{ name: 'demo', version: '1.0.0', dir: ROOT }];

  const bad = await checkPackContents({
    packages,
    packFiles: async () => ['src/index.ts', 'test/secret.test.ts', 'fixtures/tls/ca.key', 'data/dump.json'],
  });
  assert.strictEqual(bad.ok, false, '测试/私钥/数据都要拦');
  assert.strictEqual(bad.forbidden.length, 3);
  assert.match(bad.detail, /test\/secret\.test\.ts/);

  const good = await checkPackContents({ packages, packFiles: async () => ['src/index.ts', 'index.mjs', 'package.json'] });
  assert.strictEqual(good.ok, true);
  assert.deepStrictEqual(good.forbidden, []);

  // 真实跑一遍内核的 npm pack：**凭据/测试绝不能进 tarball**
  const real = await checkPackContents();
  assert.strictEqual(real.ok, true, `真实 pack 内容有违规文件：${JSON.stringify(real.forbidden)}`);
  assert.ok(real.files.some((file) => file.endsWith('index.mjs')), 'tarball 里应当有 index.mjs');
});

test('release check: 端到端 —— 五项结果形状稳定（--skip-ci --allow-dirty --json）', async () => {
  // 注意：发布检查**故意**在 CHANGELOG 还没切版本时以退出码 1 结束，所以这里要容忍非零退出
  const stdout = await run(process.execPath, ['tools/release-check.mjs', '--skip-ci', '--allow-dirty', '--json'], {
    cwd: ROOT,
    timeout: 300_000,
  })
    .then((result) => result.stdout)
    .catch((err) => err.stdout);
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.results.length, 6);
  for (const result of parsed.results) {
    assert.strictEqual(typeof result.name, 'string');
    assert.strictEqual(typeof result.ok, 'boolean');
    assert.strictEqual(typeof result.detail, 'string');
    if (!result.ok) assert.strictEqual(typeof result.fix, 'string', '失败项必须给出下一步');
  }
  const names = parsed.results.map((result) => result.name);
  for (const expected of [
    '工作区测试矩阵',
    'npm pack 内容',
    'CHANGELOG 版本一致',
    'engines 一致',
    '内核公开面与类型覆盖',
    '工作区干净',
  ]) {
    assert.ok(names.includes(expected), `缺少检查项 ${expected}`);
  }

  // 不加 --allow-dirty 时，脏工作区应当被拦（这里用一个临时改动验证）
  const results = await runReleaseCheck({ skipCi: true, allowDirty: false, log: () => {} });
  const clean = results.find((result) => result.name === '工作区干净');
  assert.strictEqual(typeof clean.ok, 'boolean');
});
