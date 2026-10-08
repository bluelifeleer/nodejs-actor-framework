#!/usr/bin/env node
/**
 * 文档站生成器（零依赖，M5「文档站与 API 参考」的第一步）。
 *
 *   node tools/docs-site.mjs build   # 读 md → 写 site/
 *   node tools/docs-site.mjs serve   # 构建 + 起一个静态预览服务（默认 4321）
 *
 * 为什么自己写而不上 VitePress：这个仓库的 devDependencies 只有两个（typescript 与 @types/node），
 * 源码没有构建步骤。引入几百个包只为渲染 markdown，代价与收益不匹配。代价是**这个 markdown 渲染器
 * 要我们自己维护**——所以它只实现仓库里真实用到的子集，并且用仓库自己的文档做回归测试
 * （test/unit-docs-site.test.js）：渲染不出来就红，不会静默产出半成品站点。
 *
 * 三条设计决定：
 *   1. **路径 1:1 映射**：`docs/a.md` → `site/docs/a.html`，`README.md` → `site/README.html`
 *      （再复制一份成 `site/index.html`）。于是文档里的相对链接 `../m0/01-x.md` 只需把 `.md`
 *      换成 `.html`，不需要任何 URL 重写规则。
 *   2. **相对链接必须存在**：断链直接让构建失败（列出文件与目标），这是"文档也会烂"的唯一防线。
 *   3. **API 参考从源码提取**，不手抄：内核多数文件是 `@ts-nocheck`（类型信息没有），所以对内核
 *      只列导出名 + 注释摘要，并在页面上**如实标注**。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractFromDeclarationFile, extractFromSource, untypedFiles } from './api-extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');
/** 官网首页的源文件目录（`site/index.html` 由它生成，不再是 README 的副本）。 */
const LANDING = path.join(ROOT, 'tools', 'landing');

/* -------------------------------------------------------------------------- */
/* markdown 子集渲染                                                           */
/* -------------------------------------------------------------------------- */

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 行内：`code`、**粗**、*斜*、[文字](链接)、![alt](图片)。先转义再替换，避免注入。 */
function inline(text, linkFor = (href) => href) {
  const codeSpans = [];
  let value = String(text).replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  value = escapeHtml(value);
  value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img alt="${alt}" src="${linkFor(src)}">`);
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const target = linkFor(href);
    const external = /^https?:\/\//.test(href);
    return `<a href="${target}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${label}</a>`;
  });
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  value = value.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)]);
  return value;
}

const slugify = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'section';

/**
 * 把一个 md 文件渲染成 HTML。
 * 支持仓库里实际用到的子集：标题、段落、围栏代码、表格、列表（含嵌套）、引用、分隔线、行内样式。
 */
