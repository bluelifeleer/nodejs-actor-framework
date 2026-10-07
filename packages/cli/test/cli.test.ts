import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'src', 'cli.ts');

/** 跑 CLI 并拿到退出码/stdout/stderr（不抛错，退出码是要断言的东西）。 */
async function cli(args: string[], cwd = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

test('cli: --help / --version 正常，未知命令与空命令是用法错误（退出码 1）', async () => {
  const help = await cli(['--help']);
  assert.strictEqual(help.code, 0);
  assert.match(help.stdout, /actor new app <dir>/);

  const version = await cli(['--version']);
  assert.strictEqual(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);

  const empty = await cli([]);
  assert.strictEqual(empty.code, 1, '没给命令 = 用法错误');
  assert.match(empty.stderr, /用法/);

  const unknown = await cli(['deploy']);
  assert.strictEqual(unknown.code, 1);
  assert.match(unknown.stderr, /未知命令 'deploy'/);

  const unknownScaffold = await cli(['new', 'service', 'x']);
  assert.strictEqual(unknownScaffold.code, 1);
  assert.match(unknownScaffold.stderr, /未知的脚手架 'service'/, '要报出用户实际打的那个词');

  const misspelled = await cli(['new', 'app', 'x', '--forse']);
  assert.strictEqual(misspelled.code, 1);
  assert.match(misspelled.stderr, /未知选项 '--forse'/);
  assert.match(misspelled.stderr, /提示：/, '用法错误要给"下一步该做什么"');
  assert.ok(!/at .*\.ts:\d+/.test(misspelled.stderr), '默认不打印堆栈（对使用者没有信息量）');
});

test('cli: new app 生成后打印下一步；未知目录非空时退出码 1 且不写文件', async () => {
  const dir = path.join(ROOT, '.tmp-cli', `cli-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const created = await cli(['new', 'app', dir]);
    assert.strictEqual(created.code, 0);
    // 默认 layered：16 个文件（flat 是 10 个，见 scaffold.test.ts）
    assert.match(created.stdout, /已生成 16 个文件/);
    assert.match(created.stdout, /npm install/, '要告诉用户下一步做什么');
    assert.ok(fs.existsSync(path.join(dir, 'main.ts')));

    const again = await cli(['new', 'app', dir]);
    assert.strictEqual(again.code, 1, '非空目录必须拒绝（默认行为）');
    assert.match(again.stderr, /目标目录非空/);

    const forced = await cli(['new', 'app', dir, '--force']);
    assert.strictEqual(forced.code, 0, '--force 才覆盖');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: 打包清单包含模板（npm pack 漏带 templates/ 是这类脚手架的经典事故）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.files, ['src', 'templates'], 'files 必须同时包含 src 与 templates');
  assert.ok(fs.existsSync(path.join(ROOT, 'packages', 'cli', 'templates', 'app', 'main.ts')));
  assert.strictEqual(pkg.bin.actor, './src/cli.ts', 'bin 指向 CLI 入口');
});
