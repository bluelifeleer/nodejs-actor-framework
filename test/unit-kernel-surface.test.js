import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ROOT,
  checkPublicSurface,
  extractFromDeclarationFile,
  kernelUntypedFiles,
} from '../tools/api-extract.mjs';

/**
 * 内核公开面与类型覆盖的**门禁**。
 *
 * 为什么需要它：`index.d.ts` 是使用者看到的类型、运行时导出才是真正存在的 API，两者漂移时
 * **没有任何测试会变红**（使用者要么拿到不存在的类型，要么拿到 `any`）。同样，"某个文件还带
 * `@ts-nocheck`"也不会让任何测试变红，却意味着严格检查有盲区。
 *
 * 门禁自己也要能被证伪：下面同时验证"喂假数据时必须报缺"。
 */

const KERNEL_ENTRY = path.join(ROOT, 'packages/core/src/index.ts');

async function runtimeExports() {
  const module = await import(pathToFileURL(KERNEL_ENTRY).href);
  const exported = module.default && typeof module.default === 'object' ? module.default : module;
  return Object.keys(exported).filter((key) => key !== 'default' && key !== '__esModule');
}

test('kernel surface: 每个运行时导出都在 index.d.ts 里有声明（34/34）', async () => {
  const names = await runtimeExports();
  const surface = checkPublicSurface({ root: ROOT, runtimeNames: names });

  assert.strictEqual(surface.ok, true, `缺少声明的导出：${surface.missing.join(', ')}`);
  assert.strictEqual(surface.declared, surface.total);
  assert.ok(surface.total >= 34, `运行时导出应当 >= 34，实际 ${surface.total}`);
  assert.strictEqual(surface.declarationFile, 'packages/core/src/index.d.ts');
});

test('kernel surface: 门禁能证伪 —— 多一个没有声明的导出必须报缺', async () => {
  const names = await runtimeExports();
  const broken = checkPublicSurface({ root: ROOT, runtimeNames: [...names, 'thisExportDoesNotExist'] });

  assert.strictEqual(broken.ok, false);
  assert.deepStrictEqual(broken.missing, ['thisExportDoesNotExist']);
  assert.strictEqual(broken.declared, broken.total - 1);
});

test('kernel surface: 内核源码不再有 @ts-nocheck（严格检查无盲区）', () => {
  const untyped = kernelUntypedFiles(ROOT);
  assert.deepStrictEqual(
    untyped,
    [],
    `这些内核文件仍在跳过严格检查：${untyped.join(', ')}（补完类型后删掉该标记）`,
  );
});

test('kernel surface: 声明里的 abstract class 也要被提取到（曾漏过 Actor）', () => {
  const declared = extractFromDeclarationFile(path.join(ROOT, 'packages/core/src/index.d.ts')).found;
  const actor = declared.get('Actor');
  assert.ok(actor !== undefined, 'export abstract class Actor 必须被提取（门禁靠它判公开面完整）');
  assert.strictEqual(actor.kind, '类');
  // 泛型参数也要保留，否则 API 参考上会显示成无泛型的类
  assert.strictEqual(actor.signature ?? actor.returns, '实例');
});
