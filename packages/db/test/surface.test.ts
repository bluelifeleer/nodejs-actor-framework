import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkPublicSurface } from '../../../tools/api-extract.mjs';

/**
 * `@actor/db` 自己的**公开面门禁**：运行时导出的每一个名字，都必须在手写的 `src/index.d.ts` 里声明。
 *
 * 为什么必须有：`index.d.ts` 是使用者看到的类型、运行时导出才是真相。两者漂移时**没有任何测试会变红**，
 * 使用者要么拿到不存在的类型，要么拿到 `any`。内核有同样的门禁（`test/unit-kernel-surface.test.js`），
 * 新包不能因为"刚建的"就少一道。
 */
const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const DECLARATION = 'packages/db/src/index.d.ts';

async function runtimeExportNames(): Promise<string[]> {
  const mod = (await import(pathToFileURL(path.join(ROOT, 'packages/db/src/index.ts')).href)) as Record<string, unknown>;
  return Object.keys(mod).filter((name) => name !== 'default').sort();
}

test('db surface: 每个运行时导出都在 index.d.ts 里有声明', async () => {
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

test('db surface: 门禁能证伪 —— 从声明里删掉一个导出必须被报出来', async () => {
  const names = await runtimeExportNames();
  const declarationFile = path.join(ROOT, DECLARATION);
  const original = fs.readFileSync(declarationFile, 'utf8');
  const tampered = original.replace(/export declare function createDatabase\(/, 'declare function createDatabase(');
  assert.notStrictEqual(tampered, original, '证伪用的锚点没匹配上（测试自己失效了）');
  // checkPublicSurface 读文件，所以这里用一个临时目录放"被改过的声明"
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'db-surface-'));
  try {
    fs.mkdirSync(path.join(tmp, 'packages', 'db', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, DECLARATION), tampered);
    const result = checkPublicSurface({ root: tmp, runtimeNames: names, declarationFile: DECLARATION });
    assert.deepStrictEqual(result.missing, ['createDatabase'], `删掉声明后应当只报 createDatabase，实际：${result.missing.join(', ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
