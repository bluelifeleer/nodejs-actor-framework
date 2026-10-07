/**
 * 固化能力闭包：把"各包真实依赖"写成 `templates/capabilities.json`（对外发布时用）。
 *
 * 为什么要固化：CLI 发布出去以后读不到 monorepo 里各包的 package.json，
 * 而闭包又不能手写（一定会烂）。所以仓库里跑一次这个脚本，并有一条测试断言
 * "固化结果 == 真实依赖"（`packages/cli/test/capabilities.test.ts`）。
 *
 *   node packages/cli/src/freeze-capabilities.ts     # 或 npm run capabilities:freeze
 */

import fs from 'node:fs';
import path from 'node:path';

import { CAPABILITY_PACKAGES, type FrozenCapabilities } from './capabilities.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const OUT = path.join(import.meta.dirname, '..', 'templates', 'capabilities.json');
/** 固化范围：能力包 + 它们的依赖（闭包可能跨到 resource/db-core 这类地基包）。 */
const SEEDS = [...Object.values(CAPABILITY_PACKAGES), '@actor/resource', '@actor/db-core', '@actor/core'];

function readPackage(name: string): { name: string; dependencies: string[] } | null {
  const dir = name.replace('@actor/', '');
  const file = path.join(ROOT, 'packages', dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; dependencies?: Record<string, string> };
  if (pkg.name !== name) return null;
  return { name, dependencies: Object.keys(pkg.dependencies ?? {}).sort() };
}

const collected = new Map<string, { name: string; dependencies: string[] }>();
const queue = [...SEEDS];
while (queue.length > 0) {
  const name = queue.shift() as string;
  if (collected.has(name)) continue;
  const pkg = readPackage(name);
  if (pkg === null) continue; // 可选包可能不存在（例如干净检出里没装）
  collected.set(name, pkg);
  for (const dependency of pkg.dependencies) {
    if (dependency.startsWith('@actor/') && !collected.has(dependency)) queue.push(dependency);
  }
}

const frozen: FrozenCapabilities = {
  generatedBy: 'node packages/cli/src/freeze-capabilities.ts',
  packages: [...collected.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
fs.writeFileSync(OUT, `${JSON.stringify(frozen, null, 2)}\n`, 'utf8');
console.log(`已固化 ${frozen.packages.length} 个包 → ${path.relative(ROOT, OUT)}`);