export function renderMarkdown(source, options = {}) {
  const linkFor = options.linkFor ?? ((href) => href);
  const headings = [];
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let index = 0;

  const flushParagraph = (buffer) => {
    if (buffer.length === 0) return;
    html.push(`<p>${inline(buffer.join(' '), linkFor)}</p>`);
    buffer.length = 0;
  };
  const paragraph = [];

  while (index < lines.length) {
    const line = lines[index];

    // 围栏代码。
    //
    // 信息串支持"语言 + 标记"两段：```` ```js verify ```` 表示这段代码**会被 CI 真执行**
    // （`test/unit-docs-guides.test.js` 会把它抠出来跑）。早先只认 `\w*`（单个词），
    // 于是 `js verify` 不匹配 → 整块被当成普通段落渲染成文字（真实 bug，16 个页面受影响）。
    // 允许**最多 3 个空格缩进**（CommonMark 的规定）：列表项里缩进写的围栏同样要能识别，
    // 否则像 examples/prometheus/README.md 那样把代码块写进有序列表时，整块会漏成正文（实测踩到）。
    const fence = /^ {0,3}```(\w*)\s*(.*)$/.exec(line);
    if (fence !== null) {
      const language = fence[1] || 'text';
      const marks = fence[2].trim();
      const body = [];
      index += 1;
      while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过收尾的 ```
      const verify = /(^|\s)verify($|\s)/.test(marks) ? ' data-verify="true"' : '';
      html.push(
        `<pre class="code" data-lang="${escapeHtml(language)}"${verify}><code>${escapeHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph(paragraph);
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      headings.push({ level, text, id });
      html.push(`<h${level} id="${id}">${inline(text, linkFor)}<a class="anchor" href="#${id}">#</a></h${level}>`);
      index += 1;
      continue;
    }

    // 分隔线
    if (/^\s*---+\s*$/.test(line)) {
      flushParagraph(paragraph);
      html.push('<hr>');
      index += 1;
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      flushParagraph(paragraph);
      const body = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${inline(body.join(' '), linkFor)}</blockquote>`);
      continue;
    }

    // 表格：表头 + 分隔行
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? '')) {
      flushParagraph(paragraph);
      const cells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim());
      const header = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      html.push(
        '<table><thead><tr>' +
          header.map((cell) => `<th>${inline(cell, linkFor)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, linkFor)}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table>',
      );
      continue;
    }

    // 列表（支持一层嵌套：缩进 ≥2 空格）
    const listItem = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (listItem !== null) {
      flushParagraph(paragraph);
      const ordered = /\d/.test(listItem[2]);
      const items = [];
      while (index < lines.length) {
        const match = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[index]);
        if (match === null) break;
        const indent = match[1].length;
        if (indent > 0 && items.length > 0) {
          items[items.length - 1].children.push(match[3]);
        } else {
          items.push({ text: match[3], children: [] });
        }
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(
        `<${tag}>` +
          items
            .map((item) => {
              const children =
                item.children.length > 0
                  ? `<ul>${item.children.map((child) => `<li>${inline(child, linkFor)}</li>`).join('')}</ul>`
                  : '';
              return `<li>${inline(item.text, linkFor)}${children}</li>`;
            })
            .join('') +
          `</${tag}>`,
      );
      continue;
    }

    // 空行 = 段落结束
    if (/^\s*$/.test(line)) {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph(paragraph);

  return { html: html.join('\n'), headings };
}

/* -------------------------------------------------------------------------- */
/* 页面收集与导航                                                              */
/* -------------------------------------------------------------------------- */

/** 页面的展示标题：第一个 h1，否则文件名。 */
function titleOf(markdown, fallback) {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match === null ? fallback : match[1].trim();
}

async function walk(dir, filter) {
  const found = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'site', '.git', 'data', 'msg_store'].includes(entry.name)) continue;
      found.push(...(await walk(full, filter)));
    } else if (filter(full)) {
      found.push(full);
    }
  }
  return found;
}

/** 设计文档按"总览 → 里程碑"分组，组内按文件名编号排序。 */
function groupOf(relative) {
  if (relative === 'README.md') return '首页';
  if (relative === 'docs/quickstart.md') return '快速开始';
  if (relative.startsWith('docs/guide/')) return '指南';
  if (relative.startsWith('docs/design/m0/')) return '规格（M0）';
  if (relative.startsWith('docs/design/')) return '设计与决策';
  if (relative.startsWith('docs/')) return '文档';
  if (relative.startsWith('examples/')) return '示例';
  return '其它';
}

const GROUP_ORDER = ['首页', '快速开始', '指南', '设计与决策', '规格（M0）', '文档', '示例', '参考', '其它'];

/* -------------------------------------------------------------------------- */
/* API 参考：从源码提取导出与注释（不手抄）                                     */
/* -------------------------------------------------------------------------- */

