import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { build, buildLanding, findBrokenLandingLinks, highlightCode } from '../tools/docs-site.mjs';

/**
 * 官网（`tools/landing/` → `site/index.html`）的门禁。
 *
 * 这个页面是"对外承诺"，所以它比普通文档多两道检查：
 *   ① **页面上的代码 == 被跑过的代码**：示例来自 `tools/landing/snippets/`，既进 typecheck，
 *      又在这里被真的执行一遍；页面里必须逐字包含同一份源码（高亮只加标签、不改文本）；
 *   ② **事实门禁**：页面上写的"零运行时依赖 / Node ≥ 24 / 12 个包"必须与仓库真实状态一致 ——
 *      宣传页也会过时，所以让它在过时时**红**，而不是继续骗人。
 */

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const LANDING = path.join(ROOT, 'tools', 'landing');
const SITE = path.join(ROOT, 'site');
const SNIPPETS = ['01-kernel-actor.js', '02-web-app.ts', '03-persistence.ts'];

/** 把页面里的 `<pre class="code">` 还原成纯文本（去标签 + 反转义）。 */
function codeBlocks(html) {
  const blocks = [];
  for (const match of String(html).matchAll(/<pre class="code"[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)) {
    const text = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    blocks.push(text);
  }
  return blocks;
}

test('官网: 高亮只加标签不改文本，且先转义（示例里的 HTML 不会破坏页面）', () => {
  const source = 'const a = "<script>alert(1)</script>"; // 注释\nconst n = 42;';
  const html = highlightCode(source);
  assert.ok(!html.includes('<script>'), '示例里的尖括号必须被转义');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<span class="kw">const</span>'), '关键字要包起来');
  assert.ok(html.includes('<span class="num">42</span>'), '数字要包起来');
  assert.ok(html.includes('<span class="cmt">// 注释</span>'), '注释要包起来');
  // 去掉标签后必须与原文本**逐字相同**
  assert.strictEqual(
    html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
    source,
    '高亮不能吞掉或改写任何字符',
  );
});

test('官网: 每段示例都被真的执行过（断言写在示例里，退出码 0 才算过）', async () => {
  const expectations = {
    '01-kernel-actor.js': 'hp=90 pet=player_001/pet-1 actors=2',
    '02-web-app.ts': 'health=200 total=2→5 bad-input=400',
    '03-persistence.ts': 'before=41 after-restart=41',
  };
  for (const name of SNIPPETS) {
    const file = path.join(LANDING, 'snippets', name);
    assert.ok(fs.existsSync(file), `缺少示例文件：${name}`);
    const args = name.endsWith('.ts') ? ['--experimental-strip-types', file] : [file];
    const { stdout, stderr } = await run(process.execPath, args, { cwd: ROOT, timeout: 120_000 });
    const output = `${stdout}${stderr}`;
    assert.ok(
      output.includes(expectations[name]),
      `${name} 的运行结果应当包含 "${expectations[name]}"：\n${output}`,
    );
  }
});

test('官网: 页面里的代码与仓库里的示例文件逐字一致（不会漂移）', async () => {
  const built = await buildLanding();
  const blocks = codeBlocks(built.html);
  for (const name of SNIPPETS) {
    const source = fs.readFileSync(path.join(LANDING, 'snippets', name), 'utf8');
    assert.ok(
      blocks.includes(source),
      `页面里没有逐字包含 ${name} 的源码（示例改了但页面没重建？）`,
    );
  }
  // 占位符必须全部被替换掉
  assert.ok(!/<!--landing:/.test(built.html), '不该残留占位符');
  assert.deepStrictEqual([...built.snippets].sort(), [...SNIPPETS].sort());
});

test('官网: 零外部资源 —— 不加载任何 CDN/字体/追踪脚本（离线可用）', async () => {
  const built = await buildLanding();
  const external = [...built.html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((match) => match[1]);
  assert.deepStrictEqual(external, [], `官网不该引用外部资源：${external.join(', ')}`);
  assert.ok(built.html.includes('<style>'), '样式要内联（离线打开也要好看）');
  assert.ok(built.html.includes('<script>'), '脚本要内联');
});

test('官网: 事实门禁 —— 页面上写的能力/数字必须与仓库真实状态一致', async () => {
  const built = await buildLanding();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // ① "0 运行时依赖"：根 package.json 不能有 dependencies/optionalDependencies
  assert.strictEqual(manifest.dependencies, undefined, '根包不该有运行时依赖（页面是这么写的）');
  assert.strictEqual(manifest.optionalDependencies, undefined);
  assert.ok(built.html.includes('零运行时依赖'), '页面的主张本身要在页面上');

  // ② "Node ≥ 24"
  assert.strictEqual(manifest.engines?.node, '>=24');
  assert.ok(/Node\.js ≥ 24|Node ≥ 24/.test(built.html), '页面必须写明 Node ≥ 24（它真的起不来更低版本）');

  // ③ "12 个包"：与 workspaces 实际数量一致
  const packages = fs
    .readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => fs.existsSync(path.join(ROOT, 'packages', name, 'package.json')))
    .map((name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', name, 'package.json'), 'utf8')).name)
    .sort();
  assert.strictEqual(packages.length, 12, `包数量变了（现在 ${packages.length} 个），官网上的数字要跟着改`);
  assert.ok(built.html.includes('12</b> 个包') || built.html.includes('12 个包'), '页面上的包数量要对得上');

  // ④ 页面上列出的每个包都必须真实存在；内核的唯一可选依赖也要如实写出来
  for (const name of packages) {
    assert.ok(built.html.includes(name), `官网的包表里缺少 ${name}（有包没写，或写错了名字）`);
  }
  const kernel = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'core', 'package.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(kernel.optionalDependencies ?? {}), ['classic-level']);
  assert.ok(built.html.includes('classic-level'), '内核的可选依赖要如实标注（不隐藏）');
});

test('官网: 相对链接都能解析到真实产物（断链让构建失败）', async () => {
  const built = await buildLanding();
  const broken = findBrokenLandingLinks(built.html, (relative) => fs.existsSync(path.join(SITE, relative)));
  assert.deepStrictEqual(broken, [], `官网首页有断链：${broken.join(', ')}`);

  // 反向：造一个断链必须被检查出来（证明门禁会响）
  const fake = await findBrokenLandingLinks('<a href="./nope/missing.html">x</a>', (relative) => relative === 'ok.html');
  assert.deepStrictEqual(fake, ['./nope/missing.html']);
});

test('官网: 构建产物里首页是官网（README 另有其页），文档页能点回首页', async () => {
  const result = await build({ log: () => {} });
  assert.deepStrictEqual(result.broken, []);
  assert.deepStrictEqual(result.landing.broken, []);
  assert.deepStrictEqual([...result.landing.snippets].sort(), [...SNIPPETS].sort());

  const index = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  assert.ok(index.includes('把并发写成一棵'), '首页应当是官网（不是 README 的副本）');
  assert.ok(!index.includes('class="search"'), '官网首页不该带文档侧边栏的搜索框');
  assert.ok(fs.existsSync(path.join(SITE, 'README.html')), 'README 仍然要能在站内打开');

  // 文档页侧边栏有"官网首页"入口（从任意深度都能回去）
  const guide = fs.readFileSync(path.join(SITE, 'docs', 'guide', '01-quickstart.html'), 'utf8');
  assert.ok(guide.includes('href="../../index.html"'), '指南页要能点回官网首页');
  const rootish = fs.readFileSync(path.join(SITE, 'api.html'), 'utf8');
  assert.ok(rootish.includes('href="./index.html"'), '站点根的页面要能点回官网首页');
});

test('官网: 首页包含关键区块（hero / 特点 / 代码 / 纪律 / 包 / 快速开始）', async () => {
  const built = await buildLanding();
  for (const [name, marker] of [
    ['hero', '把并发写成一棵'],
    ['特点', 'id="features"'],
    ['代码', 'id="code"'],
    ['工程纪律', 'id="discipline"'],
    ['包', 'id="packages"'],
    ['快速开始', 'id="start"'],
    ['文档入口', './docs/guide/README.html'],
    ['API 参考', './api.html'],
  ]) {
    assert.ok(built.html.includes(marker), `首页缺少「${name}」区块（找不到 ${marker}）`);
  }
  // 三个 tab 与它们的面板都要在，且只有一个默认选中。
  // 注意：只能数**标签属性**，因为内联的 main.js 里有 `[role="tab"]` 这样的选择器字符串
  // （早先直接数 `role="tab"` 会把脚本里的那处也数进来 —— 这个门禁本身踩过）。
  assert.strictEqual([...built.html.matchAll(/<button class="tab" role="tab"/g)].length, 3);
  assert.strictEqual([...built.html.matchAll(/role="tabpanel"/g)].length, 3);
  // 同理：`aria-selected="true"` 也出现在内联 CSS 的 `.tab[aria-selected="true"]` 选择器里，
  // 所以只数**选中按钮标签本身**
  assert.strictEqual([...built.html.matchAll(/<button class="tab" role="tab"[^>]*aria-selected="true"/g)].length, 1);
});
