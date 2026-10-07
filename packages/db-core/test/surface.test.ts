import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkPublicSurface } from '../../../tools/api-extract.mjs';

/**
 * `@actor/db-core` 自己的**公开面门禁**：运行时导出的每个名字都必须在手写的 `src/index.d.ts` 里声明。
 * （与内核、`@actor/db` 同一道门禁 —— 新包不能因为"刚建的"就少一道。）
 */
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const DECLARATION = 'packages/db-core/src/index.d.ts';

async function runtimeExportNames(): Promise<string[]> {
  const mod = (await import(pathToFileURL(path.join(ROOT, 'packages/db-core/src/index.ts')).href)) as Record<string, unknown>;
  return Object.keys(mod).filter((name) => name !== 'default').sort();
}

test('db-core surface: 每个运行时导出都在 index.d.ts 里有声明', async () => {
  const names = await runtimeExportNames();
  assert.ok(names.length > 0, '没有取到任何运行时导出（测试前提不成立）');
  const result = checkPublicSurface({ root: ROOT, runtimeNames: names, declarationFile: DECLARATION });
  assert.deepStrictEqual(
    result.missing,
    [],
    `这些导出没有类型声明：${result.missing.join(', ')}（声明面 ${DECLARATION}）`,
  );
  assert.strictEqual(result.declared, result.total);
});

test('db-core surface: 门禁能证伪 —— 从声明里删掉一个导出必须被报出来', async () => {
  const names = await runtimeExportNames();
  const declarationFile = path.join(ROOT, DECLARATION);
  const original = fs.readFileSync(declarationFile, 'utf8');
  // 注意：泛型函数在 `supervise` 与 `(` 之间还有 `<…>`，所以不能写成 `supervise\(`
  const tampered = original.replace(/export declare function supervise\b/, 'declare function supervise');
  assert.notStrictEqual(tampered, original, '证伪用的替换没生效（声明面里没有 supervise？）');
  fs.writeFileSync(declarationFile, tampered);
  try {
    const result = checkPublicSurface({ root: ROOT, runtimeNames: names, declarationFile: DECLARATION });
    assert.ok(result.missing.includes('supervise'), `门禁抓不到缺失的声明：${JSON.stringify(result.missing)}`);
  } finally {
    fs.writeFileSync(declarationFile, original);
  }
});
