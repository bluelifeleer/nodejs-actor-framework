/**
 * 任务脚本 ⑤：只看 [21 CLI 进阶](../../docs/guide/21-cli-generate-and-commands.md) 就能跑通的
 * "生成骨架 → 自动接线 → 项目仍然 typecheck"。
 *
 * 断言：`generate controller/actor --mount` 插进标记处、模块文件没被覆盖、生成后 `tsc --noEmit` 通过、
 * 再跑一次是幂等的（不产生重复行）。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const cli = path.join(root, 'packages', 'cli', 'src', 'cli.ts');
const project = fs.mkdtempSync(path.join(root, '.tmp-cli', 'doc-task-cli-'));
const env = { ...process.env, NODE_OPTIONS: '--conditions=development' };

try {
  await run(process.execPath, [cli, 'new', 'app', project], { cwd: root, env });

  const moduleFile = path.join(project, 'src', 'module.ts');
  const before = fs.readFileSync(moduleFile, 'utf8');
  const controller = await run(process.execPath, [cli, 'generate', 'controller', 'demo', '--mount'], { cwd: project, env });
  assert.match(controller.stdout, /已把这些行插进 src\/module\.ts/);

  const after = fs.readFileSync(moduleFile, 'utf8');
  assert.ok(after.includes("import { demo } from './controller/demo.controller.ts';"), 'import 要插进标记处');
  assert.ok(after.includes("get('/demo?name=', demo),"), '路由条目要插进去');
  assert.ok(after.length > before.length, '文件应当变长（只有插入，没有覆盖）');
  assert.ok(after.includes('@actor:mount'), '标记要保留（下次还能继续插）');

  // 幂等：再跑一次不产生重复行
  await run(process.execPath, [cli, 'generate', 'controller', 'demo', '--mount'], { cwd: project, env });
  const again = fs.readFileSync(moduleFile, 'utf8');
  assert.strictEqual(again, after, '第二次不该改动文件（幂等）');
  assert.strictEqual(after.split("import { demo } from './controller/demo.controller.ts';").length - 1, 1, '不该重复 import');

  // Actor 也插一遍，然后 typecheck
  await run(process.execPath, [cli, 'generate', 'actor', 'cart', '--mount'], { cwd: project, env });
  assert.match(fs.readFileSync(moduleFile, 'utf8'), /Cart: \{ definition: cartActor \},/);
  await run('npx', ['--no-install', 'tsc', '-p', '.', '--noEmit'], { cwd: project, env, timeout: 240_000 });

  console.log('task-generate-mount-ok');
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
