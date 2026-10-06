import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { newApp } from '../src/commands/new.ts';
import { appTemplates } from '../src/templates/app.ts';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..', '..', '..');

/**
 * 脚手架的验收是 **M5 里写死的那条**："新人按文档在 30 分钟内跑通 CRUD + Actor + 持久化 + 测试"。
 * 所以这里不只断言"文件生成了"，而是**把生成的项目真跑起来**：跑它自带的测试（真 HTTP + 真重启）。
 *
 * 生成目录放在仓库内：`@actor/*` 通过 workspace 链接解析得到，不需要联网装依赖。
 */

function tempDir(name: string): string {
  const dir = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('scaffold: 模板清单齐全，package.json / README 里的项目名被替换', async () => {
  const files = await appTemplates('demo-app');
  const names = files.map((file) => file.relative).sort();
  assert.deepStrictEqual(names, [
    '.gitignore',
    'README.md',
    'config/default.ts',
    'main.ts',
    'package.json',
    'src/app.ts',
    'src/counter.ts',
    'src/module.ts',
    'src/notes.ts',
    'test/app.test.ts',
  ]);

  const pkg = JSON.parse(files.find((file) => file.relative === 'package.json')!.content);
  assert.strictEqual(pkg.name, 'demo-app');
  assert.ok(pkg.scripts.start && pkg.scripts.test, '生成的项目要有 start / test');
  for (const dep of ['@actor/app', '@actor/data', '@actor/web']) {
    assert.ok(pkg.dependencies[dep], `依赖里要有 ${dep}`);
  }
  assert.ok(
    !JSON.stringify(pkg).includes('nodejs-actor-framework'),
    '用户项目不该直接依赖内核（用户项目依赖 @actor/*）',
  );
  assert.ok(files.find((file) => file.relative === 'README.md')!.content.includes('demo-app'));
});

test('scaffold: 非空目录默认拒绝（--force 才写入）', async () => {
  const dir = tempDir('nonempty');
  try {
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'x');
    await assert.rejects(
      () => newApp(dir),
      (err: unknown) => {
        assert.match(String((err as Error).message), /目标目录非空/);
        assert.strictEqual(fs.existsSync(path.join(dir, 'main.ts')), false, '被拒时不该写任何文件');
        return true;
      },
    );
    const forced = await newApp(dir, { force: true });
    assert.ok(forced.files.includes('main.ts'));
    assert.ok(fs.existsSync(path.join(dir, 'existing.txt')), '--force 也不删用户已有的文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold: 缺少目标目录时报用法错误', async () => {
  await assert.rejects(() => newApp(''), /缺少目标目录/);
});

test('scaffold: **生成的项目真能跑** —— 跑它自带的测试（CRUD + Actor + 持久化 + 错误语义）', async () => {
  const dir = tempDir('runnable');
  try {
    const result = await newApp(dir);
    assert.strictEqual(result.files.length, 10);

    // 生成项目自带 4 条用例，其中一条真的重启应用验证持久化。
    // 注意：必须清掉 NODE_TEST_CONTEXT —— 否则孙进程（生成项目里的 node --test）会以为自己在
    // 父测试运行器里，输出被接管，我们只能看到 npm 的 banner（真踩过）。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await run('npm', ['test'], { cwd: dir, timeout: 120_000, env });
    assert.match(stdout, /pass 4/, `生成项目的测试应当 4 条全过：\n${stdout}`);
    assert.ok(!/fail [1-9]/.test(stdout), `生成项目的测试不该有失败：\n${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
