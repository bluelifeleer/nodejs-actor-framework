import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GENERATE_KINDS, camelOf, kebabOf, parseField, pascalOf } from '../src/commands/generate.ts';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'src', 'cli.ts');

function tempProject(name: string): string {
  const parent = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(parent, { recursive: true, force: true });
  fs.mkdirSync(parent, { recursive: true });
  return parent;
}

/** 起一个真项目（与用户一样走脚手架），返回项目目录。 */
async function scaffold(parent: string, flags: readonly string[] = []): Promise<string> {
  await run(process.execPath, [CLI, 'new', 'app', parent, ...flags]);
  return parent;
}

/** `npm test` 把报告写到 stderr，两路都要看；子进程要删掉 NODE_TEST_CONTEXT（否则被判定成递归运行）。 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('generate: 名字转换（camel / kebab / Pascal）与字段解析', () => {
  assert.strictEqual(camelOf('note-item'), 'noteItem');
  assert.strictEqual(camelOf('note_item'), 'noteItem');
  assert.strictEqual(pascalOf('note-item'), 'NoteItem');
  assert.strictEqual(kebabOf('noteItem'), 'note-item');
  assert.deepStrictEqual(parseField('title:string'), { name: 'title', type: 'string' });
  assert.deepStrictEqual(parseField('done:bool'), { name: 'done', type: 'bool' });
  assert.deepStrictEqual(parseField('size:int'), { name: 'size', type: 'number' });
  assert.deepStrictEqual(parseField('tags:json'), { name: 'tags', type: 'json' });
  assert.deepStrictEqual(parseField('title'), { name: 'title', type: 'string' }, '省略类型默认 string');
  assert.throws(() => parseField('title:strng'), /类型不认识/);
  assert.throws(() => parseField(':string'), /格式是/);
});

test('generate: 八种骨架都能生成，且**生成的项目 typecheck 通过、测试全过**', async () => {
  const project = tempProject('generate-all');
  try {
    await scaffold(project);
    for (const kind of GENERATE_KINDS) {
      const { stdout } = await run(
        process.execPath,
        [CLI, 'generate', kind, `probe-${kind}`, '--field', 'title:string', ...(kind === 'schema' ? ['--optimistic-lock'] : [])],
        { cwd: project, env: childEnv() },
      );
      assert.match(stdout, new RegExp(`已生成 ${kind} 骨架`), `${kind} 应当生成成功：\n${stdout}`);
      assert.match(stdout, /下一步：/, `${kind} 要打印"下一步"（module.ts 片段）`);
    }

    // 生成的文件真的在（layered 布局）
    for (const [kind, file] of [
      ['controller', 'src/controller/probe-controller.controller.ts'],
      ['actor', 'src/actor/probe-actor.actor.ts'],
      ['service', 'src/service/probe-service.service.ts'],
      ['model', 'src/model/probe-model.ts'],
      ['schema', 'src/schema/probe-schema.schema.ts'],
      ['middleware', 'src/middleware/probe-middleware.ts'],
      ['test', 'test/probe-test.test.ts'],
      ['command', '.actor/commands/probe-command.ts'],
    ] as const) {
      assert.ok(fs.existsSync(path.join(project, file)), `${kind} 应当生成 ${file}`);
    }
    // 每种都自带测试（默认）
    for (const file of [
      'test/probe-controller.controller.test.ts',
      'test/probe-actor.actor.test.ts',
      'test/probe-service.service.test.ts',
      'test/probe-model.model.test.ts',
      'test/probe-schema.schema.test.ts',
      'test/probe-middleware.middleware.test.ts',
      'test/probe-test.test.ts',
    ]) {
      assert.ok(fs.existsSync(path.join(project, file)), `应当生成 ${file}`);
    }

    // 关键证据 ①：生成的项目仍然 typecheck 通过
    await run('npx', ['--no-install', 'tsc', '-p', '.', '--noEmit'], { cwd: project, env: childEnv(), timeout: 240_000 });

    // 关键证据 ②：生成骨架自带的测试真的跑过（12 = 脚手架 4 条 + 生成的 8 条；command 不带测试）
    const { stdout, stderr } = await run('npm', ['test'], { cwd: project, env: childEnv(), timeout: 240_000 });
    const output = `${stdout}${stderr}`;
    assert.match(output, /pass 12/, `生成的测试应当全过：\n${output}`);
    assert.ok(!/fail [1-9]/.test(output), `不该有失败：\n${output}`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('generate: 非破坏性 —— 已存在的文件默认跳过（不覆盖用户改过的代码），--force 才写', async () => {
  const project = tempProject('generate-guards');
  try {
    await scaffold(project);
    const target = path.join(project, 'src', 'controller', 'guard.controller.ts');
    await run(process.execPath, [CLI, 'generate', 'controller', 'guard'], { cwd: project, env: childEnv() });
    const generated = fs.readFileSync(target, 'utf8');

    // 用户改过这个文件
    fs.writeFileSync(target, '// 我改过的内容\n', 'utf8');
    const again = await run(process.execPath, [CLI, 'generate', 'controller', 'guard'], { cwd: project, env: childEnv() });
    assert.match(again.stdout, /已存在，跳过/, `应当明确说"跳过"：\n${again.stdout}`);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '// 我改过的内容\n', '不能覆盖用户改过的文件');
    assert.notStrictEqual(generated, '');

    // --force 才覆盖
    await run(process.execPath, [CLI, 'generate', 'controller', 'guard', '--force'], { cwd: project, env: childEnv() });
    assert.notStrictEqual(fs.readFileSync(target, 'utf8'), '// 我改过的内容\n', '--force 应当覆盖');

    // --dry-run 一个字节都不写
    const dry = await run(process.execPath, [CLI, 'generate', 'controller', 'dry', '--dry-run'], { cwd: project, env: childEnv() });
    assert.match(dry.stdout, /\[dry-run\] 计划生成/);
    assert.strictEqual(fs.existsSync(path.join(project, 'src', 'controller', 'dry.controller.ts')), false, 'dry-run 不能落盘');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('generate: 用法错误有明确提示（未知 kind / 非法名字 / 不在项目里 / 缺名字）', async () => {
  const project = tempProject('generate-usage');
  const outside = path.join(ROOT, '.tmp-cli', `generate-outside-${process.pid}`);
  fs.mkdirSync(outside, { recursive: true });
  const expectFail = async (args: readonly string[], pattern: RegExp, cwd: string): Promise<void> => {
    const result = await run(process.execPath, [CLI, ...args], { cwd, env: childEnv() }).catch((error: { stderr?: string }) => error);
    assert.match(String(result.stderr ?? ''), pattern, `期望报错 ${String(pattern)}，实际：${String(result.stderr ?? '')}`);
  };
  try {
    await scaffold(project);
    await expectFail(['generate', 'nope', 'x'], /未知的骨架 'nope'/, project);
    // 名字里的分隔符允许 - 与 _；真正非法的是空格 / 数字开头 / 空
    await expectFail(['generate', 'controller', 'bad name'], /名字不合法/, project);
    await expectFail(['generate', 'controller', '1bad'], /名字不合法/, project);
    await expectFail(['generate', 'controller', ''], /缺少名字/, project);
    await expectFail(['generate', 'controller', 'x'], /看起来不是 actor 项目/, outside);
    await expectFail(['generate', 'controller', 'x', '--field'], /需要一个值/, project);
    // `--field` 可以重复给（收成数组，不是后一个覆盖前一个）
    await run(process.execPath, [CLI, 'generate', 'schema', 'multi', '--field', 'a:string', '--field', 'b:int', '--field', 'c:bool'], {
      cwd: project,
      env: childEnv(),
    });
    const schema = fs.readFileSync(path.join(project, 'src', 'schema', 'multi.schema.ts'), 'utf8');
    for (const field of ['a:', 'b:', 'c:']) assert.match(schema, new RegExp(`\\n\\s+${field}`), `字段 ${field} 应当在：\n${schema}`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('generate: command 骨架能被 `actor commands` 发现并执行（生成器与自定义命令衔接）', async () => {
  const project = tempProject('generate-command');
  try {
    await scaffold(project);
    await run(process.execPath, [CLI, 'generate', 'command', 'probe'], { cwd: project, env: childEnv() });

    const listed = await run(process.execPath, [CLI, 'commands'], { cwd: project, env: childEnv() });
    assert.match(listed.stdout, /probe/);
    assert.match(listed.stdout, /\.actor\/commands\/probe\.ts/);

    const executed = await run(process.execPath, [CLI, 'probe', '--count', '3'], { cwd: project, env: childEnv() });
    assert.match(executed.stdout, /count=3/, `生成的 command 要能跑：\n${executed.stdout}`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('generate: migration —— 版本号自动接续，且文件是合法的 Migration（能被迁移运行器加载）', async () => {
  const project = tempProject('generate-migration');
  try {
    await scaffold(project);
    const first = await run(process.execPath, [CLI, 'generate', 'migration', 'create-notes'], { cwd: project, env: childEnv() });
    assert.match(first.stdout, /已生成 migration 骨架 create-notes/);
    const firstFile = fs.readdirSync(path.join(project, 'src', 'migrations'))[0] as string;
    assert.match(fs.readFileSync(path.join(project, 'src', 'migrations', firstFile), 'utf8'), /version: 1/, '第一个迁移应当是 v1');

    // 第二个自动接续成 v2
    const second = await run(process.execPath, [CLI, 'generate', 'migration', 'add-tags'], { cwd: project, env: childEnv() });
    assert.match(second.stdout, /import v2 from/, `片段里的 import 名要带对版本号（v2）：\n${second.stdout}`);
    // 片段里的文件名/版本与真实产物对得上
    assert.match(second.stdout, /import v2 from '\.\/migrations\/\d{4}-\d{2}-\d{2}-[^']*-add-tags'/);
    assert.match(second.stdout, /export default \[/);

    const dir = path.join(project, 'src', 'migrations');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).sort();
    assert.strictEqual(files.length, 2, `应当有两个迁移文件：${files.join(', ')}`);
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.match(text, /async up\(\{ log \}\)/, 'up 签名要符合 Migration 类型（上下文只有 store/log）');
      assert.match(text, /import type \{ Migration \} from '@actor\/data';/);
    }

    // 显式指定版本也认
    await run(process.execPath, [CLI, 'generate', 'migration', 'manual', '--migration-version', '9'], { cwd: project, env: childEnv() });
    const manual = fs.readdirSync(path.join(project, 'src', 'migrations')).find((name) => name.includes('manual')) as string;
    assert.match(fs.readFileSync(path.join(project, 'src', 'migrations', manual), 'utf8'), /version: 9/, '显式版本要生效');

    // 生成的迁移能被 CLI 真的加载（migrate status 不报错；这里只是"没有 pending"的干净状态）
    const status = await run(process.execPath, [CLI, 'migrate', 'status'], { cwd: project, env: childEnv() }).catch((error: { stdout?: string; stderr?: string }) => error);
    assert.ok(!String(status.stderr ?? '').includes('失败'), `迁移不该让 CLI 报错：${String(status.stderr ?? '')}`);

    // 关键：项目仍然 typecheck 通过（生成的迁移文件参与编译）
    await run('npx', ['--no-install', 'tsc', '-p', '.', '--noEmit'], { cwd: project, env: childEnv(), timeout: 240_000 });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('generate: flat 布局生成到扁平目录（跟随项目形状）', async () => {
  const project = tempProject('generate-flat');
  try {
    await scaffold(project, ['--layout', 'flat']);
    const { stdout } = await run(process.execPath, [CLI, 'generate', 'controller', 'ping'], { cwd: project, env: childEnv() });
    assert.match(stdout, /flat 布局/, `应当识别出 flat：\n${stdout}`);
    assert.ok(fs.existsSync(path.join(project, 'src', 'ping.controller.ts')), 'flat 布局生成到 src/ 下（没有 controller/ 子目录）');
    assert.ok(!fs.existsSync(path.join(project, 'src', 'controller', 'ping.controller.ts')));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
