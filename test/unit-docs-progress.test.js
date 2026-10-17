import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 设计文档的**进度标记**门禁。
 *
 * 为什么需要：`docs/design/**` 里用 ✅/⏳ 表示"做了 / 没做"。这类标记会**过时**——
 * 实测发现 7 处 ⏳ 标的是**已经实现**的东西（乐观锁、迁移/Outbox/投影、哈希环、`actor migrate`/`doctor`…），
 * 读者（和未来的自己）会据此误判"还没做"。而标记本身没法自动判断真假，所以这里用"**显式登记 + 双向核对**"：
 *
 *   1. 任何出现 ⏳ 的文档都必须在 `docs/design/progress.json` 里登记（只含 ✅ 的不管：那是历史记录）；
 *   2. `status: "implemented"` 的文档**不允许**再有 ⏳，且必须带"进度标记反映现状"的横幅；
 *   3. `status: "frozen"` 的文档必须带"历史快照"横幅 + `frozenAt`，且 `authoritative` 指向真实文件；
 *   4. `status: "live"` 的文档里**每个 ⏳ 都要有 `openItems` 条目**，且每个 `openItems` 都必须仍在文档里出现
 *      （双向）—— 于是"新加一个 ⏳"必须连带登记，而"做完了忘删 ⏳"会被第 4 条的右半边抓住。
 */

const ROOT = path.join(import.meta.dirname, '..');
const REGISTRY = path.join(ROOT, 'docs', 'design', 'progress.json');
const DESIGN_DIR = path.join(ROOT, 'docs', 'design');

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** 递归列出 docs/design 下所有 md（含 m0/ 子目录）。 */
function designDocs(dir = DESIGN_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...designDocs(full));
    else if (entry.name.endsWith('.md')) out.push(path.relative(ROOT, full));
  }
  return out.sort();
}

test('进度标记: 登记表结构正确，且登记的文件都存在（authoritative 也必须是登记过的 live 文档）', () => {
  assert.ok(fs.existsSync(REGISTRY), 'docs/design/progress.json 必须存在（进度标记的唯一登记处）');
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const entries = registry.documents ?? [];
  assert.ok(entries.length >= 4, `登记太少（${String(entries.length)}），机制可能失效`);

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.strictEqual(byPath.size, entries.length, '同一个文档不能登记两次');

  for (const entry of entries) {
    assert.ok(fs.existsSync(path.join(ROOT, entry.path)), `登记的文件不存在：${entry.path}`);
    assert.ok(['implemented', 'frozen', 'live'].includes(entry.status), `${entry.path} 的 status 不合法：${String(entry.status)}`);
    if (entry.status === 'frozen') {
      assert.ok(typeof entry.frozenAt === 'string' && entry.frozenAt !== '', `${entry.path} 是历史快照，必须写 frozenAt`);
    }
    if (entry.status === 'live') {
      assert.ok(Array.isArray(entry.openItems), `${entry.path} 是 live 文档，必须显式给 openItems（可以是空数组）`);
    }
    if (entry.status === 'implemented') {
      // "已完成"的文档要说清"现状以谁为准"，且那个文件自己也必须是登记过的 live 文档
      assert.ok(typeof entry.authoritative === 'string', `${entry.path} 要给出 authoritative（现状以谁为准）`);
      const authority = byPath.get(entry.authoritative);
      assert.ok(authority !== undefined, `${entry.path} 的 authoritative 没登记：${entry.authoritative}`);
      assert.strictEqual(authority.status, 'live', `authoritative 必须是 live 文档：${entry.authoritative}`);
    }
  }
});

test('进度标记: 出现 ⏳ 的设计文档都必须登记（✅ 是历史记录，不在管辖范围）', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const registered = new Set((registry.documents ?? []).map((entry) => entry.path));
  const offenders = [];
  for (const relative of designDocs()) {
    const markdown = read(relative);
    // 只管 ⏳：它表示还没做，过时就会让人误判；✅ 只是做完的记录。
    const hasMark = markdown.includes('⏳');
    if (hasMark && !registered.has(relative)) offenders.push(relative);
  }
  assert.deepStrictEqual(offenders, [], `这些文档用了进度标记但没登记（会过时且无人核对）：\n  ${offenders.join('\n  ')}`);
});

test('进度标记: "已完成"的文档里不许再有 ⏳，且必须带"反映现状"的横幅', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const problems = [];
  for (const entry of registry.documents ?? []) {
    if (entry.status !== 'implemented') continue;
    const markdown = read(entry.path);
    if (markdown.includes('⏳')) {
      const line = markdown.split('\n').find((text) => text.includes('⏳'));
      problems.push(`${entry.path} 登记为已完成，却还有 ⏳：${String(line).trim().slice(0, 80)}`);
    }
    if (!markdown.includes('进度标记')) {
      problems.push(`${entry.path} 缺少"进度标记反映现状"的横幅（读者无从判断标记的含义）`);
    }
  }
  assert.deepStrictEqual(problems, [], problems.join('\n  '));
});

test('进度标记: 历史快照必须有横幅 + frozenAt，且横幅指向真实的现状文档', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const problems = [];
  for (const entry of registry.documents ?? []) {
    if (entry.status !== 'frozen') continue;
    const markdown = read(entry.path);
    if (!markdown.includes('历史快照')) problems.push(`${entry.path} 是历史快照，但正文里没有"历史快照"横幅`);
    const authority = path.join(ROOT, entry.authoritative ?? '');
    if (!fs.existsSync(authority)) problems.push(`${entry.path} 的 authoritative 不存在：${String(entry.authoritative)}`);
    // 横幅里要真的链到 authoritative（不能只写一句话）
    const basename = path.basename(entry.authoritative ?? '');
    if (!markdown.includes(basename)) problems.push(`${entry.path} 的横幅没有链到 ${basename}`);
  }
  assert.deepStrictEqual(problems, [], problems.join('\n  '));
});

test('进度标记: live 文档里的每个 ⏳ 都必须登记，且登记的条目必须真的还在（双向）', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const problems = [];
  for (const entry of registry.documents ?? []) {
    if (entry.status !== 'live') continue;
    const markdown = read(entry.path);
    const items = entry.openItems ?? [];

    // 左半边：文档里的每个 ⏳ 都要有对应登记
    for (const line of markdown.split('\n')) {
      if (!line.includes('⏳')) continue;
      const matched = items.some((item) => line.includes(item.text));
      if (!matched) problems.push(`${entry.path} 有未登记的 ⏳：${line.trim().slice(0, 90)}`);
    }
    // 右半边：登记过的条目必须仍在文档里（做完了要删标记 + 删登记）
    for (const item of items) {
      if (!markdown.includes(item.text)) {
        problems.push(`${entry.path} 登记的未完成项已经不在文档里了（做完了？请同时删掉 progress.json 的条目）：${item.text}`);
      }
    }
  }
  assert.deepStrictEqual(problems, [], problems.join('\n  '));
});

test('进度标记: 门禁能证伪 —— 造一个"有 ⏳ 却没登记"的 live 文档必须被抓到', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const live = (registry.documents ?? []).find((entry) => entry.status === 'live');
  assert.ok(live !== undefined, '至少要有一个 live 文档，否则这条证伪用例没有对象');

  // 只做**内存里**的模拟：把一条未登记的 ⏳ 行喂给与上面相同的判定逻辑
  const line = '| 某件事 | ⏳ | 还没做 |';
  const items = live.openItems ?? [];
  const matched = items.some((item) => line.includes(item.text));
  assert.strictEqual(matched, false, '未登记的 ⏳ 行不该被误判成已登记');
});
