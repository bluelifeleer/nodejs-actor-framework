import { fileURLToPath } from 'node:url';
/**
 * 构建后把**非 TS 资产**拷进 `dist/`。
 *
 * 为什么必须做这一步：`main.ts` 用 `new URL('./config', import.meta.url)` 定位配置目录，
 * 编译后 `dist/main.js` 会去找 `dist/config` —— 不拷就启动失败（实测过，报错是"配置目录不存在"）。
 * 这类"编译产物缺资产"是换到构建路线后最常见的第一个坑，所以在脚手架里就补齐，
 * 而不是留给使用者自己发现。
 *
 * 需要拷贝的：纯数据/配置类目录与文件（`config/` 里的 JSON、模板、证书、SQL 等）。
 * **不拷** `.ts`：那些已经编译成 `.js` 了。
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PROJECT = path.resolve(ROOT, '..');
const DIST = path.join(PROJECT, 'dist');

/** 要拷进 dist 的目录（相对项目根）。 */
const ASSET_DIRS = ['config'];

/** 目录里除了 .ts 以外还有别的文件吗？（有才值得拷） */
async function hasNonTsAssets(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (await hasNonTsAssets(path.join(dir, entry.name))) return true;
      continue;
    }
    if (!entry.name.endsWith('.ts')) return true;
  }
  return false;
}

/** 递归拷贝，跳过 .ts（已编译）与 .d.ts。 */
async function copyAssets(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyAssets(source, target);
      continue;
    }
    if (entry.name.endsWith('.ts')) continue;
    await cp(source, target);
  }
}

let copied = 0;
for (const relative of ASSET_DIRS) {
  const from = path.join(PROJECT, relative);
  try {
    if (!(await stat(from)).isDirectory()) continue;
  } catch {
    continue; // 没有这个目录就跳过（脚手架按能力生成，目录不一定存在）
  }
  if (!(await hasNonTsAssets(from))) continue;
  await copyAssets(from, path.join(DIST, relative));
  copied += 1;
}

console.log(`[build] 已拷贝非 TS 资产：${copied === 0 ? '（无）' : ASSET_DIRS.slice(0, copied).join(', ')} → dist/`);
