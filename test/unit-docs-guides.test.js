import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const GUIDE_DIR = path.join(ROOT, 'docs', 'guide');
const TMP = path.join(ROOT, '.tmp-docs-guides');

/**
 * 文档里的示例**必须真的能跑**。
 *
 * 这是"面向使用者的指南"唯一的可信度来源：示例编译不过、跑不通、断言失败，这条测试就红。
 * 约定：代码块的语言标记里带 `verify`（例如 ```js verify）表示"请执行我"。
 * 示例写成 ESM（`import`），因为它们要引用 `@actor/*`；文件落在仓库内的临时目录，
 * 这样 workspace 里的包名解析得到。
 */

function guideFiles() {
  return fs
    .readdirSync(GUIDE_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => path.join(GUIDE_DIR, name));
}

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
  const files = guideFiles();
  assert.ok(files.length >= 3, `指南太少：${files.length}`);
  assert.ok(fs.existsSync(path.join(GUIDE_DIR, 'README.md')), '指南要有索引页');

  for (const file of files) {
    const markdown = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.match(markdown, /^#\s+\S/m, `${name} 缺少一级标题`);
    if (name === 'README.md') continue;
    assert.ok(
      verifiedSnippets(markdown).length > 0,
      `${name} 里没有任何 \`verify\` 示例——指南的示例必须可执行`,
    );
  }
});

test('docs guides: 索引页把每一篇都链上了（不遗漏、不指向不存在的文件）', () => {
  const index = fs.readFileSync(path.join(GUIDE_DIR, 'README.md'), 'utf8');
  const linked = [...index.matchAll(/\]\(\.\/([\w.-]+\.md)\)/g)].map((match) => match[1]);
  const present = guideFiles()
    .map((file) => path.basename(file))
    .filter((name) => name !== 'README.md');
  assert.deepStrictEqual([...linked].sort(), [...present].sort(), '索引与实际文件不一致');
});

test('docs guides: 每个 `verify` 示例都真的执行（真内核、真文件、真断言）', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  let executed = 0;
  try {
    for (const file of guideFiles()) {
      const markdown = fs.readFileSync(file, 'utf8');
      const snippets = verifiedSnippets(markdown);
      for (const [position, snippet] of snippets.entries()) {
        const name = `${path.basename(file, '.md')}-${position + 1}`;
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
  assert.ok(executed >= 5, `执行的示例太少（${executed}）——指南不能只有文字`);
});
