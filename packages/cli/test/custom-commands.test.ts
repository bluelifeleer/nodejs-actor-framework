import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { BUILTIN_COMMANDS, commandUsage, defineCommand, discoverCommands, parseCommandFlags, renderCommands } from '../src/commands/custom.ts';

import { doctor } from '../src/commands/doctor.ts';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'src', 'cli.ts');
/** 夹具里 import defineCommand 用的绝对路径（项目深度不同，相对路径会解析错）。 */
const CUSTOM_MODULE = path.join(ROOT, 'packages', 'cli', 'src', 'commands', 'custom.ts');

function tempDir(name: string): string {
  const dir = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 起一个真项目（走脚手架）。 */
async function scaffold(dir: string): Promise<string> {
  await run(process.execPath, [CLI, 'new', 'app', dir]);
  return dir;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** 在项目里写一个自定义命令（集中声明方式）。 */
function writeBarrelCommand(project: string, body: string): string {
  const file = path.join(project, '.actor', 'commands.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('P4: defineCommand 在定义期就校验（名字/run/flags 的 type）', () => {
  assert.throws(() => defineCommand({ name: '', run: () => 0 }), /"name" 是必需项/);
  assert.throws(() => defineCommand({ name: 'Bad Name', run: () => 0 }), /命令名不合法/);
  assert.throws(() => defineCommand({ name: 'ok', run: undefined as never }), /"run" 必须是函数/);
  assert.throws(
    () => defineCommand({ name: 'ok', run: () => 0, flags: { n: { type: 'nope' as never } } }),
    /type 必须是 string\|number\|boolean/,
  );
  const spec = defineCommand({ name: 'ok', summary: 's', run: () => 0 });
  assert.strictEqual(spec.name, 'ok');
});

test('P4: 选项解析 —— 默认值 / 数字 / 布尔 / `=` 写法 / 未知选项报错', () => {
  const spec = defineCommand({
    name: 'seed',
    flags: {
      count: { type: 'number', default: 10 },
      'dry-run': { type: 'boolean', default: false },
      name: { type: 'string' },
    },
    run: () => 0,
  });
  assert.deepStrictEqual(parseCommandFlags(spec, []), { flags: { count: 10, 'dry-run': false }, positionals: [] });
  assert.deepStrictEqual(parseCommandFlags(spec, ['--count', '3', '--name', 'x']), {
    flags: { count: 3, 'dry-run': false, name: 'x' },
    positionals: [],
  });
  assert.deepStrictEqual(parseCommandFlags(spec, ['--count=7', '--dry-run', 'pos']), {
    flags: { count: 7, 'dry-run': true },
    positionals: ['pos'],
  });
  assert.throws(() => parseCommandFlags(spec, ['--nope']), /未知选项 '--nope'/);
  assert.throws(() => parseCommandFlags(spec, ['--count']), /需要一个值/);
  assert.throws(() => parseCommandFlags(spec, ['--count', 'abc']), /需要数字/);

  const usage = commandUsage(spec);
  assert.match(usage, /actor seed/);
  assert.match(usage, /--count <number>（默认 10）/);
});

test('P4: 发现 —— 集中声明与目录两种来源都认，重名/与内置重名明确报错', async () => {
  const project = tempDir('custom-discover');
  try {
    writeBarrelCommand(
      project,
      [
        `import { defineCommand } from '${CUSTOM_MODULE}';`,
        'export const commands = [',
        "  defineCommand({ name: 'alpha', summary: 'A', run: () => 0 }),",
        "  defineCommand({ name: 'beta', summary: 'B', run: () => 0 }),",
        '];',
        '',
      ].join('\n'),
    );
    const dir = path.join(project, '.actor', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'gamma.ts'),
      [
        `import { defineCommand } from '${CUSTOM_MODULE}';`,
        "export default defineCommand({ name: 'gamma', summary: 'G', run: () => 0 });",
        '',
      ].join('\n'),
      'utf8',
    );

    const found = await discoverCommands(project);
    assert.deepStrictEqual(found.map((item) => item.spec.name), ['alpha', 'beta', 'gamma'], '两种来源都要发现');
    assert.strictEqual(found[0]?.source, '.actor/commands.ts');
    assert.strictEqual(found[2]?.source, '.actor/commands/gamma.ts');

    // 重复定义 → 报错（**先测这条**：下面会重写 barrel 文件，顺序颠倒会让这条断言失效）
    writeBarrelCommand(
      project,
      [
        `import { defineCommand } from '${CUSTOM_MODULE}';`,
        'export const commands = [',
        "  defineCommand({ name: 'dup', run: () => 0 }),",
        "  defineCommand({ name: 'dup', run: () => 0 }),",
        '];',
        '',
      ].join('\n'),
    );
    await assert.rejects(() => discoverCommands(project), /重复定义/);

    // 与内置命令重名 → 报错（不静默覆盖）
    writeBarrelCommand(project, `import { defineCommand } from '${CUSTOM_MODULE}';\nexport default defineCommand({ name: 'doctor', run: () => 0 });\n`);
    await assert.rejects(() => discoverCommands(project), /与内置命令重名/);

    assert.ok(BUILTIN_COMMANDS.includes('generate'));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('P4: npm 包来源 —— 只认项目声明过的包（未声明的包即使躺在 node_modules 里也不加载）', async () => {
  const project = tempDir('custom-npm');
  try {
    await scaffold(project);
    // 造两个"包"：一个在 dependencies 里声明，一个只是躺在 node_modules 里（未声明）
    const declared = path.join(project, 'node_modules', 'actor-command-seed');
    const undeclared = path.join(project, 'node_modules', 'actor-command-evil');
    for (const [dir, summary] of [
      [declared, '包里的命令'],
      [undeclared, '没声明的包'],
    ] as const) {
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        `${JSON.stringify({ name: path.basename(dir), version: '1.0.0', type: 'module', actor: { commandsModule: './lib/commands.js' } }, null, 2)}\n`,
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, 'lib', 'commands.js'),
        [
          'export const commands = [',
          `  { name: '${path.basename(dir).replace('actor-command-', 'from')}', summary: '${summary}', run: () => 0 },`,
          '];',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    const manifestPath = path.join(project, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
    manifest.dependencies = { ...manifest.dependencies, 'actor-command-seed': '1.0.0' };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const found = await discoverCommands(project);
    const names = found.map((item) => item.spec.name);
    assert.deepStrictEqual(names, ['fromseed'], `只该发现声明过的那个包：${JSON.stringify(names)}`);
    assert.strictEqual(found[0]?.source, 'npm:actor-command-seed');
    assert.ok(!names.includes('fromevil'), '未声明的包绝不能加载（那是"谁有权在你 CLI 里跑代码"的边界）');

    // 显式白名单：名字不带前缀也行
    manifest.actor = { commands: ['actor-command-evil'] };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const explicit = await discoverCommands(project);
    assert.ok(explicit.some((item) => item.source === 'npm:actor-command-evil'), '显式列出的包要加载');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('P4: 端到端 —— `actor generate command` → `actor commands` → `actor <name>`（子进程隔离）', async () => {
  const project = tempDir('custom-e2e');
  try {
    await scaffold(project);

    // ① 生成骨架
    const generated = await run(process.execPath, [CLI, 'generate', 'command', 'seed'], { cwd: project, env: childEnv() });
    assert.match(generated.stdout, /已生成 command 骨架 seed/);
    assert.ok(fs.existsSync(path.join(project, '.actor', 'commands', 'seed.ts')));

    // ② 列出（内置 + 自定义，且带来源）
    const listed = await run(process.execPath, [CLI, 'commands'], { cwd: project, env: childEnv() });
    assert.match(listed.stdout, /内置命令：/);
    assert.match(listed.stdout, /seed/);
    assert.match(listed.stdout, /\.actor\/commands\/seed\.ts/);

    const asJson = await run(process.execPath, [CLI, 'commands', '--json'], { cwd: project, env: childEnv() });
    const parsed = JSON.parse(asJson.stdout) as { custom: Array<{ name: string; flags: string[] }> };
    assert.deepStrictEqual(parsed.custom.map((item) => item.name), ['seed']);
    assert.ok(parsed.custom[0]?.flags.includes('count'));

    // ③ 执行（选项由**子进程**按自己的声明解析 —— 主 CLI 不认识 --count 也不该拦）
    const executed = await run(process.execPath, [CLI, 'seed', '--count', '3'], { cwd: project, env: childEnv() });
    assert.match(executed.stdout, /dryRun=false count=3/);
    assert.match(executed.stdout, /项目目录：/);

    // 默认值生效
    const defaulted = await run(process.execPath, [CLI, 'seed'], { cwd: project, env: childEnv() });
    assert.match(defaulted.stdout, /count=10/);

    // ④ 自定义命令的 --help（由它的 flags 声明自动生成）
    const help = await run(process.execPath, [CLI, 'seed', '--help'], { cwd: project, env: childEnv() });
    assert.match(help.stdout, /actor seed/);
    assert.match(help.stdout, /--count <number>/);

    // ⑤ 未知选项：子进程报错（指向具体命令），退出码 1
    const bad = await run(process.execPath, [CLI, 'seed', '--nope'], { cwd: project, env: childEnv() }).catch((error: { code?: number; stderr?: string }) => error);
    assert.strictEqual(bad.code, 1, `退出码应当是 1：${JSON.stringify(bad)}`);
    assert.match(String(bad.stderr ?? ''), /未知选项 '--nope'（命令 'seed'）/);

    // ⑥ 未定义的命令仍然报"未知命令"，并提示去看 actor commands
    const unknown = await run(process.execPath, [CLI, 'nope'], { cwd: project, env: childEnv() }).catch((error: { stderr?: string }) => error);
    assert.match(String(unknown.stderr ?? ''), /未知命令 'nope'/);
    assert.match(String(unknown.stderr ?? ''), /actor commands/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('P4: 子进程隔离 —— 自定义命令抛错/退出码不会带崩主 CLI', async () => {
  const project = tempDir('custom-isolation');
  try {
    await scaffold(project);
    // 一个故意抛错、一个故意给非零退出码
    writeBarrelCommand(
      project,
      [
        `import { defineCommand } from '${CUSTOM_MODULE}';`,
        'export const commands = [',
        "  defineCommand({ name: 'boom', run() { throw new Error('自定义命令炸了'); } }),",
        "  defineCommand({ name: 'exit3', run() { return 3; } }),",
        '];',
        '',
      ].join('\n'),
    );

    const boom = await run(process.execPath, [CLI, 'boom'], { cwd: project, env: childEnv() }).catch((error: { code?: number; stderr?: string }) => error);
    assert.strictEqual(boom.code, 1, '抛错应当退出码 1');
    assert.match(String(boom.stderr ?? ''), /自定义命令炸了/);
    assert.match(String(boom.stderr ?? ''), /at /, '用户代码的堆栈要保留（他在开发，需要定位）');

    const exit3 = await run(process.execPath, [CLI, 'exit3'], { cwd: project, env: childEnv() }).catch((error: { code?: number }) => error);
    assert.strictEqual(exit3.code, 3, '自定义退出码要原样透传');

    // 主 CLI 仍然可用（隔离生效）
    const stillWorks = await run(process.execPath, [CLI, 'commands'], { cwd: project, env: childEnv() });
    assert.match(stillWorks.stdout, /boom/);
    assert.match(stillWorks.stdout, /exit3/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('P4: doctor 增加"自定义命令"一节，且命令定义有问题时如实报出', async () => {
  const project = tempDir('custom-doctor');
  try {
    await scaffold(project);
    const clean = await doctor(project);
    const cleanCheck = clean.checks.find((check) => check.name === '自定义命令');
    assert.ok(cleanCheck !== undefined, `doctor 要有"自定义命令"这一节：${clean.checks.map((c) => c.name).join(', ')}`);
    assert.strictEqual(cleanCheck?.ok, true);
    assert.match(cleanCheck?.detail ?? '', /没有（要加：actor generate command/);

    writeBarrelCommand(project, `import { defineCommand } from '${CUSTOM_MODULE}';\nexport default defineCommand({ name: 'seed', summary: '灌数据', run: () => 0 });\n`);
    const withCommand = await doctor(project);
    const found = withCommand.checks.find((check) => check.name === '自定义命令');
    assert.match(found?.detail ?? '', /发现 1 个：seed（\.actor\/commands\.ts）/);

    // 与内置重名 → doctor 报问题（不静默）
    writeBarrelCommand(project, `import { defineCommand } from '${CUSTOM_MODULE}';\nexport default defineCommand({ name: 'doctor', run: () => 0 });\n`);
    const broken = await doctor(project);
    const brokenCheck = broken.checks.find((check) => check.name === '自定义命令');
    assert.strictEqual(brokenCheck?.ok, false);
    assert.match(brokenCheck?.detail ?? '', /与内置命令重名/);
    assert.ok(broken.problems >= 1);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('P4: renderCommands 两种输出（文本/json）都稳定', () => {
  const discovered = [
    { spec: defineCommand({ name: 'a', summary: 'A', run: () => 0 }), source: '.actor/commands/a.ts' },
  ];
  const text = renderCommands(discovered);
  assert.match(text, /内置命令：/);
  assert.match(text, /a {2,}A/);
  assert.match(text, /来源：\.actor\/commands\/a\.ts/);
  const json = JSON.parse(renderCommands(discovered, { json: true })) as { builtin: string[]; custom: Array<{ source: string }> };
  assert.ok(Array.isArray(json.builtin));
  assert.strictEqual(json.custom[0]?.source, '.actor/commands/a.ts');
  assert.match(renderCommands([], {}), /没有自定义命令/);
});
