import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { newPlugin } from '../src/commands/new-plugin.ts';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..', '..', '..');

function tempDir(name: string): string {
  const dir = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('new plugin: 四种 kind 都生成骨架，且**生成的插件真能跑自己的契约/行为套件**', async () => {
  for (const kind of ['app', 'web', 'resource', 'mail'] as const) {
    const parent = tempDir(`plugin-${kind}`);
    try {
      const result = await newPlugin(`probe-${kind}-plugin`, { kind, dir: parent });
      assert.strictEqual(result.kind, kind);
      assert.deepStrictEqual(
        [...result.files].sort(),
        ['README.md', 'package.json', 'src/index.ts', 'test/contract.test.ts'],
        `骨架文件清单不对：${result.files.join(', ')}`,
      );
      // 关键：web/resource/mail 用框架**已发布**的契约套件；app 没有已发布套件，用骨架自带的行为断言
      const contract = fs.readFileSync(path.join(result.dir, 'test', 'contract.test.ts'), 'utf8');
      const expectedSuite = {
        web: 'runWebPluginContract',
        resource: 'runManagedResourceContract',
        mail: 'runMailTransportContract',
        app: 'createApp',
      }[kind];
      assert.match(contract, new RegExp(expectedSuite), `${kind} 骨架应当用 ${expectedSuite}`);
      const pkg = JSON.parse(fs.readFileSync(path.join(result.dir, 'package.json'), 'utf8')) as {
        name: string;
        dependencies: Record<string, string>;
      };
      assert.strictEqual(pkg.name, `probe-${kind}-plugin`, '包名要用用户给的名字');
      assert.deepStrictEqual(Object.keys(pkg.dependencies), [
        { app: '@actor/app', web: '@actor/web', resource: '@actor/resource', mail: '@actor/mail' }[kind],
      ]);

      // 跑它自带的契约套件（生成物在仓库内，所以 @actor/* 能解析）
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const { stdout } = await run('npm', ['test'], { cwd: result.dir, timeout: 120_000, env });
      assert.match(stdout, /pass [1-9]/, `${kind} 生成的插件契约套件应当全过：\n${stdout}`);
      assert.ok(!/fail [1-9]/.test(stdout), `${kind} 生成的插件不该有失败：\n${stdout}`);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
});

test('new plugin: --dry-run 一个字节都不写；非空目录拒绝；未知 kind / 非法名字 / 缺名字都明确报错', async () => {
  const parent = tempDir('plugin-guards');
  try {
    const dry = await newPlugin('dry-plugin', { kind: 'web', dir: parent, dryRun: true });
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(fs.existsSync(dry.dir), false, 'dry-run 不能建目录');

    const real = await newPlugin('dry-plugin', { kind: 'web', dir: parent });
    assert.ok(fs.existsSync(path.join(real.dir, 'src', 'index.ts')));
    await assert.rejects(() => newPlugin('dry-plugin', { kind: 'web', dir: parent }), /目标目录非空/);
    const forced = await newPlugin('dry-plugin', { kind: 'web', dir: parent, force: true });
    assert.strictEqual(forced.kind, 'web');

    await assert.rejects(() => newPlugin('', { kind: 'web', dir: parent }), /缺少插件名/);
    await assert.rejects(() => newPlugin('Bad_Name', { kind: 'web', dir: tempDir('plugin-badname') }), /插件名不合法/);
    await assert.rejects(
      () => newPlugin('kind-plugin', { kind: 'nope', dir: tempDir('plugin-badkind') }),
      /未知的插件类型 'nope'/,
      '未知 kind → 明确拒绝，不生成一半',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, '.tmp-cli', `plugin-badname-${process.pid}`), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, '.tmp-cli', `plugin-badkind-${process.pid}`), { recursive: true, force: true });
  }
});

test('new plugin: --repo 给出四张矩阵的接线清单（漏一处不会静默）', async () => {
  const parent = tempDir('plugin-repo');
  try {
    const result = await newPlugin('@me/scoped-plugin', { kind: 'web', dir: parent, repo: true, dryRun: true });
    assert.strictEqual(result.dir, path.join(parent, 'scoped-plugin'), '作用域包用短名做目录');
    // 依赖 1 行 + 四张矩阵 4 行 + 门禁提示 1 行
    assert.strictEqual(result.wiring.length, 7, `接线清单应当有 7 行：${JSON.stringify(result.wiring)}`);
    for (const keyword of ['scripts.test', 'tsconfig.json', 'docs-site.mjs', '导出基线', 'unit-package-matrices']) {
      assert.ok(result.wiring.some((line) => line.includes(keyword)), `清单里该提 ${keyword}`);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
