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
 * 术语表自动链接：把**正文里首次出现**的术语链到 `docs/glossary.md` 的对应锚点。
 *
 * 为什么是后处理而不是塞进 `inline()`：`inline()` 在替换代码片段与链接时还处在 markdown 阶段，
 * 术语可能落在"链接文字/代码"里，改起来容易把文档结构弄坏。这里在**渲染完成的 HTML** 上做，
 * 并且**明确跳过**：`<pre>`、`<code>`、`<a>`、标题（`<h1>`–`<h6>`）与所有标签内部 —— 只动纯文本。
 * 每个术语**每页只链第一次**（第二次出现保持纯文本，不打扰阅读）。
 */
export function linkGlossaryTerms(html, terms, options = {}) {
  const rootPrefix = options.rootPrefix ?? './';
  const target = `${rootPrefix}glossary.html`;
  const pending = new Map(Object.entries(terms));
  if (pending.size === 0) return html;

  // 先把 HTML 切成"受保护块"与"可改写文本"：受保护块原样输出
  const protectedPattern = /<(pre|code|a|h[1-6])\b[^>]*>[\s\S]*?<\/\1>|<[^>]+>/gi;
  let out = '';
  let last = 0;
  const rewriteText = (text) => {
    let result = text;
    for (const [term, anchor] of pending) {
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // ASCII 术语要求词边界（避免 link 掉 `asking` 这类）；中文按子串匹配
      const pattern = /^[A-Za-z ]+$/.test(term) ? new RegExp(`\\b${escapedTerm}\\b`) : new RegExp(escapedTerm);
      const match = pattern.exec(result);
      if (match === null) continue;
      const label = match[0];
      result = result.slice(0, match.index) + `<a class="term" href="${target}#${anchor}">${label}</a>` + result.slice(match.index + label.length);
      pending.delete(term);
    }
    return result;
  };

  for (const match of html.matchAll(protectedPattern)) {
    const index = match.index ?? 0;
    out += rewriteText(html.slice(last, index));
    out += match[0];
    last = index + match[0].length;
  }
  out += rewriteText(html.slice(last));
  return out;
}

