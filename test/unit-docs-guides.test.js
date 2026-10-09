import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const GUIDE_DIR = path.join(ROOT, 'docs', 'guide');
/**
 * 指南分两层（M9 文档改版）：
 *   - `docs/guide/*.md`            面向使用者的主线（快速上手 + 按任务 + 排错）；
 *   - `docs/guide/internals/*.md`  按里程碑写的旧指南（开发/设计视角，原样保留）；
 *   - `docs/guide/reference/*.md`  查阅型页面。
 * 两层都算"指南"，都要有标题与可执行示例 —— 只是索引规则不同（主线必须被 README 全量链上）。
 */
const MAIN_GUIDE_DIRS = [GUIDE_DIR];
const TMP = path.join(ROOT, '.tmp-docs-guides');

/**
 * 文档里的示例**必须真的能跑**。
 *
 * 这是"面向使用者的指南"唯一的可信度来源：示例编译不过、跑不通、断言失败，这条测试就红。
 * 约定：代码块的语言标记里带 `verify`（例如 ```js verify）表示"请执行我"。
 * 示例写成 ESM（`import`），因为它们要引用 `@actor/*`；文件落在仓库内的临时目录，
 * 这样 workspace 里的包名解析得到。
 */

/** 递归收集一个目录下的 .md（内部目录也算，见 MAIN_GUIDE_DIRS 的注释）。 */
function markdownFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/** 全部指南页（含 internals/ 与 reference/）—— 都要有标题 + verify 示例。 */
function allGuideFiles() {
  return markdownFiles(GUIDE_DIR);
}

/** 主线指南页（顶层，不含 README）—— 必须被索引页链上。 */
function guideFiles() {
  return fs
    .readdirSync(GUIDE_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => path.join(GUIDE_DIR, name));
}

const relativePath = (file) => path.relative(ROOT, file);

function verifiedSnippets(markdown) {
  const blocks = [];
  const lines = String(markdown).split('\n');
  let index = 0;
  while (index < lines.length) {
    const fence = /^```(\S.*)$/.exec(lines[index]);
    if (fence === null) {
      index += 1;
      continue;
    }
    const info = fence[1].trim();
    const body = [];
    index += 1;
    while (index < lines.length && !/^```\s*$/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    index += 1;
    if (info.split(/\s+/).includes('verify')) blocks.push({ info, code: body.join('\n') });
  }
  return blocks;
}

test('docs guides: 指南目录结构完整，每篇都有标题与验证示例', () => {
  const files = allGuideFiles();
  assert.ok(files.length >= 6, `指南太少：${files.length}`);
  assert.ok(fs.existsSync(path.join(GUIDE_DIR, 'README.md')), '指南要有索引页');

  for (const file of files) {
    const markdown = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.match(markdown, /^#\s+\S/m, `${name} 缺少一级标题`);
    if (name === 'README.md') continue;
    assert.ok(
      verifiedSnippets(markdown).length > 0,
      `${relativePath(file)} 里没有任何 \`verify\` 示例——指南的示例必须可执行`,
    );
  }
});

test('docs guides: 导航四层由 docs/nav.json 定义，且**每个页面恰好出现一次**', async () => {
  const navFile = path.join(ROOT, 'docs', 'nav.json');
  assert.ok(fs.existsSync(navFile), '导航要多一个显式来源 docs/nav.json（不再按目录结构猜）');
  const nav = JSON.parse(fs.readFileSync(navFile, 'utf8'));
  assert.deepStrictEqual(
    nav.layers.map((layer) => layer.title),
    ['开始', '按任务', '概念与设计', '参考'],
    '四层的名字与顺序是约定（开始/按任务/概念与设计/参考）',
  );

  // ① nav.json 里登记的每个路径都必须真实存在（写错路径不该静默消失）
  const listed = nav.layers.flatMap((layer) => (layer.pages ?? []).map((page) => page.path));
  for (const relative of listed) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `nav.json 登记的路径不存在：${relative}`);
  }
  assert.deepStrictEqual([...new Set(listed)].length, listed.length, 'nav.json 里不能有重复页面');

  // ② 每个**渲染出来的页面**都必须落在某一层里（未登记会落到最后一层，这里直接禁止）
  const { build } = await import('../tools/docs-site.mjs');
  const result = await build({ log: () => {} });
  assert.deepStrictEqual(
    result.unregistered ?? [],
    [],
    '有页面没有登记进 docs/nav.json（新页面要显式登记，别依赖"落到最后一层"）',
  );
  assert.ok(result.navLayers >= 4, `导航应当至少有四层，实际 ${String(result.navLayers)}`);
});