const PACKAGES = [
  {
    name: 'nodejs-actor-framework',
    entry: 'packages/core/src/index.ts',
    src: 'packages/core/src',
    note: '内核。多数文件带 `@ts-nocheck`（类型尚未补齐），所以这里只有导出名与注释摘要——如实标注，不假装完整。',
  },
  { name: '@actor/app', entry: 'packages/app/src/index.ts', src: 'packages/app/src' },
  { name: '@actor/web', entry: 'packages/web/src/index.ts', src: 'packages/web/src' },
  { name: '@actor/data', entry: 'packages/data/src/index.ts', src: 'packages/data/src' },
  { name: '@actor/resource', entry: 'packages/resource/src/index.ts', src: 'packages/resource/src' },
  { name: '@actor/db-core', entry: 'packages/db-core/src/index.ts', src: 'packages/db-core/src' },
  { name: '@actor/db', entry: 'packages/db/src/index.ts', src: 'packages/db/src' },
  { name: '@actor/redis', entry: 'packages/redis/src/index.ts', src: 'packages/redis/src' },
  { name: '@actor/mongodb', entry: 'packages/mongodb/src/index.ts', src: 'packages/mongodb/src' },
  { name: '@actor/mail', entry: 'packages/mail/src/index.ts', src: 'packages/mail/src' },
];

/** 内核公开面来自手写的 .d.ts（内部实现文件仍有 @ts-nocheck，见"类型覆盖"一节）。 */
const KERNEL_DECLARATION_FILE = 'packages/core/src/index.d.ts';

/** 收集每个导出名的签名：内核读 .d.ts，typed 包读源码（按声明文本解析）。 */
async function collectSignatures() {
  const byName = new Map();
  const kernel = extractFromDeclarationFile(path.join(ROOT, KERNEL_DECLARATION_FILE));
  for (const [name, entry] of kernel.found) byName.set(name, { ...entry, source: KERNEL_DECLARATION_FILE });

  for (const spec of PACKAGES) {
    if (spec.entry === KERNEL_DECLARATION_FILE) continue;
    for (const file of await walk(path.join(ROOT, spec.src), (full) => full.endsWith('.ts') && !full.endsWith('.d.ts'))) {
      const relative = path.relative(ROOT, file);
      if (relative.includes('/test/')) continue;
      const parsed = extractFromSource(await fsp.readFile(file, 'utf8'), relative);
      for (const [name, entry] of parsed.found) {
        if (!byName.has(name)) byName.set(name, { ...entry, source: relative });
      }
    }
  }
  return byName;
}

/** 表格一行：导出 / 类别 / 签名（含参数）/ 说明 / 源码。 */
function renderSignatureRow(name, entry) {
  const signature = entry.signature ?? entry.returns ?? '—';
  const params =
    Array.isArray(entry.params) && entry.params.length > 0
      ? `<br><span class="note">参数：${entry.params
          .map((param) => `<code>${escapeHtml(param.name)}</code>: ${escapeHtml(param.type ?? '未标注')}`)
          .join(' · ')}</span>`
      : '';
  const members =
    Array.isArray(entry.members) && entry.members.length > 0
      ? `<details><summary>${entry.members.length} 个成员</summary><pre class="code">${escapeHtml(entry.members.join('\n'))}</pre></details>`
      : '';
  const source = String(entry.source ?? '');
  return `<tr>
  <td><code>${escapeHtml(name)}</code></td>
  <td>${escapeHtml(entry.kind)}</td>
  <td><code>${escapeHtml(String(signature).slice(0, 200))}</code>${params}</td>
  <td>${entry.doc === null || entry.doc === undefined ? '' : escapeHtml(entry.doc)}</td>
  <td><a href="../${escapeHtml(source.replace(/\.ts$/, '.html'))}">${escapeHtml(source.replace('packages/', ''))}</a>${members}</td>
</tr>`;
}

