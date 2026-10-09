#!/usr/bin/env node
/**
 * 把各包的 `src/*.ts` 编译成 `dist/*.js`（发布形态；仓库内跑测试不需要它）。
 *
 *   node tools/build-packages.mjs                 # 构建全部（按依赖顺序）
 *   node tools/build-packages.mjs --package .     # 只构建当前包（各包 prepublishOnly 用）
 *   node tools/build-packages.mjs --check         # 只检查：dist 是否存在、是否比 src 旧、exports 目标是否齐
 *
 * **一次构建**：`tsc -b tsconfig.build.json` 走项目引用（9 个 @actor/* 包，顺序由引用图决定）；
 * **内核单独编译**：它的声明面是**手写的** `src/index.d.ts`，不进引用图（composite 要求生成声明，
 * 为它开例外反而更难懂），所以用单包 `tsc -p packages/core/tsconfig.build.json`。
 *
 * **CJS 包的额外一步**：内核是手写 CJS，源码里全是 `require('./x.ts')`。TypeScript 的
 * `rewriteRelativeImportExtensions` **只改写 import/export/import() 的说明符，不管 require() 调用**
 * （实测：编译出的 dist/index.js 里仍是 `require('./actor/actor.ts')`，运行时直接
 * "Cannot find module"）。所以对 CJS 包在编译后做一次**确定性改写**：
 * 只把 `require('./相对路径.ts')` 里的扩展名换成 `.js`，其它一律不动；门禁断言 dist 里不残留 `.ts` 说明符。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** 依赖顺序：被依赖的排前面（跨包 import 用 development 条件解析源码，顺序只影响报错可读性）。 */
const PACKAGES = [
  { dir: 'packages/core', name: 'nodejs-actor-framework', cjs: true },
  { dir: 'packages/resource', name: '@actor/resource' },
  { dir: 'packages/data', name: '@actor/data' },
  { dir: 'packages/app', name: '@actor/app' },
  { dir: 'packages/web', name: '@actor/web' },
  { dir: 'packages/db-core', name: '@actor/db-core' },
  { dir: 'packages/db', name: '@actor/db' },
  { dir: 'packages/redis', name: '@actor/redis' },
  { dir: 'packages/mongodb', name: '@actor/mongodb' },
  { dir: 'packages/mail', name: '@actor/mail' },
];

const args = process.argv.slice(2);
const only = args.includes('--package') ? args[args.indexOf('--package') + 1] : undefined;
const checkOnly = args.includes('--check');

/**
 * 把 CJS 产物里 `require('./x.ts')` 的扩展名改成 `.js`。
 *
 * 只匹配**相对路径 + 字面量说明符**：`require(resolved)` 这种计算型调用一律不碰
 * （内核里只有两处，都是运行时算出来的路径，与扩展名无关）。
 */
function rewriteCjsRequires(pkg) {
  const dist = path.join(ROOT, pkg.dir, 'dist');
  const pattern = /(require\(\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g;
  let changed = 0;
  const stack = [dist];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const before = fs.readFileSync(full, 'utf8');
      const after = before.replace(pattern, '$1$2$3.js$2');
      if (after !== before) {
        fs.writeFileSync(full, after, 'utf8');
        changed += 1;
      }
    }
  }
  return changed;
}

/**
 * 目录树里最新的**构建输入**的 mtime（判断 dist 是否陈旧）。
 *
 * `.d.ts` **不算**：各包有手写的 `src/index.d.ts`（声明面，由 typecheck 的 types 配置单独验证），
 * 它不参与 dist 产出，而且 git 操作（stash/checkout）会刷新它的 mtime —— 拿它判陈旧会误报
 * （实测：4 个包报"dist 比 src 旧"，其实只是声明面文件被 git 重写过）。
 */
function newestSourceTime(dir) {
  let newest = 0;
  const stack = [path.join(dir, 'src')];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    }
  }
  return newest;
}

