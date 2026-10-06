import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * **给门禁本身加门禁。**
 *
 * 工作流最容易烂的方式不是"写错语法"（那会在 GitHub 上立刻报错），而是**悄悄失去意义**：
 * 脚本改名了工作流还叫老名字、action 被改成 `@main`（等于不固定版本）、Pages 上传的目录
 * 与构建产物不一致、权限少一项于是部署静默失败……这些在合并时都不会有人注意到。
 *
 * 说明：这里只做**结构性断言**（按行解析），不做完整 YAML 校验——仓库零依赖，
 * 引入 YAML 解析器只为测试工作流不划算。语法错误由 GitHub 自己兜底。
 */

function workflowFiles() {
  return fs
    .readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(WORKFLOWS, name), 'utf8') }));
}

function workflowText(name) {
  return fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
}

test('ci: 每个工作流都引用了 package.json 里真实存在的脚本（改名不会留下死引用）', () => {
  const files = workflowFiles();
  assert.ok(files.length >= 2, `至少要有一条 CI 与一条 Pages 工作流，实际 ${files.length}`);

  for (const { name, text } of files) {
    const invoked = new Set();
    for (const match of text.matchAll(/npm run ([a-z][\w:-]*)/g)) invoked.add(match[1]);
    if (/\bnpm test\b/.test(text)) invoked.add('test');
    assert.ok(invoked.size > 0, `${name} 里没有跑任何 npm 脚本，这条工作流大概没意义`);
    for (const script of invoked) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(pkg.scripts, script),
        `${name} 调用了不存在的脚本 'npm run ${script}'（package.json 里没有）`,
      );
    }
  }
});

test('ci: CI 跑的就是开发者本地那条命令（npm run ci），不另起一套', () => {
  const ci = workflowText('ci.yml');
  assert.ok(pkg.scripts.ci, 'package.json 必须提供 npm run ci');
  assert.match(ci, /run: npm run ci\b/, 'CI 应当调用 npm run ci，而不是把步骤再抄一遍');
  // 抄一遍就会漂移：断言 CI 没有单独重复 typecheck/test 步骤
  assert.ok(!/run: npm run typecheck\b/.test(ci), 'CI 不要再单独跑 typecheck（已在 npm run ci 里）');
  assert.ok(!/run: npm test\b/.test(ci), 'CI 不要再单独跑 test（已在 npm run ci 里）');
  // 文档站的断链门禁也要在 CI 里（它是 npm run ci 的一部分）
  assert.match(pkg.scripts.ci, /docs:build/, 'npm run ci 必须包含文档站构建（断链门禁）');
});

test('ci: 所有 action 都固定在主版本号上，不用 @main/@master 这类浮动引用', () => {
  for (const { name, text } of workflowFiles()) {
    const uses = [...text.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${name} 没用到任何 action？`);
    for (const use of uses) {
      assert.match(
        use,
        /^[\w.-]+\/[\w.-]+@v\d+(\.\d+){0,2}$/,
        `${name} 的 action '${use}' 没有固定在主版本（禁止 @main/@master/无版本）`,
      );
    }
  }
});

test('ci: Node 版本与 engines 一致（不一致的话 CI 通过就毫无意义）', () => {
  const engines = pkg.engines?.node;
  assert.ok(engines, 'package.json 必须有 engines.node');
  const floor = Number(String(engines).replace(/[^\d]/g, '').slice(0, 2));
  assert.ok(Number.isFinite(floor) && floor >= 20, `engines.node 看起来不对劲：${engines}`);

  for (const { name, text } of workflowFiles()) {
    const versions = [...text.matchAll(/node-version:\s*'?([\d.]+)'?/g)].map((match) => match[1]);
    assert.ok(versions.length > 0, `${name} 没指定 node-version`);
    for (const version of versions) {
      const major = Number(version.split('.')[0]);
      assert.ok(
        major >= floor,
        `${name} 用的 Node ${version} 低于 engines 要求的 ${engines}（源码直接跑 .ts 且用 node:sqlite）`,
      );
    }
  }
});

test('ci: Pages 工作流上传的目录就是构建产物，且该目录不入库', () => {
  const pages = workflowText('pages.yml');
  assert.match(pages, /run: npm run docs:build/, 'Pages 必须先构建文档站');
  assert.match(pages, /path:\s*site\b/, 'upload-pages-artifact 上传的应当是 site/');

  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\/site\/$/m, 'site/ 是构建产物，必须 gitignore（否则仓库里会出现过期站点）');

  // 权限少一项就会静默部署失败，这里钉住三项
  for (const permission of ['contents: read', 'pages: write', 'id-token: write']) {
    assert.ok(pages.includes(permission), `Pages 工作流缺少权限 '${permission}'`);
  }
  assert.match(pages, /actions\/deploy-pages@v\d+/, '要有部署步骤');
  assert.match(pages, /\.nojekyll/, 'GitHub Pages 默认走 Jekyll，静态产物要加 .nojekyll');
  // 部署只该在 main 上发生
  assert.match(pages, /branches:\s*\[main\]/, 'Pages 部署应当限定在 main');
});

test('ci: 工作流文件本身没有明显的手误（缩进/空 steps/TODO 残留）', () => {
  for (const { name, text } of workflowFiles()) {
    assert.ok(!/\t/.test(text), `${name} 里出现了 tab（YAML 不允许 tab 缩进）`);
    assert.ok(!/TODO|FIXME|XXX/.test(text), `${name} 里留有 TODO/FIXME`);
    assert.ok(/^on:/m.test(text), `${name} 缺少 on: 触发器`);
    assert.ok(/^jobs:/m.test(text), `${name} 缺少 jobs:`);
    assert.ok(/runs-on:\s*ubuntu-latest/.test(text), `${name} 没指定 runs-on`);
    assert.ok(/timeout-minutes:\s*\d+/.test(text), `${name} 没有 timeout（卡死的工作流会一直占用额度）`);
  }
});