async function buildApiPage() {
  const signatures = await collectSignatures();
  const untyped = untypedFiles(ROOT, 'packages/core');
  const sections = [];

  for (const spec of PACKAGES) {
    const entryAbs = path.join(ROOT, spec.entry);
    const module = await import(pathToFileURL(entryAbs).href);
    const exported = module.default && typeof module.default === 'object' ? module.default : module;
    const names = Object.keys(exported)
      .filter((key) => key !== 'default' && key !== '__esModule')
      .sort((a, b) => a.localeCompare(b));

    const rows = names.map((name) =>
      renderSignatureRow(
        name,
        signatures.get(name) ?? { kind: '值', signature: '（未提取到声明）', params: [], doc: null, source: spec.entry },
      ),
    );

    sections.push(`
<h2 id="${slugify(spec.name)}">${escapeHtml(spec.name)}</h2>
${spec.note === undefined ? '' : `<p class="note">${inline(spec.note)}</p>`}
<p class="note">导出 ${names.length} 项。签名按**声明文本**提取：本仓库的 typescript 7 是原生端口、
不暴露编译器 API（实测只有 version/default 两个导出），所以不做类型推导；没写出标注的项显示"未标注"。</p>
<table><thead><tr><th>导出</th><th>类别</th><th>签名 / 类型（含参数）</th><th>说明</th><th>源码</th></tr></thead><tbody>${rows.join('')}</tbody></table>`);
  }

  const coverage = `<h2 id="typing-coverage">类型覆盖（M0.1 进度）</h2>
<p class="note">内核的**公开面**在一个手写的声明文件里，所以对外是完整的；**内部实现文件**仍在逐个补类型：
带 <code>@ts-nocheck</code> 的文件会跳过严格检查，<code>npm run typecheck</code> 覆盖不到它们。</p>
<ul>
  <li>公开面声明：<code>${KERNEL_DECLARATION_FILE}</code>（本页内核部分的签名全部来自它）</li>
  <li>已补完 <strong>${45 - untyped.length}/45</strong> 个内核源码文件（去掉 <code>@ts-nocheck</code> 且严格检查通过）</li>
</ul>
<details><summary>仍有 ${untyped.length} 个文件带 <code>@ts-nocheck</code></summary>
<pre class="code">${escapeHtml(untyped.join('\n'))}</pre>
<p class="note">按"去掉标记后会报多少错"排序，先补成本低的：<code>actor/errors.ts</code>(1)、
<code>store/backends/crc32.ts</code>(2)、<code>store/backends/naming.ts</code>(5)、<code>plugins/rate-limit.ts</code>(6)…
全量补完约 2000 个严格错误（实测），属于 M0.1 的持续工作。</p>
</details>`;

  return `${sections.join('\n')}\n${coverage}`;
}

/* -------------------------------------------------------------------------- */
/* 布局与构建                                                                  */
/* -------------------------------------------------------------------------- */

const STYLE = `
:root { --fg:#1c2024; --muted:#5b6570; --line:#e3e7ea; --accent:#0b62d0; --bg:#fff; --code:#f6f8fa; }
* { box-sizing: border-box; }
body { margin:0; color:var(--fg); background:var(--bg); font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.layout { display:grid; grid-template-columns:280px minmax(0,1fr); min-height:100vh; }
aside { border-right:1px solid var(--line); padding:20px 16px; position:sticky; top:0; height:100vh; overflow:auto; }
aside .brand { font-weight:700; font-size:15px; margin-bottom:4px; }
aside .brand small { display:block; color:var(--muted); font-weight:400; margin-top:2px; }
aside h4 { margin:18px 0 6px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
aside ul { list-style:none; margin:0; padding:0; } aside li { margin:2px 0; }
aside a { display:block; padding:4px 8px; border-radius:6px; color:var(--fg); font-size:14px; }
aside a:hover { background:var(--code); text-decoration:none; } aside a.active { background:#e8f0fd; color:var(--accent); font-weight:600; }
main { padding:32px 40px 80px; max-width:900px; }
h1,h2,h3,h4 { line-height:1.3; } h1 { font-size:30px; margin-top:0; } h2 { font-size:23px; margin-top:34px; padding-top:6px; border-top:1px solid var(--line); }
h3 { font-size:18px; margin-top:26px; } h4 { font-size:16px; }
.anchor { opacity:0; margin-left:8px; font-weight:400; } h1:hover .anchor, h2:hover .anchor, h3:hover .anchor { opacity:.35; }
pre.code { background:var(--code); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow:auto; font-size:13.5px; line-height:1.55; }
pre.code[data-lang]::before { content:attr(data-lang); display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }
pre.code[data-verify] { border-left:3px solid #2f9e6f; }
pre.code[data-verify]::after { content:"✓ 本块在 CI 里真执行（断言写在代码里）"; display:block; margin-top:8px; color:#2f9e6f; font-size:11.5px; letter-spacing:.02em; }
code { background:var(--code); padding:1px 5px; border-radius:4px; font-size:13.5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
pre code { background:none; padding:0; }
table { border-collapse:collapse; width:100%; margin:14px 0; font-size:14.5px; }
th,td { border:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top; }
th { background:var(--code); }
blockquote { margin:14px 0; padding:8px 14px; border-left:3px solid var(--accent); background:var(--code); color:var(--muted); }
hr { border:0; border-top:1px solid var(--line); margin:28px 0; }
.note { color:var(--muted); font-size:14px; }
.search { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px; font-size:14px; }
#results { margin-top:8px; font-size:14px; } #results a { display:block; padding:3px 6px; border-radius:5px; }
@media (max-width:900px) { .layout { grid-template-columns:1fr; } aside { position:static; height:auto; border-right:0; border-bottom:1px solid var(--line); } main { padding:20px; } }
`;