test('docs guides: 每篇主线页都有统一的头（你会得到/前置/耗时）与尾（下一步）', () => {
  for (const file of guideFiles()) {
    const name = path.basename(file);
    if (name === 'README.md') continue;
    const markdown = fs.readFileSync(file, 'utf8');
    const head = markdown.slice(0, 900);
    assert.match(head, /\*\*你会得到\*\*：\S/, `${name} 开头缺少「你会得到」`);
    assert.match(head, /\*\*前置\*\*：\S/, `${name} 开头缺少「前置」`);
    assert.match(head, /\*\*耗时\*\*：\S/, `${name} 开头缺少「耗时」`);

    const footer = /^## 下一步\s*$([\s\S]*)$/m.exec(markdown);
    assert.ok(footer !== null, `${name} 末尾缺少「## 下一步」一节`);
    const links = [...footer[1].matchAll(/\]\((\.\/[\w./-]+\.md)\)/g)].map((match) => match[1]);
    assert.ok(links.length >= 2, `${name} 的「下一步」至少给两个去处（实际 ${String(links.length)} 个）`);
    for (const link of links) {
      const target = path.resolve(path.dirname(file), link);
      assert.ok(fs.existsSync(target), `${name} 的「下一步」指向了不存在的文件：${link}`);
    }
  }
});

test('docs guides: 索引页把每一篇主线都链上了（不遗漏、不指向不存在的文件）', () => {
  const index = fs.readFileSync(path.join(GUIDE_DIR, 'README.md'), 'utf8');
  const linked = [...index.matchAll(/\]\(\.\/([\w.-]+\.md)\)/g)].map((match) => match[1]);
  const present = guideFiles()
    .map((file) => path.basename(file))
    .filter((name) => name !== 'README.md');
  assert.deepStrictEqual([...linked].sort(), [...present].sort(), '索引与实际文件不一致');
});

test('docs guides: internals/ 旧指南有子索引，且逐篇可达（不悬空）', () => {
  const internals = path.join(GUIDE_DIR, 'internals');
  const subIndex = path.join(internals, 'README.md');
  assert.ok(fs.existsSync(subIndex), 'internals/ 要有自己的索引页');
  const index = fs.readFileSync(subIndex, 'utf8');
  const linked = [...index.matchAll(/\]\(\.\/([\w.-]+\.md)\)/g)].map((match) => match[1]);
  const present = fs
    .readdirSync(internals)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort();
  assert.deepStrictEqual([...linked].sort(), present, 'internals 子索引与实际文件不一致');
  // 主线索引要能走到 internals（一层入口即可）
  const main = fs.readFileSync(path.join(GUIDE_DIR, 'README.md'), 'utf8');
  assert.match(main, /\]\(\.\/internals\/\)/, '主线索引要指向 internals/');
});

test('docs guides: 每个 `verify` 示例都真的执行（真内核、真文件、真断言）', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  let executed = 0;
  try {
    for (const file of allGuideFiles()) {
      const markdown = fs.readFileSync(file, 'utf8');
      const snippets = verifiedSnippets(markdown);
      for (const [position, snippet] of snippets.entries()) {
        // 文件名里带上子目录名，避免 internals/ 与主线重名（例如两边都有 03-*）
        const name = `${path.relative(GUIDE_DIR, file).replace(/[\\/]/g, '-').replace(/\.md$/, '')}-${position + 1}`;
        const target = path.join(TMP, `${name}.mjs`);
        fs.writeFileSync(target, snippet.code, 'utf8');
        try {
          await run(process.execPath, [target], { cwd: ROOT, timeout: 60_000 });
        } catch (err) {
          assert.fail(
            `示例 ${name} 执行失败（docs/guide/${path.basename(file)} 第 ${position + 1} 个 verify 块）:\n` +
              `${err.stdout ?? ''}${err.stderr ?? ''}`,
          );
        }
        executed += 1;
      }
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  assert.ok(executed >= 10, `执行的示例太少（${executed}）——指南不能只有文字`);
});
