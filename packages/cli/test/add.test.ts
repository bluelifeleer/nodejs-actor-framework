import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { addCapability } from '../src/commands/add.ts';
import { newApp } from '../src/commands/new.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');

function tempDir(name: string): string {
  const dir = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const barrelOf = (dir: string): string => fs.readFileSync(path.join(dir, 'src', 'plugin', 'index.ts'), 'utf8');

test('add: --dry-run 一个字节都不写；真加只动 package.json 与 src/plugin/**（非破坏性）', async () => {
  const dir = tempDir('add-basic');
  try {
    await newApp(dir);
    const dry = await addCapability(dir, { capabilities: ['mail'], webPlugins: ['debug'], dryRun: true });
    assert.deepStrictEqual(dry.added, ['debug', 'mail']);
    assert.deepStrictEqual(dry.skipped, []);
    assert.ok(dry.files.includes('src/plugin/mail.ts') && dry.files.includes('test/mail.test.ts'));
    assert.ok(
      dry.files.every((file) => file === 'package.json' || file.startsWith('src/plugin/') || file.startsWith('test/')),
      `只该动这些地方：${dry.files.join(', ')}`,
    );
    assert.strictEqual(fs.existsSync(path.join(dir, 'src', 'plugin', 'mail.ts')), false, 'dry-run 不能落盘');
    assert.ok(!barrelOf(dir).includes('import mail'), 'dry-run 不能改桶文件');
    assert.ok(dry.manualSteps.some((step) => step.includes('APP_MAIL_DIR')), '要打印需要配置的 env');

    const real = await addCapability(dir, { capabilities: ['mail'], webPlugins: ['debug'] });
    assert.deepStrictEqual(real.added, ['debug', 'mail']);
    assert.ok(fs.existsSync(path.join(dir, 'src', 'plugin', 'mail.ts')));
    assert.match(barrelOf(dir), /import mail from '\.\/mail\.ts'/);
    assert.match(barrelOf(dir), /import debug from '\.\/debug\.ts'/);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    assert.ok(pkg.dependencies['@actor/mail'], JSON.stringify(pkg.dependencies));

    // 幂等：再 add 一次 → 已存在就**跳过**（不覆盖用户改过的代码）
    const again = await addCapability(dir, { capabilities: ['mail'] });
    assert.deepStrictEqual(again.added, []);
    assert.deepStrictEqual(again.skipped, ['mail']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('add: 加完之后生成的项目照样能跑（新增能力的冒烟测试也在里面）', async () => {
  const dir = tempDir('add-runnable');
  try {
    await newApp(dir);
    await addCapability(dir, { webPlugins: ['debug'] });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)('npm', ['test'], { cwd: dir, timeout: 120_000, env });
    assert.match(stdout, /pass 5/, `api 4 + debug 1 = 5 条应当全过：\n${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('add: flat 布局 / 未知能力 / 没说要加什么 都明确报错', async () => {
  const flat = tempDir('add-flat');
  const notProject = tempDir('add-not-project');
  try {
    await newApp(flat, { layout: 'flat' });
    await assert.rejects(() => addCapability(flat, { capabilities: ['mail'] }), /看起来是 flat 布局/);
    await assert.rejects(() => addCapability(notProject, { capabilities: ['mail'] }), /不是一个项目目录/);
    const ok = tempDir('add-errors');
    await newApp(ok);
    try {
      await assert.rejects(() => addCapability(ok, {}), /没说要加什么/);
      await assert.rejects(() => addCapability(ok, { capabilities: ['nope' as never] }), /未知能力 'nope'/);
      await assert.rejects(() => addCapability(ok, { capabilities: ['db'] }), /片段还没实现：db/);
    } finally {
      fs.rmSync(ok, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(flat, { recursive: true, force: true });
    fs.rmSync(notProject, { recursive: true, force: true });
  }
});
