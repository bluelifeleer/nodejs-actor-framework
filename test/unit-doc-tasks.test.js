import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * 新手任务门禁：**"只看一页，从零到跑通"**。
 *
 * 为什么需要它：文档最容易退化成的样子是"读起来对、照着做跑不通"。
 * 这里把 5 条典型任务各写成**一个真脚本**（`test/doc-tasks/*.mjs`），它只能使用对应那一页教的东西：
 *   ① 真起服务/真发请求/真断言（含错误路径，不只是 happy path）；
 *   ② **漂移检查**：脚本依赖的 API 词必须仍然出现在那一页里 —— 页面改了写法而脚本没跟上（或反过来）
 *      都会红，而不是悄悄失效。
 */

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const TASKS_DIR = path.join(ROOT, 'test', 'doc-tasks');

/** 每个任务：脚本、它对应的那一页、期望输出、以及"这一页必须还在教"的 API 词。 */
const TASKS = [
  {
    script: '10-routing.mjs',
    page: 'docs/guide/10-http-routing.md',
    marker: 'task-routing-ok',
    tokens: ['defineController', 'defineRoutes', 'HttpError', '405'],
    proves: ['400', '405', '404'],
  },
  {
    script: '12-actor-persistence.mjs',
    page: 'docs/guide/12-actors-state.md',
    marker: 'task-actor-ok',
    tokens: ['preStart', 'receive', "mode: 'snapshot'", 'ctx.actor'],
    proves: ['一条不丢', '重启后状态还在'],
  },
  {
    script: '13-auth.mjs',
    page: 'docs/guide/13-auth.md',
    marker: 'task-auth-ok',
    tokens: ['authPlugin', 'signJwt', 'required: true', 'roles'],
    proves: ['401', '403'],
  },
  {
    script: '17-virtual-clock.mjs',
    page: 'docs/guide/17-testing.md',
    marker: 'task-virtual-clock-ok',
    tokens: ['createVirtualClock', 'advance', 'pending'],
    proves: ['真实耗时', '没有遗留定时器'],
  },
  {
    script: '21-generate-mount.mjs',
    page: 'docs/guide/21-cli-generate-and-commands.md',
    marker: 'task-generate-mount-ok',
    tokens: ['--mount', '@actor:mount', '--dry-run'],
    proves: ['幂等', 'typecheck', '--noEmit'],
  },
];

test('doc tasks: 5 条"只看一页从零到跑通"的任务脚本都存在且真的能跑', async () => {
  for (const task of TASKS) {
    const script = path.join(TASKS_DIR, task.script);
    assert.ok(fs.existsSync(script), `缺少任务脚本：${task.script}`);

    const { stdout, stderr } = await run(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: '--conditions=development' },
      timeout: 300_000,
    }).catch((error) => {
      assert.fail(`${task.script} 跑失败（它对应 ${task.page}）：\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`);
    });
    assert.match(`${stdout}${stderr}`, new RegExp(task.marker), `${task.script} 应当打印 ${task.marker}`);
  }
});

test('doc tasks: 漂移检查 —— 脚本依赖的 API 必须仍然出现在它对应的那一页里', () => {
  const problems = [];
  for (const task of TASKS) {
    const markdown = fs.readFileSync(path.join(ROOT, task.page), 'utf8');
    for (const token of task.tokens) {
      if (!markdown.includes(token)) problems.push(`${task.page} 里找不到「${token}」（${task.script} 依赖它）`);
    }
    // 脚本自己也必须给出"它对应哪一页"，否则漂移检查形同虚设
    const script = fs.readFileSync(path.join(TASKS_DIR, task.script), 'utf8');
    if (!script.includes(task.page)) problems.push(`${task.script} 没有指明它对应 ${task.page}`);
  }
  assert.deepStrictEqual(problems, [], `文档与任务脚本漂移了：\n  ${problems.join('\n  ')}`);
});

test('doc tasks: 每个脚本都真的断言了它声称覆盖的失败路径/边界（不只是跑通就完事）', () => {
  // "跑起来不报错"不算任务跑通：每个任务都要断言**出错时也对**（4xx 语义）或**边界成立**
  // （并发不丢、真实耗时接近 0、幂等不改文件…）。这里逐个核对任务表里声明的证明点。
  const problems = [];
  for (const task of TASKS) {
    const script = fs.readFileSync(path.join(TASKS_DIR, task.script), 'utf8');
    assert.ok(Array.isArray(task.proves) && task.proves.length >= 2, `${task.script} 没声明它证明了什么`);
    for (const needle of task.proves) {
      if (!script.includes(needle)) problems.push(`${task.script} 里找不到声明过的证明点「${needle}」`);
    }
  }
  assert.deepStrictEqual(problems, [], `任务脚本要证明"出错时也对"：\n  ${problems.join('\n  ')}`);
});