const SEARCH_SCRIPT = `
const input = document.getElementById('search');
const results = document.getElementById('results');
let index = [];
fetch(window.__ROOT__ + 'search.json').then((r) => r.json()).then((data) => { index = data; }).catch(() => {});
input?.addEventListener('input', () => {
  const query = input.value.trim().toLowerCase();
  results.innerHTML = '';
  if (query.length < 2) return;
  index.filter((page) => page.text.includes(query)).slice(0, 12).forEach((page) => {
    const link = document.createElement('a');
    link.href = window.__ROOT__ + page.url;
    link.textContent = page.title + ' · ' + page.group;
    results.appendChild(link);
  });
});
`;

function layout({ title, body, nav, currentUrl, rootPrefix, toc }) {
  const navHtml = GROUP_ORDER.filter((group) => nav.has(group))
    .map((group) => {
      const items = nav
        .get(group)
        .map(
          (page) =>
            `<li><a class="${page.url === currentUrl ? 'active' : ''}" href="${rootPrefix}${page.url}">${escapeHtml(page.title)}</a></li>`,
        )
        .join('');
      return `<h4>${escapeHtml(group)}</h4><ul>${items}</ul>`;
    })
    .join('');
  const tocHtml =
    toc.length === 0
      ? ''
      : `<h4>本页</h4><ul>${toc
          .filter((heading) => heading.level >= 2 && heading.level <= 3)
          .map((heading) => `<li><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
          .join('')}</ul>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><div class="layout">
<aside>
  <div class="brand">Actor Framework<small>设计文档与 API 参考</small></div>
  <ul><li><a href="${rootPrefix}index.html">← 官网首页</a></li></ul>
  <input class="search" id="search" placeholder="搜索文档…" autocomplete="off">
  <div id="results"></div>
  ${navHtml}
  ${tocHtml}
