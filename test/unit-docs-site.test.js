import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { renderMarkdown, findBrokenLinks, build } from '../tools/docs-site.mjs';

const ROOT = path.join(import.meta.dirname, '..');

/**
 * 文档站生成器（零依赖）的回归测试。
 *
 * 为什么要测一个"文档工具"：这个 markdown 渲染器是**我们自己维护**的（不上 VitePress 的代价），
 * 而它的输出质量直接决定文档能不能读。仓库里的写法（表格、嵌套列表、围栏代码、相对链接）必须
 * 逐条有断言，否则哪天渲染坏掉只会静默产出半成品站点。
 */

test('docs: markdown 渲染——标题带锚点、代码块、表格、嵌套列表、行内样式', () => {
  const source = [
    '# 标题一',
    '',
    '普通段落有 `code`、**粗体**、*斜体* 和 [链接](./other.md)。',
    '',
    '```js',
    'const a = 1 < 2 && "x";',
    '```',
    '',
    '| 列 A | 列 B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '- 顶层',
    '  - 嵌套',
    '- 第二个',
    '',
    '> 引用',
  ].join('\n');

  const { html, headings } = renderMarkdown(source, { linkFor: (href) => href.replace(/\.md$/, '.html') });

  assert.match(html, /<h1 id="标题一">标题一<a class="anchor" href="#标题一">#<\/a><\/h1>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /href=".\/other.html"/, '相对 md 链接要映射成 html');
  assert.match(html, /data-lang="js"/);
  assert.match(html, /1 &lt; 2 &amp;&amp; &quot;x&quot;/, '代码块内容必须转义（否则站点会被自己文档里的代码注入）');
  assert.match(html, /<table><thead><tr><th>列 A<\/th>/);
  assert.match(html, /<li>顶层<ul><li>嵌套<\/li><\/ul><\/li>/);
  assert.match(html, /<blockquote>引用<\/blockquote>/);
  assert.deepStrictEqual(
    headings.map((h) => h.text),
    ['标题一'],
  );
});

test('docs: markdown 渲染——段落里的 HTML 被转义（不执行文档里的标签）', () => {
  const { html } = renderMarkdown('危险：<script>alert(1)</script> 与 <img src=x onerror=y>');
  assert.ok(!html.includes('<script>'), '不能原样输出 script 标签');
  assert.ok(html.includes('&lt;script&gt;'), '应当转义');
});

test('docs: 断链检查——仓库内相对链接必须指向真实文件', () => {
  const broken = findBrokenLinks(
    [{ relative: 'docs/a.md', markdown: '见 [b](../b.md)、[图](./img.png)、[外](https://example.com)、[锚](#x)' }],
    () => false,
  );
  assert.deepStrictEqual(broken, ['docs/a.md → ../b.md', 'docs/a.md → ./img.png'], '外部链接与锚点不查');

  const clean = findBrokenLinks([{ relative: 'docs/a.md', markdown: '[ok](../b.md)' }], (relative) => relative === 'b.md');
  assert.deepStrictEqual(clean, [], '能解析到就通过');
});

test('docs: 真实构建——仓库现有文档零断链，且产出首页 / 各页 / API 参考 / 搜索索引', async () => {
  const result = await build({ log: () => {} });
  assert.deepStrictEqual(result.broken, [], '仓库里不能有断链（有就修文档或改链接）');
  assert.ok(result.pages >= 20, `页面数不合理：${result.pages}`);

  const site = path.join(ROOT, 'site');
  for (const file of ['index.html', 'README.html', 'docs/quickstart.html', 'docs/design/04-data-and-evolution.html', 'api.html', 'search.json']) {
    assert.ok(fs.existsSync(path.join(site, file)), `缺少产物：${file}`);
  }

  // 设计文档按目录 1:1 映射（相对链接才能自然成立）
  assert.ok(fs.existsSync(path.join(site, 'docs/design/m0')), 'm0 子目录也要有产物');
  // 路径 1:1（README.html）+ 目录 URL 也能打开（index.html）
  assert.ok(fs.existsSync(path.join(site, 'examples/app-data/README.html')), '示例 README 也要进站');
  assert.ok(fs.existsSync(path.join(site, 'examples/app-data/index.html')), '每个 README 也要有目录首页');

  // API 参考必须是从源码提取的（不是空壳）：数据层导出很多，内核也要列出来
  const api = fs.readFileSync(path.join(site, 'api.html'), 'utf8');
  assert.match(api, /nodejs-actor-framework/);
  assert.match(api, /@actor\/data/);
  assert.match(api, /createProjectionRunner/);
  assert.ok(/@ts-nocheck/.test(api), '内核的类型缺口要如实标注在页面上');

  // 首页现在是**官网**（`tools/landing/` → `site/index.html`），README 另有其页；
  // 官网自身的门禁在 test/unit-site-landing.test.js（含"页面代码 == 跑过的代码"与事实检查）
  const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.ok(index.includes('把并发写成一棵'), '首页应当是官网落地页');
  assert.ok(index.length > 20_000, '首页太小，八成构建坏了');

  // 文档页仍是带侧边栏搜索的渲染结果
  const readme = fs.readFileSync(path.join(site, 'README.html'), 'utf8');
  assert.ok(readme.includes('搜索文档'), '文档页侧边栏要有搜索框');
  assert.ok(readme.length > 5000, 'README 页太小，八成渲染坏了');
});

test('docs: 页面里的导航与"本页"目录都指向真实锚点', () => {
  const site = path.join(ROOT, 'site');
  const page = fs.readFileSync(path.join(site, 'docs/design/m4-cluster-governance.html'), 'utf8');
  const ids = new Set([...page.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]));
  const anchors = [...page.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const missing = anchors.filter((anchor) => !ids.has(anchor) && anchor !== 'x');
  assert.deepStrictEqual(missing, [], `指向了不存在的锚点：${missing.join(', ')}`);
});

/** API 参考做深：签名（含参数/返回）必须真实提取出来，类型覆盖进度必须与仓库真实状态一致。 */
test('docs api: 从声明/源码提取签名（参数、可选、rest、泛型、JSDoc、成员）', async () => {
  const { extractFromSource, untypedFiles } = await import('../tools/api-extract.mjs');

  const source = [
    '/** 建一个东西。 */',
    'export function build<T extends object>(options: BuildOptions, name?: string, ...rest: unknown[]): Promise<T> {',
    '  return null as never;',
    '}',
    '',
    'export interface BuildOptions {',
    '  name: string;',
    '  size?: number;',
    '}',
    '',
    'export class Builder {',
    '  constructor(options: BuildOptions) {}',
    '  run(input: string): number { return 1; }',
    '}',
    '',
    'export const VERSION: string = "1.0.0";',
  ].join('\n');

  const { found } = extractFromSource(source, 'fixture.ts');

  const build = found.get('build');
  assert.strictEqual(build.kind, '函数');
  assert.strictEqual(build.doc, '建一个东西。', '取到声明的 JSDoc 摘要');
  assert.deepStrictEqual(
    build.params.map((param) => [param.name, param.type, param.optional, param.rest]),
    [
      ['options', 'BuildOptions', false, false],
      ['name', 'string', true, false],
      ['rest', 'unknown[]', false, true],
    ],
  );
  assert.strictEqual(build.returns, 'Promise<T>');
  assert.match(build.signature, /^build<T extends object>\(options: BuildOptions, name\?: string, \.\.\.rest: unknown\[\]\) => Promise<T>$/);

  const options = found.get('BuildOptions');
  assert.strictEqual(options.kind, '接口');
  assert.ok(options.members.some((line) => line.startsWith('name: string')));
  assert.ok(options.members.some((line) => line.startsWith('size?: number')));

  const builder = found.get('Builder');
  assert.strictEqual(builder.kind, '类');
  assert.deepStrictEqual(builder.params.map((param) => param.type), ['BuildOptions']);
  assert.ok(builder.members.length >= 1, '类要列出公开成员');

  assert.strictEqual(found.get('VERSION').returns, 'string');

  // 类型覆盖进度：页面上的数字必须来自仓库真实状态（不能写死）。
  // 曾经断言"仍有文件带标记（M0.1 进行中）"；内核补完后这条改成断言"已归零"——
  // 断言与目标同向，才不会在目标达成时变成假红。
  const untyped = untypedFiles(path.join(ROOT), 'packages/core');
  assert.deepStrictEqual(untyped, [], `内核源码不应再有 @ts-nocheck：${untyped.join(', ')}`);
  assert.ok(untyped.every((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')));
});

test('docs api: 页面里有真实的参数/返回签名与类型覆盖进度', async () => {
  const { build } = await import('../tools/docs-site.mjs');
  const { untypedFiles } = await import('../tools/api-extract.mjs');
  await build({ log: () => {} });

  const api = fs.readFileSync(path.join(ROOT, 'site', 'api.html'), 'utf8');

  // 参数列与返回类型
  assert.match(api, /createSystem\(options\?: SystemOptions\) =&gt; ActorSystem/);
  assert.match(api, /createLogAdapter\(target: LogTarget/);
  assert.match(api, /createSqlRepository&lt;T[^<]*\(options: SqlRepositoryOptions/);
  assert.match(api, /参数：/);
  assert.match(api, /PersistenceError/);
  assert.match(api, /otlp/, '.d.ts 里补上的 otlp 要出现在 plugins 的成员里');

  // 类型覆盖进度必须与仓库真实状态一致
  const expected = untypedFiles(path.join(ROOT), 'packages/core').length;
  const match = /仍有 (\d+) 个文件带/.exec(api);
  assert.ok(match !== null, 'API 页要有类型覆盖一节');
  assert.strictEqual(Number(match[1]), expected, '页面上的未补文件数必须等于仓库真实数量');
  assert.match(api, new RegExp(`已补完 <strong>${45 - expected}/45</strong>`));
});
