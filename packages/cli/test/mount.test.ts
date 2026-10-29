import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MOUNT_MARKER, missingMarkerHelp, mountLines, mountTargetFor, planMount } from '../src/commands/mount.ts';
import { baseNameFor } from '../src/commands/generate.ts';

/**
 * `--mount` 的门禁。
 *
 * 这个功能会**改写用户的文件**，所以每一条安全边界都要有用例守着：
 *   ① 只往 `// @actor:mount <槽位>` 标记里插，没有标记就一个字节都不写（并给出"加哪一行"）；
 *   ② 幂等：重复跑不产生重复行；
 *   ③ `--dry-run` 零写入；
 *   ④ 原子替换（不留 `.tmp` 残留）；
 *   ⑤ 插完的项目仍然 typecheck、自带测试仍然全过。
 */

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'src', 'cli.ts');

function tempProject(name: string): string {
  const dir = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const read = (project: string, relative: string): string => fs.readFileSync(path.join(project, relative), 'utf8');

test('mount: 计划是纯函数 —— 只插整行、按槽位、幂等，缺标记时如实报告', () => {
  const content = [
    "import { defineModule } from '@actor/app';",
    `// ${MOUNT_MARKER} imports`,
    '',
    'export default defineModule({',
    '  actors: {',
    `    // ${MOUNT_MARKER} actors`,
    '  },',
    '});',
    '',
  ].join('\n');

  const first = planMount(content, {
    imports: ["import { cartActor } from './actor/cart.actor.ts';"],
    actors: ['Cart: { definition: cartActor },'],
  });
  assert.strictEqual(first.missingMarkers.length, 0);
  assert.deepStrictEqual(first.inserted, ["import { cartActor } from './actor/cart.actor.ts';", '    Cart: { definition: cartActor },']);
  const rows = first.content.split('\n');
  assert.strictEqual(rows[2], "import { cartActor } from './actor/cart.actor.ts';", 'import 必须顶格插在标记之后');
  assert.match(rows[7] ?? '', /^ {4}Cart: /, '对象里的条目要跟随标记的缩进（插入 import 后标记在 rows[6]）');

  // 幂等：同一份内容再插一次 → 什么都不插
  const second = planMount(first.content, {
    imports: ["import { cartActor } from './actor/cart.actor.ts';"],
    actors: ['Cart: { definition: cartActor },'],
  });
  assert.deepStrictEqual(second.inserted, []);
  assert.strictEqual(second.alreadyPresent.length, 2);
  assert.strictEqual(second.content, first.content, '幂等：内容必须一模一样');

  // 缺标记：不插、报告槽位与标记原文
  const missing = planMount("export default defineModule({});\n", { routes: ["get('/x', x),"] });
  assert.deepStrictEqual(missing.inserted, []);
  assert.deepStrictEqual(missing.missingMarkers, [{ slot: 'routes', marker: `// ${MOUNT_MARKER} routes` }]);
  assert.strictEqual(missing.content, "export default defineModule({});\n", '缺标记时内容不能变');

  // 提示文案要说清"加哪一行"
  const help = missingMarkerHelp('src/module.ts', missing.missingMarkers);
  assert.match(help, /一个字节都没改/);
  assert.match(help, /`routes: defineRoutes\(\[` 之后 加一行：\/\/ @actor:mount routes/);
});

test('mount: 槽位映射 —— 需要的 kind 有目标文件，不需要的明确返回 null', () => {
  assert.deepStrictEqual(mountTargetFor('controller', 'layered')?.file, 'src/module.ts');
  // 两种布局的模块声明都在 src/module.ts（flat 的 src/app.ts 只是 defineApp 入口）
  assert.deepStrictEqual(mountTargetFor('controller', 'flat')?.file, 'src/module.ts');
  assert.deepStrictEqual(mountTargetFor('actor', 'layered')?.slots, ['imports', 'actors']);
  assert.deepStrictEqual(mountTargetFor('service', 'layered')?.slots, ['imports', 'providers']);
  assert.deepStrictEqual(mountTargetFor('middleware', 'layered')?.slots, ['imports', 'middleware']);
  assert.deepStrictEqual(mountTargetFor('migration', 'layered')?.slots, ['imports', 'migrations']);
  for (const kind of ['model', 'schema', 'test', 'command'] as const) {
    assert.strictEqual(mountTargetFor(kind, 'layered'), null, `${kind} 不该有挂载目标`);
  }
});

test('mount: 标识符不带重复后缀（demo-actor → demoActor，不是 demoActorActor）', () => {
  assert.strictEqual(baseNameFor('demo-actor', 'actor'), 'demo');
  assert.strictEqual(baseNameFor('cart', 'actor'), 'cart');
  assert.strictEqual(baseNameFor('note_controller', 'controller'), 'note');
  assert.strictEqual(baseNameFor('billing-service', 'service'), 'billing');
  assert.strictEqual(baseNameFor('note', 'model'), 'note');
  // 挂载行用的是同一套基名，所以插进去的名字与文件里的导出一致
  const lines = mountLines({ kind: 'actor', name: 'demo-actor', layout: 'layered' });
  assert.deepStrictEqual(lines.imports, ["import { demoActor } from './actor/demo-actor.actor.ts';"]);
  assert.deepStrictEqual(lines.actors, ['Demo: { definition: demoActor },']);
});

test('mount: --mount 真插进标记、幂等、--dry-run 零写入、不留临时文件', async () => {
  const project = tempProject('mount-basic');
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);

    // ① 真插
    const first = await run(process.execPath, [CLI, 'generate', 'controller', 'demo', '--mount'], { cwd: project, env: childEnv() });
    assert.match(first.stdout, /已把这些行插进 src\/module\.ts/);
    const module = read(project, 'src/module.ts');
    assert.ok(module.includes("import { demo } from './controller/demo.controller.ts';"), 'import 要插进去');
    assert.ok(module.includes("get('/demo?name=', demo),"), '路由条目要插进去');
    // 标记本身保留（下次还能继续插）
    assert.ok(module.includes(`// ${MOUNT_MARKER} routes`), '标记不能被吃掉');

    // ② 幂等
    const again = await run(process.execPath, [CLI, 'generate', 'controller', 'demo', '--mount'], { cwd: project, env: childEnv() });
    assert.match(again.stdout, /幂等，没有重复插入/);
    assert.strictEqual(read(project, 'src/module.ts'), module, '第二次不该改动文件');
    assert.strictEqual(module.split("import { demo } from './controller/demo.controller.ts';").length - 1, 1, '不能重复 import');

    // ③ --dry-run：一个字节都不写
    const before = read(project, 'src/module.ts');
    const dry = await run(process.execPath, [CLI, 'generate', 'actor', 'cart', '--mount', '--dry-run'], { cwd: project, env: childEnv() });
    assert.match(dry.stdout, /\[dry-run\] 会把/);
    assert.match(dry.stdout, /没有真的写盘/);
    assert.strictEqual(read(project, 'src/module.ts'), before, 'dry-run 不能改 module.ts');
    assert.ok(!fs.existsSync(path.join(project, 'src', 'actor', 'cart.actor.ts')), 'dry-run 也不该落盘生成文件');

    // ④ 不留临时文件
    const leftovers = fs.readdirSync(path.join(project, 'src')).filter((name) => name.includes('.mount-'));
    assert.deepStrictEqual(leftovers, [], `不该留下临时文件：${leftovers.join(', ')}`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('mount: 没有标记时**一个字节都不改**，并告诉用户加哪一行', async () => {
  const project = tempProject('mount-nomarker');
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);
    // 模拟"用户自己重写过 module.ts"：把标记全删掉
    const file = path.join(project, 'src', 'module.ts');
    const stripped = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !line.includes(MOUNT_MARKER)).join('\n');
    fs.writeFileSync(file, stripped, 'utf8');

    const result = await run(process.execPath, [CLI, 'generate', 'controller', 'lonely', '--mount'], { cwd: project, env: childEnv() });
    assert.match(result.stdout, /没有找到这些挂载标记/);
    assert.match(result.stdout, /一个字节都没改/);
    assert.match(result.stdout, /加一行：\/\/ @actor:mount imports/);
    assert.match(result.stdout, /加一行：\/\/ @actor:mount routes/);
    // 仍然把片段打出来（手工合并永远可用）
    assert.match(result.stdout, /下一步：把下面这段合并进 src\/module\.ts/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), stripped, 'module.ts 必须原封不动');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('mount: 不需要接线的 kind 会说明原因，迁移会新建并插入 src/migrations.ts', async () => {
  const project = tempProject('mount-special');
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);

    for (const kind of ['model', 'schema', 'test']) {
      const result = await run(process.execPath, [CLI, 'generate', kind, `thing-${kind}`, '--mount'], { cwd: project, env: childEnv() });
      assert.match(result.stdout, /不需要接线/, `${kind} 应当说明不需要接线：\n${result.stdout}`);
    }

    // 迁移：src/migrations.ts 不存在 → 按模板新建 + 插入
    const migration = await run(process.execPath, [CLI, 'generate', 'migration', 'create-notes', '--mount'], { cwd: project, env: childEnv() });
    assert.match(migration.stdout, /已新建 src\/migrations\.ts/);
    const barrel = read(project, 'src/migrations.ts');
    assert.ok(barrel.includes("import type { Migration } from '@actor/data';"), '新建的文件要能独立导入');
    assert.match(barrel, /import createNotes from '\.\/migrations\/\d{4}-\d{2}-\d{2}[^']*-create-notes\.ts';/);
    assert.match(barrel, /createNotes,/);
    assert.match(barrel, /export default migrations;/);

    // 再生成一个：插到同一个数组里（幂等标记仍在）
    await run(process.execPath, [CLI, 'generate', 'migration', 'add-tags', '--mount'], { cwd: project, env: childEnv() });
    const barrel2 = read(project, 'src/migrations.ts');
    assert.match(barrel2, /addTags,/);
    assert.strictEqual(barrel2.split('createNotes,').length - 1, 1, '第一个迁移不该被重复插入');
    assert.strictEqual(barrel2.split(`// ${MOUNT_MARKER} migrations`).length - 1, 1, '标记只该有一个');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('mount: 挂载之后项目仍然 typecheck、自带测试仍然全过（真集成）', async () => {
  const project = tempProject('mount-integration');
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);
    for (const spec of [
      ['controller', 'demo'],
      ['actor', 'cart'],
      ['service', 'billing'],
      ['middleware', 'audit'],
    ] as const) {
      await run(process.execPath, [CLI, 'generate', spec[0], spec[1], '--mount'], { cwd: project, env: childEnv() });
    }

    const module = read(project, 'src/module.ts');
    for (const expected of [
      "import { demo } from './controller/demo.controller.ts';",
      "import { cartActor } from './actor/cart.actor.ts';",
      "import { createBillingService } from './service/billing.service.ts';",
      "import { auditMiddleware } from './middleware/audit.ts';",
      'Cart: { definition: cartActor },',
      'auditMiddleware,',
    ]) {
      assert.ok(module.includes(expected), `module.ts 里应当有：${expected}`);
    }

    // 真集成：改过 module.ts 之后，项目自身的 typecheck 与端到端测试都要照过
    await run('npx', ['--no-install', 'tsc', '-p', '.', '--noEmit'], { cwd: project, env: childEnv(), timeout: 240_000 });
    const tests = await run('npm', ['test'], { cwd: project, env: childEnv(), timeout: 240_000 });
    const output = `${tests.stdout}${tests.stderr}`;
    assert.ok(!/fail [1-9]/.test(output), `挂载后不该有测试失败：\n${output}`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('mount: flat 布局挂到 src/module.ts，且 import 路径不带子目录', async () => {
  const project = tempProject('mount-flat');
  try {
    await run(process.execPath, [CLI, 'new', 'app', project, '--layout', 'flat']);
    const result = await run(process.execPath, [CLI, 'generate', 'controller', 'ping', '--mount'], { cwd: project, env: childEnv() });
    assert.match(result.stdout, /已把这些行插进 src\/module\.ts/, `flat 也要插进 module.ts：\n${result.stdout}`);
    const module = read(project, 'src/module.ts');
    assert.ok(module.includes("import { ping } from './ping.controller.ts';"), 'flat 的 import 路径不该带子目录');
    assert.ok(module.includes("get('/ping?name=', ping),"));
    assert.ok(read(project, 'src/app.ts').includes('modules: [appModule]'), 'app.ts 仍是 defineApp 入口，不该被改');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('mount: 目标文件不存在时提示"找不到模块声明"（而不是"没有标记"）', async () => {
  const project = tempProject('mount-nomodule');
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);
    fs.rmSync(path.join(project, 'src', 'module.ts'));
    const result = await run(process.execPath, [CLI, 'generate', 'controller', 'x', '--mount'], { cwd: project, env: childEnv() });
    assert.match(result.stdout, /找不到 src\/module\.ts/);
    assert.ok(!result.stdout.includes('没有找到这些挂载标记'), '不该把"文件不存在"说成"没有标记"');
    assert.match(result.stdout, /下一步：把下面这段合并进/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
