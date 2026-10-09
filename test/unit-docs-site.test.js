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

test('docs: "```js verify" 这类带标记的围栏要渲染成代码块，并把"CI 真执行"标出来', async () => {
  // 真实 bug 的回归：围栏信息串只按单词匹配过（`\w*`），于是 `js verify` 不匹配，
  // 整块示例被当成普通段落渲染成文字 —— 16 个页面的"可执行示例"在网站上全是乱码。
  const { renderMarkdown } = await import('../tools/docs-site.mjs');
  const rendered = renderMarkdown(['```js verify', 'const a = 1;', '```', '', '```ts', 'const b = 2;', '```'].join('\n'));
  assert.match(rendered.html, /<pre class="code" data-lang="js" data-verify="true">/, '带 verify 标记的块要标出来');
  assert.match(rendered.html, /<pre class="code" data-lang="ts">/, '普通围栏不受影响');
  assert.ok(!rendered.html.includes('js verify'), '信息串不能泄漏成正文文字');

  // 全站检查：任何页面都不该再出现"裸露的围栏信息串"
  await build({ log: () => {} });
  const site = path.join(ROOT, 'site');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith('.html') ? [full] : [];
  });
  const leaked = walk(site).filter((file) => /<p>```/.test(fs.readFileSync(file, 'utf8')));
  assert.deepStrictEqual(leaked.map((file) => path.relative(site, file)), [], '不该有页面把围栏当文字渲染');
});

test('docs: 阅读体验 —— 面包屑/上下篇/复制按钮/深色模式/搜索快捷键/移动端导航', async () => {
  await build({ log: () => {} });
  const site = path.join(ROOT, 'site');
  const page = fs.readFileSync(path.join(site, 'docs', 'guide', '12-actors-state.html'), 'utf8');

  // 面包屑：官网首页 / 层名 / 页面标题（层名来自 docs/nav.json）
  assert.match(page, /<div class="crumbs">[\s\S]*?官网首页[\s\S]*?按任务[\s\S]*?<\/div>/, '要有面包屑且带所在层');

  // 上/下一篇：顺序 = 导航顺序（这里 12 的前后是 11 与 13）
  const pager = /<div class="pager">([\s\S]*?)<\/div>/.exec(page);
  assert.ok(pager !== null, '要有上/下一篇');
  // 上下篇的标签用的是 nav.json 的短标题（不是页面 H1），所以这里按短标题断言
  assert.match(pager[1], /← 上一篇[\s\S]*?11 数据与 CRUD/, '上一篇应当是 11');
  assert.match(pager[1], /下一篇 →[\s\S]*?13 鉴权/, '下一篇应当是 13');

  // 首尾页只给一个方向（不能出现指向不存在页面的链接）
  const first = fs.readFileSync(path.join(site, 'docs', 'guide', '00-what-is-an-actor.html'), 'utf8');
  assert.ok(!/← 上一篇/.test(first), '第一页不该有"上一篇"');
  assert.match(first, /下一篇 →/, '第一页应当有"下一篇"');

  // 代码复制按钮、深色模式、移动端导航、搜索快捷键与命中高亮
  assert.match(page, /copy-code/, '每个代码块要有复制按钮（脚本注入）');
  assert.match(page, /data-theme-toggle/, '要有深浅色开关');
  assert.match(page, /\[data-theme="dark"\]/, '深色变量必须在样式里');
  assert.match(page, /prefers-color-scheme|localStorage/, '主题选择要跟随系统并可记住');
  assert.match(page, /data-nav-toggle/, '移动端要有导航开关');
  assert.match(page, /event\.key === '\/'/, '按 / 要能聚焦搜索框');
  assert.match(page, /<mark>|'<mark>'/, '搜索结果要标出命中位置');
});

test('docs: 术语表 —— JSON 与词汇页一致，且主线首现术语自动链过去（只在正文、每词一次）', async () => {
  const glossaryDir = path.join(ROOT, 'docs');
  const json = JSON.parse(fs.readFileSync(path.join(glossaryDir, 'glossary.json'), 'utf8'));
  const page = fs.readFileSync(path.join(glossaryDir, 'glossary.md'), 'utf8');
  const headings = new Set([...page.matchAll(/^### (.+)$/gm)].map((match) => match[1].trim()));

  // ① JSON 里的每个词都必须在词汇页有对应小节（否则自动链接会指向不存在的锚点）
  const missing = Object.keys(json.terms).filter((term) => !headings.has(term));
  assert.deepStrictEqual(missing, [], `glossary.json 里的词在 glossary.md 里没有小节：${missing.join(', ')}`);
  assert.ok(Object.keys(json.terms).length >= 15, `术语太少（${String(Object.keys(json.terms).length)}）`);

  await build({ log: () => {} });
  const site = path.join(ROOT, 'site');
  const article = fs.readFileSync(path.join(site, 'docs', 'guide', '12-actors-state.html'), 'utf8');

  // ② 正文里确实链过去了，且**每个词只链一次**
  const links = [...article.matchAll(/<a class="term" href="([^"]+)">([^<]+)<\/a>/g)].map((match) => ({ href: match[1], label: match[2] }));
  assert.ok(links.length >= 3, `正文里应当有若干术语链接（实际 ${String(links.length)}）`);
  assert.match(links[0].href, /glossary\.html#/, '链接要指向术语表锚点');
  const counts = new Map();
  for (const link of links) counts.set(link.label, (counts.get(link.label) ?? 0) + 1);
  assert.deepStrictEqual([...counts.entries()].filter(([, n]) => n > 1), [], '同一个词在一页里只能链一次');

  // ③ **绝不能链进代码块**（代码是给复制粘贴的，多一点标记都会坏）
  for (const block of article.matchAll(/<pre[\s\S]*?<\/pre>/g)) {
    assert.ok(!block[0].includes('class="term"'), '代码块里不许出现术语链接');
  }

  // ④ 词汇页自身不自我链接
  const glossaryHtml = fs.readFileSync(path.join(site, 'docs', 'glossary.html'), 'utf8');
  assert.ok(!glossaryHtml.includes('class="term"'), '术语表页面不该自链');
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