</aside>
<main>${body}</main>
</div>
<script>window.__ROOT__=${JSON.stringify(rootPrefix)};${SEARCH_SCRIPT}</script>
</body></html>`;
}

/**
 * 极小的语法高亮：只覆盖本仓库示例里真实用到的 token（注释 / 字符串 / 关键字 / 数字）。
 *
 * 为什么服务端做而不是前端 JS：离线打开文件也要好看，且不依赖 JS；代价是要自己维护这个子集。
 * **先转义再包裹**：任何 token 都走 escapeHtml，示例内容不会破坏页面结构。
 */
export function highlightCode(source) {
  const TOKEN =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*")|\b(const|let|var|function|class|extends|super|return|await|async|if|else|switch|case|break|default|throw|new|try|catch|finally|for|of|in|import|export|from|type|interface|as|is|void|delete|typeof|instanceof|yield|static|readonly|public|private|enum|declare)\b|\b(\d+(?:\.\d+)?)\b/g;
  let out = '';
  let last = 0;
  for (const match of String(source).matchAll(TOKEN)) {
    const index = match.index ?? 0;
    out += escapeHtml(String(source).slice(last, index));
    const [text, comment, string, keyword, number] = match;
    const cls = comment !== undefined ? 'cmt' : string !== undefined ? 'str' : keyword !== undefined ? 'kw' : number !== undefined ? 'num' : null;
    out += cls === null ? escapeHtml(text) : `<span class="${cls}">${escapeHtml(text)}</span>`;
    last = index + text.length;
  }
  return out + escapeHtml(String(source).slice(last));
}

const LANG_BY_EXT = { js: 'javascript', cjs: 'javascript', mjs: 'javascript', ts: 'typescript', json: 'json', bash: 'bash' };

/**
 * 生成官网首页 `site/index.html`：读 `tools/landing/` 下的源文件，把三处占位符换成真内容。
 *
 *   `<!--landing:styles-->`          ← styles.css 内联
 *   `<!--landing:script-->`          ← main.js 内联
 *   `<!--landing:snippet <文件>-->`  ← snippets/<文件> 高亮后内联
 *
 * 返回 `{ html, snippets }`，`snippets` 供测试断言"页面里的代码 == 被跑过的代码"。
 */
export async function buildLanding() {
  const dir = LANDING;
  const [template, css, js] = await Promise.all([
    fsp.readFile(path.join(dir, 'index.html'), 'utf8'),
    fsp.readFile(path.join(dir, 'styles.css'), 'utf8'),
    fsp.readFile(path.join(dir, 'main.js'), 'utf8'),
  ]);

  const snippetNames = [...template.matchAll(/<!--landing:snippet ([^>]+?)-->/g)].map((match) => match[1].trim());
  const snippets = new Map();
  for (const name of new Set(snippetNames)) {
    const source = await fsp.readFile(path.join(dir, 'snippets', name), 'utf8');
    snippets.set(name, source);
  }

  let html = template
    .replace('<!--landing:styles-->', `<style>\n${css}</style>`)
    .replace('<!--landing:script-->', `<script>\n${js}</script>`);
  for (const [name, source] of snippets) {
    const lang = LANG_BY_EXT[path.extname(name).slice(1)] ?? 'text';
    const block = `<pre class="code" data-lang="${lang}"><code>${highlightCode(source)}</code></pre>`;
    html = html.replaceAll(`<!--landing:snippet ${name}-->`, block);
  }
  const leftover = html.match(/<!--landing:[^>]*-->/g);
  if (leftover !== null) {
    throw new Error(`官网首页还有没被替换的占位符：${leftover.join(', ')}（检查 tools/landing/index.html）`);
  }
  return { html, snippets: [...snippets.keys()] };
}

/**
 * 官网首页的断链检查。
 *
 * 首页站在站点根，所以它的相对链接直接对应 `site/` 下的产物；`href="#x"` 与外链不查。
 * 目录形式的链接（`docs/guide/`）接受 `目录 + index.html`。
 */
export function findBrokenLandingLinks(html, exists) {
  const broken = [];
  for (const match of String(html).matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#|data:|\/)/.test(target)) continue;
    const [file] = target.split('#');
    if (file === undefined || file === '' || !/\.(html|json|css|js|txt|svg|png|md)$/.test(file)) continue;
    if (exists(file) || exists(`${file.replace(/\/+$/, '')}/index.html`)) continue;
    broken.push(target);
  }
  return broken;
}

/**
 * 找出文档里的**断链**（只查相对链接/图片；外部链接不查，离线也要能构建）。
 *
 * 这是"文档也会烂"的唯一防线：链接指向的文件不存在 → 构建失败并列出（文件 → 目标），
 * 而不是产出一个点进去 404 的站点。
 */
export function findBrokenLinks(pages, exists) {
  const broken = [];
  const known = new Set(pages.map((page) => page.relative));
  for (const page of pages) {
    const links = [...String(page.markdown).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
    for (const href of links) {
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      const [target] = href.split('#');
      if (target === undefined || target === '') continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page.relative), target));
      // 只查"看起来是仓库内文件"的链接：`.md` 或显式相对路径（`./` `../`）
      const looksInternal = target.endsWith('.md') || target.startsWith('./') || target.startsWith('../');
      if (!looksInternal) continue;
      const resolvedAbsolute = path.posix.normalize(resolved);
      if (!known.has(resolvedAbsolute) && !exists(resolvedAbsolute)) broken.push(`${page.relative} → ${href}`);
    }
  }
  return broken;
}

/** 把 md 路径映射成站点 URL（1:1，只把 `.md` 换成 `.html`）。 */
const urlFor = (relative) => relative.replace(/\.md$/, '.html');

function relativeLinkFor(relative, href) {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;
  const [target, hash] = href.split('#');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
  return `${urlFor(resolved)}${hash === undefined ? '' : `#${hash}`}`;
}

export async function build({ log = console.log } = {}) {
  const markdownFiles = [
    path.join(ROOT, 'README.md'),
    ...(await walk(path.join(ROOT, 'docs'), (full) => full.endsWith('.md'))),
    ...(await walk(path.join(ROOT, 'examples'), (full) => path.basename(full) === 'README.md')),
  ];
  const pages = [];
  for (const fileAbs of markdownFiles) {
    const relative = path.relative(ROOT, fileAbs).split(path.sep).join('/');
    const markdown = await fsp.readFile(fileAbs, 'utf8');
    pages.push({ relative, markdown, title: titleOf(markdown, relative), group: groupOf(relative) });
  }

  // 断链检查：只查相对链接与图片，外部链接不管（离线也要能构建）
  //
  // `api.html` 与 `index.html` 是**构建时生成**的页面（源码里没有对应文件），所以单独认它们：
  // 文档里从任何目录写 `../../api.html` / `../../index.html` 都合法，但只有站在站点根（`site/`）
  // 时才对得上。它们不放进"已存在文件"的判定里（那会把真实断链也放过）。
  const generated = new Set(['api.html', 'index.html']);
  const broken = findBrokenLinks(
    pages,
    (relative) => fs.existsSync(path.join(ROOT, relative)) || generated.has(path.posix.basename(relative)),
  );

  const nav = new Map();
  const listing = pages
    .map((page) => ({ title: page.title, group: page.group, url: urlFor(page.relative) }))
    .sort((a, b) => a.url.localeCompare(b.url));
  for (const entry of listing) {
    if (!nav.has(entry.group)) nav.set(entry.group, []);
    nav.get(entry.group).push(entry);
  }

  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  const searchIndex = [];
  for (const page of pages) {
    const url = urlFor(page.relative);
    const depth = url.split('/').length - 1;
    const rootPrefix = depth === 0 ? './' : '../'.repeat(depth);
    const { html, headings } = renderMarkdown(page.markdown, { linkFor: (href) => relativeLinkFor(page.relative, href) });
    const outFile = path.join(OUT, url);
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await fsp.writeFile(
      outFile,
      layout({ title: page.title, body: html, nav, currentUrl: url, rootPrefix, toc: headings }),
      'utf8',
    );
    searchIndex.push({
      url,
      title: page.title,
      group: page.group,
      text: page.markdown.toLowerCase().slice(0, 4000),
    });
    // 每个 README 额外落一份 index.html：路径 1:1 映射（README.html）之外，
    // 让 `site/` 与 `site/examples/app-data/` 这类目录 URL 也能直接打开。
    // 根 README 的目录首页就是官网首页（下面单独生成），所以这里只为**子目录**的 README 落 index.html
    if (path.basename(page.relative) === 'README.md' && page.relative !== 'README.md') {
      const dir = path.dirname(url);
      const indexUrl = dir === '.' ? 'index.html' : `${dir}/index.html`;
      await fsp.writeFile(
        path.join(OUT, indexUrl),
        layout({ title: page.title, body: html, nav, currentUrl: indexUrl, rootPrefix, toc: headings }),
        'utf8',
      );
    }
  }

  // 官网首页（`site/index.html`）：由 tools/landing/ 生成，不再复制 README
  const landing = await buildLanding();
  await fsp.writeFile(path.join(OUT, 'index.html'), landing.html, 'utf8');
  searchIndex.push({
    url: 'index.html',
    title: '官网首页',
    group: '首页',
    text: '官网 actor framework 特点 监督树 邮箱 持久化 集群 可观测 零依赖 快速开始',
  });

  // API 参考（从源码提取，不手抄）
  const apiBody = `<h1 id="api">API 参考</h1>