/** 检查一个包：dist 存在、不过期、exports 指向的文件都在。 */
function checkPackage(pkg) {
  const problems = [];
  const packageDir = path.join(ROOT, pkg.dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const dist = path.join(packageDir, 'dist');

  if (!fs.existsSync(path.join(dist, 'index.js'))) {
    problems.push(`${pkg.name}: 缺少 dist/index.js（还没构建）`);
    return problems;
  }
  const distTime = fs.statSync(path.join(dist, 'index.js')).mtimeMs;
  if (newestSourceTime(packageDir) > distTime) {
    problems.push(`${pkg.name}: dist 比 src 旧（改了源码没重新构建）`);
  }

  // exports 里所有 "./..." 目标都必须真实存在（发布出去缺文件是最难查的事故）
  const targets = [];
  const collect = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.push(value);
      return;
    }
    if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collect(item);
  };
  collect(manifest.exports);
  if (typeof manifest.main === 'string') targets.push(manifest.main);
  if (typeof manifest.types === 'string') targets.push(manifest.types);
  for (const target of new Set(targets)) {
    if (target.includes('*')) continue; // 通配导出按定义存在
    if (!fs.existsSync(path.join(packageDir, target))) {
      problems.push(`${pkg.name}: exports 指向的 ${target} 不存在`);
    }
  }
  if (!(manifest.files ?? []).includes('dist')) problems.push(`${pkg.name}: files 里缺 "dist"`);
  if (!(manifest.files ?? []).includes('src')) problems.push(`${pkg.name}: files 里缺 "src"（保留源码供直跑/读源码）`);
  return problems;
}

const selected = only === undefined
  ? PACKAGES
  : PACKAGES.filter((pkg) => path.resolve(pkg.dir) === path.resolve(only) || pkg.dir === only);
if (selected.length === 0) {
  console.error(`[build] 找不到包：${String(only)}`);
  process.exit(2);
}

if (checkOnly) {
  const problems = selected.flatMap((pkg) => checkPackage(pkg));
  if (problems.length > 0) {
    console.error(`[build] 检查未通过（${problems.length} 项）：\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`[build] 检查通过：${selected.length} 个包的 dist 齐备、未过期、exports 目标都在`);
  process.exit(0);
}

const started = Date.now();

// 全量构建：先用项目引用一次构建 9 个包（增量、顺序自动），再单独编译内核
if (only === undefined) {
  const esm = selected.filter((pkg) => pkg.cjs !== true);
  const kernel = selected.filter((pkg) => pkg.cjs === true);
  if (esm.length > 0) {
    const at = Date.now();
    try {
      await run(process.execPath, [TSC, '-b', path.join(ROOT, 'tsconfig.build.json')], { cwd: ROOT });
    } catch (error) {
      console.error(`[build] 项目引用构建失败：\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`);
      process.exit(1);
    }
    console.log(`[build] ${esm.map((pkg) => pkg.name).join(', ')} → 一次 tsc -b（${String(Date.now() - at)}ms）`);
  }
  for (const pkg of kernel) {
    const at = Date.now();
    try {
      await run(process.execPath, [TSC, '-p', path.join(ROOT, pkg.dir, 'tsconfig.build.json')], { cwd: ROOT });
    } catch (error) {
      console.error(`[build] ${pkg.name} 构建失败：\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`);
      process.exit(1);
    }
    const rewritten = rewriteCjsRequires(pkg);
    console.log(
      `[build] ${pkg.name} → ${pkg.dir}/dist（${String(Date.now() - at)}ms${rewritten === 0 ? '' : `，改写 require 说明符 ${String(rewritten)} 个文件`}）`,
    );
  }
  console.log(`[build] 完成 ${selected.length} 个包，用时 ${String(Date.now() - started)}ms`);
  process.exit(0);
}

for (const pkg of selected) {
  const config = path.join(ROOT, pkg.dir, 'tsconfig.build.json');
  if (!fs.existsSync(config)) {
    console.error(`[build] ${pkg.name} 缺少 tsconfig.build.json`);
    process.exit(2);
  }
  const at = Date.now();
  try {
    await run(process.execPath, [TSC, '-p', config], { cwd: ROOT });
  } catch (error) {
    console.error(`[build] ${pkg.name} 构建失败：\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`);
    process.exit(1);
  }
  const rewritten = pkg.cjs === true ? rewriteCjsRequires(pkg) : 0;
  console.log(
    `[build] ${pkg.name} → ${pkg.dir}/dist（${String(Date.now() - at)}ms${rewritten === 0 ? '' : `，改写 require 说明符 ${String(rewritten)} 个文件`}）`,
  );
}
console.log(`[build] 完成 ${selected.length} 个包，用时 ${String(Date.now() - started)}ms`);
