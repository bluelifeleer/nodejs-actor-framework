import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ROOT,
  KERNEL_DECLARATION_FILE,
  checkDeclarationDrift,
  checkDocumentedMembers,
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

test('kernel surface: 手写声明与源码不漂移（类别 + 函数参数个数）', async () => {
  const names = await runtimeExports();
  const drift = checkDeclarationDrift({ root: ROOT, runtimeNames: names });

  assert.strictEqual(drift.ok, true, `声明与源码漂移：${JSON.stringify(drift.findings)}`);
  assert.ok(drift.compared >= 20, `至少要能比对 20 项（实际 ${drift.compared}）——比不动就说明提取器退化了`);
});

test('kernel surface: 漂移门禁能证伪 —— 声明里少写一个参数必须报出来', async () => {
  // 注入一份**故意写错**的声明文件：`createSystem(options, extra)` 比源码多一个参数。
  const broken = fs.mkdtempSync(path.join(ROOT, '.tmp-drift-'));
  try {
    const real = fs.readFileSync(path.join(ROOT, 'packages/core/src/index.d.ts'), 'utf8');
    const tampered = real.replace(
      'export function createSystem(options?: SystemOptions): ActorSystem;',
      'export function createSystem(options?: SystemOptions, extra?: string): ActorSystem;',
    );
    assert.notStrictEqual(tampered, real, '夹具必须真的改到了那一行（否则这条测试是空转）');
    fs.writeFileSync(path.join(broken, 'index.d.ts'), tampered);

    const names = await runtimeExports();
    const drift = checkDeclarationDrift({
      root: ROOT,
      runtimeNames: names,
      declarationFile: path.relative(ROOT, path.join(broken, 'index.d.ts')),
    });

    assert.strictEqual(drift.ok, false);
    assert.deepStrictEqual(
      drift.findings.map((finding) => finding.name),
      ['createSystem'],
    );
    assert.match(drift.findings[0].reason, /参数个数不同/);
  } finally {
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test('kernel surface: 用户文档代码块里用到的内核成员都必须在 index.d.ts 里有声明', () => {
  // 用户文档 = 根 README + quickstart + 指南主线 + internals 旧指南（两层都算：
  // 那些页面里的 `ctx.xxx` 同样是"使用者照着写的" —— 而且可证伪用例的锚点 `ctx.sleep` 就在 internals 里）
  const guideDirs = ['docs/guide', 'docs/guide/internals', 'docs/guide/reference'];
  const files = [
    'README.md',
    'docs/quickstart.md',
    ...guideDirs.flatMap((dir) =>
      fs
        .readdirSync(path.join(ROOT, dir))
        .filter((name) => name.endsWith('.md'))
        .map((name) => `${dir}/${name}`),
    ),
  ];
  const docs = files.map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
  const declaration = fs.readFileSync(path.join(ROOT, KERNEL_DECLARATION_FILE), 'utf8');

  // web 的请求上下文也叫 ctx（与内核 actor 上下文重名）→ 把它的成员也算"已声明"
  const webRequestContext = fs.readFileSync(path.join(ROOT, 'packages/web/src/context.ts'), 'utf8');
  const missing = checkDocumentedMembers(docs, declaration, { extraDeclared: webRequestContext });
  assert.deepStrictEqual(
    missing,
    [],
    `这些成员在文档里被使用者照着写，却没有类型声明：\n${missing.map((m) => `  ${m.member}  ← ${m.file}`).join('\n')}`,
  );

  // 可证伪：把 ctx.sleep 的声明删掉，门禁必须报出来
  const tampered = declaration.replace(/\n\s*sleep\(ms: number\): Promise<void>;/, '');
  assert.notStrictEqual(tampered, declaration, '证伪用的锚点没匹配上（测试自己失效了）');
  const caught = checkDocumentedMembers(docs, tampered, { extraDeclared: webRequestContext }).map((m) => m.member);
  assert.ok(caught.includes('sleep'), `删掉声明后门禁没有抓到：${JSON.stringify(caught)}`);
});