<p class="note">本页由 <code>tools/docs-site.mjs</code> 自动生成：导出名、类别、**签名/类型（含参数）**、
注释摘要与源码位置。内核公开面来自手写声明文件；内部文件的类型补齐进度见最后一节。</p>
${await buildApiPage()}`;
  await fsp.writeFile(
    path.join(OUT, 'api.html'),
    layout({
      title: 'API 参考',
      body: apiBody,
      nav: (() => {
        if (!nav.has('参考')) nav.set('参考', []);
        nav.get('参考').push({ title: 'API 参考', group: '参考', url: 'api.html' });
        return nav;
      })(),
      currentUrl: 'api.html',
      rootPrefix: './',
      toc: [],
    }),
    'utf8',
  );
  searchIndex.push({ url: 'api.html', title: 'API 参考', group: '参考', text: 'api 参考 导出 函数 类 内核' });
  await fsp.writeFile(path.join(OUT, 'search.json'), JSON.stringify(searchIndex), 'utf8');

  // 官网首页的断链检查放在**所有产物都写完**之后：`./api.html` 是构建期生成的，
  // 检查得太早会把它当断链（实测踩到）
  const landingBroken = findBrokenLandingLinks(landing.html, (relative) => fs.existsSync(path.join(OUT, relative)));

  log(`doc site: 官网首页 + ${pages.length} 页 + api.html → ${path.relative(ROOT, OUT)}/`);
  if (landingBroken.length > 0) {
    const error = new Error(
      `官网首页有 ${landingBroken.length} 个断链（相对链接必须能解析到真实产物）：\n  ${landingBroken.join('\n  ')}`,
    );
    error.broken = landingBroken;
    throw error;
  }
  if (broken.length > 0) {
    const error = new Error(`文档里有 ${broken.length} 个断链（相对链接必须能解析到真实文件）：\n  ${broken.join('\n  ')}`);
    error.broken = broken;
    throw error;
  }
  return { pages: pages.length, broken, landing: { snippets: landing.snippets, broken: landingBroken } };
}

/* -------------------------------------------------------------------------- */
/* 预览服务（零依赖）                                                          */
/* -------------------------------------------------------------------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

export function serve({ port = 4321, log = console.log } = {}) {
  const server = http.createServer(async (request, response) => {
    const url = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const target = url === '/' ? '/index.html' : url;
    const file = path.join(OUT, path.normalize(target).replace(/^([/\\])+/, ''));
    if (!file.startsWith(OUT)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await fsp.readFile(file);
      response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      log(`docs: http://127.0.0.1:${server.address().port}/`);
      resolve(server);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const command = process.argv[2] ?? 'build';
  if (command === 'build') {
    await build().catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  } else if (command === 'serve') {
    const port = Number(process.argv[3] ?? process.env.DOCS_PORT ?? 4321);
    await build();
    await serve({ port });
  } else {
    console.error(`用法: node tools/docs-site.mjs [build|serve] [port]`);
    process.exit(1);
  }
}
