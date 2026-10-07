import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 分层门禁：**按适配器 kind 分支**只允许出现在各包的 `src/adapters/` 目录里。
 *
 * 与既有的"方言门禁"（`dialects/` 之外不得按方言名分支）同构 —— 这条是它在"非 SQL 数据库"上的对偶：
 * 一旦有人把 `if (kind === 'redis')` 写进 `plugin.ts` / `model.ts` / `repository.ts`，
 * "加一个适配器只写一个文件"就废了。
 *
 * 现状：还没有 adapters 目录（M7c/M7d 才加）→ 门禁现在应当**通过且为空**，
 * 这条测试的价值在于"以后不许长歪" + 证伪用例证明它真的会拦。
 */
const ROOT = path.join(import.meta.dirname, '..', '..', '..');

/** 计划中的适配器 kind（SQL 走既有方言门禁，不在这里重复）。 */
const KINDS = ['redis', 'ioredis', 'mongodb'] as const;

/** 收集所有需要扫描的源文件（跳过 adapters 目录、node_modules、dist）。 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'adapters') continue; // 适配器自己的目录：允许按 kind 分支
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 找出"按 kind 分支"的地方（比较/switch 到 kind 字面量）。 */
export function findKindBranches(source: string, kinds: readonly string[] = KINDS): string[] {
  const hits: string[] = [];
  for (const kind of kinds) {
    const pattern = new RegExp(`(===|!==)\\s*'${kind}'|'${kind}'\\s*(===|!==)|case\\s+'${kind}'`, 'g');
    for (const match of source.matchAll(pattern)) hits.push(match[0]);
  }
  return hits;
}

test('kind gate: adapters/ 之外不得按适配器 kind 分支', () => {
  const packagesDir = path.join(ROOT, 'packages');
  const offenders: string[] = [];
  for (const pkg of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = path.join(packagesDir, pkg.name, 'src');
    if (!fs.existsSync(srcDir)) continue;
    for (const file of sourceFiles(srcDir)) {
      const hits = findKindBranches(fs.readFileSync(file, 'utf8'));
      if (hits.length > 0) offenders.push(`${path.relative(ROOT, file)}: ${hits.join(', ')}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `适配器 kind 的分支必须待在 <package>/src/adapters/ 里，别处不许点名 kind：\n${offenders.join('\n')}`,
  );
});

test('kind gate: 门禁能证伪（喂坏代码必须被抓到，方言名不算 kind）', () => {
  assert.deepStrictEqual(findKindBranches("if (kind === 'redis') return client;"), ["=== 'redis'"]);
  assert.deepStrictEqual(findKindBranches("switch (kind) { case 'mongodb': break; }"), ["case 'mongodb'"]);
  assert.deepStrictEqual(findKindBranches("const x = 'ioredis' === kind;"), ["'ioredis' ==="]);
  assert.deepStrictEqual(findKindBranches("if (dialect === 'mysql') return x;"), [], '方言名不是适配器 kind');
  assert.deepStrictEqual(findKindBranches("const text = 'redis://localhost';"), [], '普通字符串不算分支');
});