/** 读 `docs/glossary.json`（术语 → 锚点）；文件不存在就返回空表（不阻断构建）。 */
function loadGlossaryTerms(root = ROOT) {
  const file = path.join(root, 'docs', 'glossary.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')).terms ?? {};
}

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
        '<div class="table-wrap"><table><thead><tr>' +
          header.map((cell) => `<th>${inline(cell, linkFor)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, linkFor)}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table></div>',
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
/**
 * 导航分组：**只认 `docs/nav.json`**，不再从目录结构推断。
 *
 * 为什么改：目录结构反映的是"文件从哪来"（规格 M0 / 设计与决策 / internals / 参考），
 * 而读者要的是"我现在该干什么"（开始 / 按任务 / 概念与设计 / 参考）。旧的分组把设计与规格
 * 放在主线旁边，读者第一眼看到的是仓库的文件夹树。
 *
 * 契约：nav.json 的每一层按顺序列出页面；层里的 `match` 前缀用于批量收编（internals/、
 * 设计史、示例）；**没被任何一层匹配到的页面会落到最后一层并在日志里点名** —— 新页面忘了登记
 * 不会静默消失（`test/unit-docs-guides.test.js` 也断言"每个页面恰好出现一次"）。
 */
export function loadNav(root = ROOT) {
  const file = path.join(root, 'docs', 'nav.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const layers = config.layers.map((layer) => ({
    title: layer.title,
    blurb: layer.blurb ?? '',
    pages: (layer.pages ?? []).map((page) => page.path),
    match: layer.match ?? [],
  }));
  /** nav.json 里的**短标题**（侧边栏用）：页面 H1 往往很长，不适合当导航标签。 */
  const titles = new Map(
    config.layers.flatMap((layer) => (layer.pages ?? []).map((page) => [page.path, page.title])),
  );
  return { layers, fallback: layers[layers.length - 1].title, titles };
}

/** 按 nav.json 把页面分组；返回 `Map<层名, 页面[]>` 与"未登记"清单。 */
function groupPages(pages, nav) {
  const groups = new Map(nav.layers.map((layer) => [layer.title, []]));
  const placed = new Set();
  const unregistered = [];
  for (const layer of nav.layers) {
    for (const relative of layer.pages) {
      const page = pages.find((item) => item.relative === relative);
      if (page === undefined) continue; // 找不到由门禁报错，这里不静默造条目
      groups.get(layer.title).push(page);
      placed.add(relative);
    }
  }
  for (const page of pages) {
    if (placed.has(page.relative)) continue;
    const layer = nav.layers.find((item) => item.match.some((prefix) => page.relative.startsWith(prefix)));
    if (layer !== undefined) {
      groups.get(layer.title).push(page);
      placed.add(page.relative);
      continue;
    }
    groups.get(nav.fallback).push(page);
    unregistered.push(page.relative);
  }
  return { groups, unregistered };
}

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
  { name: '@actor/ops-agent', entry: 'packages/ops-agent/src/index.ts', src: 'packages/ops-agent/src' },
  { name: '@actor/testkit', entry: 'packages/testkit/src/index.ts', src: 'packages/testkit/src' },
  // CLI 没有 src/index.ts：它的公开面是 `@actor/cli/commands`（用户自定义命令用的 defineCommand）
  { name: '@actor/cli', entry: 'packages/cli/src/commands/custom.ts', src: 'packages/cli/src/commands' },
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
    // 需要 development 导出条件：包的默认入口是编译产物 `dist/`，而文档站要能在**干净 checkout**
    // （没有 dist）上构建。`npm run docs:build` 已带上该条件；直接跑本文件时请加 `--conditions=development`。
    let module;
    try {
      module = await import(pathToFileURL(entryAbs).href);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error(
          `文档站构建需要 development 导出条件（默认入口是 dist，干净 checkout 里没有）。\n` +
            `用 \`npm run docs:build\`，或 \`node --conditions=development tools/docs-site.mjs build\`。\n` +
            `原始错误：${error.message}`,
        );
      }
      throw error;
    }
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
<div class="table-wrap"><table><thead><tr><th>导出</th><th>类别</th><th>签名 / 类型（含参数）</th><th>说明</th><th>源码</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
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
:root { --fg:#1c2024; --muted:#5b6570; --line:#e3e7ea; --accent:#0b62d0; --bg:#fff; --code:#f6f8fa; --sidebar:#fbfcfd; --mark:#fff3bf; }
/* 深色模式：跟随系统，或由右上角开关强制（localStorage 记住选择）。与官网首页同一套观感。 */
:root[data-theme="dark"] { --fg:#e8eefc; --muted:#9aa8c7; --line:#23304d; --accent:#6aa6ff; --bg:#0a0f1e; --code:#0c1425; --sidebar:#0f1729; --mark:#4d3f00; }
* { box-sizing:border-box; }
body { margin:0; color:var(--fg); background:var(--bg); font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.layout { display:grid; grid-template-columns:280px minmax(0,1fr); min-height:100vh; }
aside { border-right:1px solid var(--line); background:var(--sidebar); padding:20px 16px; position:sticky; top:0; height:100vh; overflow:auto; }
aside .brand { font-weight:700; font-size:15px; margin-bottom:4px; }
aside .brand small { display:block; color:var(--muted); font-weight:400; margin-top:2px; }
aside h4 { margin:18px 0 6px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
aside ul { list-style:none; margin:0; padding:0; } aside li { margin:2px 0; }
aside a { display:block; padding:4px 8px; border-radius:6px; color:var(--fg); font-size:14px; }
aside a:hover { background:var(--code); text-decoration:none; } aside a.active { background:color-mix(in srgb, var(--accent) 14%, transparent); color:var(--accent); font-weight:600; }
main { padding:32px 40px 80px; max-width:900px; min-width:0; }
aside { min-width:0; }
.table-wrap { overflow-x:auto; }  /* 宽表在自身容器里滚动，不撑宽整页 */
h1,h2,h3,h4 { line-height:1.3; } h1 { font-size:30px; margin-top:0; } h2 { font-size:23px; margin-top:34px; padding-top:6px; border-top:1px solid var(--line); }
h3 { font-size:18px; margin-top:26px; } h4 { font-size:16px; }
.anchor { opacity:0; margin-left:8px; font-weight:400; } h1:hover .anchor, h2:hover .anchor, h3:hover .anchor { opacity:.35; }
pre.code { position:relative; background:var(--code); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow:auto; font-size:13.5px; line-height:1.55; }
pre.code[data-lang]::before { content:attr(data-lang); display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }
pre.code[data-verify] { border-left:3px solid #2f9e6f; }
pre.code[data-verify]::after { content:"✓ 本块在 CI 里真执行（断言写在代码里）"; display:block; margin-top:8px; color:#2f9e6f; font-size:11.5px; letter-spacing:.02em; }
/* 代码块复制按钮：默认半透明，hover 才明显（不打扰阅读） */
.copy-code { position:absolute; top:8px; right:8px; opacity:0; transition:opacity .12s ease; background:var(--bg); color:var(--muted); border:1px solid var(--line); border-radius:6px; padding:2px 8px; font-size:12px; cursor:pointer; }
pre.code:hover .copy-code, .copy-code:focus-visible { opacity:1; }
.copy-code.done { color:#2f9e6f; border-color:#2f9e6f; }
/* 面包屑与上/下一篇：把"独立文章堆"变成一条路 */
.crumbs { color:var(--muted); font-size:13px; margin-bottom:10px; }
.pager { display:flex; gap:12px; justify-content:space-between; margin-top:44px; padding-top:16px; border-top:1px solid var(--line); }
.pager a { display:block; max-width:48%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; }
.pager a:hover { text-decoration:none; border-color:var(--accent); }
.pager span { display:block; color:var(--muted); font-size:12px; }
.pager .next { margin-left:auto; text-align:right; }
.theme-toggle { position:absolute; top:16px; right:16px; background:var(--bg); color:var(--muted); border:1px solid var(--line); border-radius:8px; padding:4px 9px; font-size:12px; cursor:pointer; }
.theme-toggle:hover { color:var(--fg); border-color:var(--accent); }
.nav-toggle { display:none; }
mark { background:var(--mark); color:inherit; border-radius:3px; padding:0 2px; }
code { background:var(--code); padding:1px 5px; border-radius:4px; font-size:13.5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
pre code { background:none; padding:0; }
table { border-collapse:collapse; width:100%; margin:14px 0; font-size:14.5px; }
th,td { border:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top; }
th { background:var(--code); }
blockquote { margin:14px 0; padding:8px 14px; border-left:3px solid var(--accent); background:var(--code); color:var(--muted); }
hr { border:0; border-top:1px solid var(--line); margin:28px 0; }
.note { color:var(--muted); font-size:14px; }
.search { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px; font-size:14px; background:var(--bg); color:var(--fg); }
kbd { border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 4px; font-size:11.5px; color:var(--muted); }
#results { margin-top:8px; font-size:14px; } #results a { display:block; padding:3px 6px; border-radius:5px; }
@media (max-width:900px) {
  .layout { grid-template-columns:1fr; }
  aside { position:static; height:auto; border-right:0; border-bottom:1px solid var(--line); }
  /* 移动端：导航默认收起（否则一屏全是链接），用"导航"按钮展开 —— 零 JS 依赖的骨架 + 一点脚本 */
  aside nav, aside .nav-body { display:none; }
  body.nav-open aside nav, body.nav-open aside .nav-body { display:block; }
  .nav-toggle { display:inline-block; margin:8px 0; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:6px 12px; font-size:14px; cursor:pointer; }
  main { padding:20px; }
  .pager { flex-direction:column; } .pager a { max-width:none; } .pager .next { margin-left:0; text-align:left; }
}
`;

const SEARCH_SCRIPT = `
// ---- 主题：system 默认 + 手动切换（记住选择）。与官网首页同一套做法 ----
const root = document.documentElement;
try {
  const saved = localStorage.getItem('actor-docs-theme');
  if (saved) root.dataset.theme = saved;
} catch {}
const themeButton = document.querySelector('[data-theme-toggle]');
if (themeButton) {
  const label = () => (root.dataset.theme === 'dark' ? '☀ 浅色' : '☾ 深色');
  themeButton.textContent = label();
  themeButton.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    themeButton.textContent = label();
    try { localStorage.setItem('actor-docs-theme', root.dataset.theme); } catch {}
  });
}

// ---- 移动端：导航折叠 ----
const navToggle = document.querySelector('[data-nav-toggle]');
navToggle?.addEventListener('click', () => document.body.classList.toggle('nav-open'));

// ---- 代码块复制按钮：每个 pre.code 一个（不改动代码文本） ----
for (const block of document.querySelectorAll('pre.code')) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-code';
  button.textContent = '复制';
  button.addEventListener('click', async () => {
    const code = block.querySelector('code');
    try {
      await navigator.clipboard.writeText(code ? code.textContent : '');
      button.textContent = '已复制'; button.classList.add('done');
    } catch { button.textContent = '复制失败'; }
    setTimeout(() => { button.textContent = '复制'; button.classList.remove('done'); }, 1600);
  });
  block.appendChild(button);
}

// ---- 搜索：输入过滤 + 命中高亮；按 "/" 或 Ctrl/Cmd+K 聚焦 ----
const input = document.getElementById('search');
const results = document.getElementById('results');
let index = [];
fetch(window.__ROOT__ + 'search.json').then((r) => r.json()).then((data) => { index = data; }).catch(() => {});
const escapeHtml = (text) => text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const highlight = (text, query) => {
  const at = text.toLowerCase().indexOf(query);
  if (at === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, at)) + '<mark>' + escapeHtml(text.slice(at, at + query.length)) + '</mark>' + escapeHtml(text.slice(at + query.length));
};
const render = () => {
  const query = (input?.value ?? '').trim().toLowerCase();
  results.innerHTML = '';
  if (query.length < 2) return;
  for (const page of index.filter((page) => page.text.includes(query)).slice(0, 12)) {
    const link = document.createElement('a');
    link.href = window.__ROOT__ + page.url;
    // 命中处前后各留一点上下文，并把关键词标出来（不用点进去也知道为什么命中）
    const at = page.text.indexOf(query);
    const snippet = at === -1 ? '' : page.text.slice(Math.max(0, at - 24), at + query.length + 36).replace(/\s+/g, ' ');
    link.innerHTML = highlight(page.title + ' · ' + page.group, query) + (snippet === '' ? '' : '<br><small>' + highlight(snippet, query) + '…</small>');
    results.appendChild(link);
  }
};
input?.addEventListener('input', render);
document.addEventListener('keydown', (event) => {
  const typing = /^(input|textarea)$/i.test(document.activeElement?.tagName ?? '');
  if ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
    event.preventDefault();
    input?.focus();
  }
  if (event.key === 'Escape' && document.activeElement === input) { input.blur(); }
});
`;

function layout({ title, body, nav, currentUrl, rootPrefix, toc, order = [], group = '' }) {
  const navHtml = [...nav.keys()]
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
  // 上一篇 / 下一篇：顺序直接取自 docs/nav.json 的导航顺序
  const position = order.findIndex((entry) => entry.url === currentUrl);
  const previous = position > 0 ? order[position - 1] : null;
  const next = position >= 0 && position < order.length - 1 ? order[position + 1] : null;
  const pagerHtml =
    previous === null && next === null
      ? ''
      : `<div class="pager">${
          previous === null
            ? '<span></span>'
            : `<a class="prev" href="${rootPrefix}${previous.url}"><span>← 上一篇</span>${escapeHtml(previous.title)}</a>`
        }${
          next === null ? '' : `<a class="next" href="${rootPrefix}${next.url}"><span>下一篇 →</span>${escapeHtml(next.title)}</a>`
        }</div>`;
  const crumbsHtml =
    group === ''
      ? `<div class="crumbs"><a href="${rootPrefix}index.html">官网首页</a> / ${escapeHtml(title)}</div>`
      : `<div class="crumbs"><a href="${rootPrefix}index.html">官网首页</a> / ${escapeHtml(group)} / ${escapeHtml(title)}</div>`;
  const navBody = `<nav>${navHtml}${tocHtml}</nav>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><div class="layout">
<aside>
  <button class="theme-toggle" data-theme-toggle type="button" aria-label="切换深浅色">☾ 深色</button>
  <div class="brand">Actor Framework<small>文档与 API 参考</small></div>
  <ul><li><a href="${rootPrefix}index.html">← 官网首页</a></li></ul>
  <button class="nav-toggle" data-nav-toggle type="button" aria-label="展开导航">导航 ▾</button>
  <input class="search" id="search" placeholder="搜索文档…（按 / 聚焦）" autocomplete="off">
  <div id="results"></div>
  ${navBody}
</aside>
<main>${crumbsHtml}${body}${pagerHtml}</main>
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
    pages.push({ relative, markdown, title: titleOf(markdown, relative) });
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

  // 导航：顺序与分组全部来自 docs/nav.json
  const navConfig = loadNav();
  const { groups, unregistered } = groupPages(pages, navConfig);
  if (unregistered.length > 0) {
    log(`doc site: 以下页面没有登记进 docs/nav.json，已落到「${navConfig.fallback}」末尾：${unregistered.join(', ')}`);
  }
  const glossaryTerms = loadGlossaryTerms();
  const nav = new Map();
  /** 每页在导航里的位置（供"上一篇/下一篇"与面包屑用）。 */
  const order = [];
  for (const layer of navConfig.layers) {
    const entries = groups.get(layer.title).map((page) => ({
      // 侧边栏标签优先用 nav.json 的短标题（页面 H1 往往很长，侧边栏扫不动）
      title: navConfig.titles.get(page.relative) ?? page.title,
      group: layer.title,
      url: urlFor(page.relative),
    }));
    if (entries.length === 0) continue;
    nav.set(layer.title, entries);
    order.push(...entries);
  }
  const navOrder = new Map(order.map((entry, index) => [entry.url, index]));
  /** 由 url 反查所属层名（面包屑用）。 */
  const navGroupOf = (url) => order.find((entry) => entry.url === url)?.group ?? '';

  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  const searchIndex = [];
  for (const page of pages) {
    const url = urlFor(page.relative);
    const depth = url.split('/').length - 1;
    const rootPrefix = depth === 0 ? './' : '../'.repeat(depth);
    const { html: rawHtml, headings } = renderMarkdown(page.markdown, { linkFor: (href) => relativeLinkFor(page.relative, href) });
    // 首现术语自动链到术语表（术语表自己不链，避免自指）
    const html =
      page.relative === 'docs/glossary.md'
        ? rawHtml
        : linkGlossaryTerms(rawHtml, { ...glossaryTerms }, { rootPrefix });
    const outFile = path.join(OUT, url);
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await fsp.writeFile(
      outFile,
      layout({
        title: page.title,
        body: html,
        nav,
        currentUrl: url,
        rootPrefix,
        toc: headings,
        order,
        group: navGroupOf(url),
      }),
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
        layout({ title: page.title, body: html, nav, currentUrl: indexUrl, rootPrefix, toc: headings, order, group: navGroupOf(indexUrl) }),
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
      order: [...order, { title: 'API 参考', group: '参考', url: 'api.html' }],
      group: '参考',
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
  return {
    pages: pages.length,
    broken,
    landing: { snippets: landing.snippets, broken: landingBroken },
    // 导航自检（门禁用）：层数与"没登记进 nav.json"的页面
    navLayers: nav.size,
    unregistered,
  };
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
