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
  // 工具包也发布：CLI（bin 指向 dist/cli.js）与 testkit。放在最后 —— CLI 依赖 app/web/db/data。
  { dir: 'packages/ops-agent', name: '@actor/ops-agent' },
  { dir: 'packages/testkit', name: '@actor/testkit' },
  { dir: 'packages/cli', name: '@actor/cli' },
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

/**
 * 每个包的**入口产物**：库包是 `dist/index.js`；CLI 是 bin 包，入口是 `dist/cli.js`。
 * （`--check` 与发布自检都要按这个来判"构建齐了没有"，不能一律找 index.js。）
 */
function entryOf(pkg) {
  return pkg.name === '@actor/cli' ? 'dist/cli.js' : 'dist/index.js';
}

/**
 * dist 里**最新**产物的 mtime（判断"要不要重新构建"的正确基准）。
 *
 * 不能只看入口文件（`dist/index.js`）：tsc 只重写**内容变化**的产物，
 * 改的是 `src/ws.ts` 时 `dist/index.js` 的 mtime 会保持很旧 —— 拿它比就会误报"陈旧"。
 * `.tsbuildinfo` 也算在内（它随每次构建刷新，且不带它时会漏掉"只有 tsbuildinfo 更新"的情况）。
 */
function newestOutputTime(packageDir) {
  let newest = 0;
  const stack = [path.join(packageDir, 'dist')];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  for (const entry of fs.readdirSync(packageDir)) {
    if (entry.endsWith('.tsbuildinfo')) newest = Math.max(newest, fs.statSync(path.join(packageDir, entry)).mtimeMs);
  }
  return newest;
}

/** 检查一个包：dist 存在、不过期、exports 指向的文件都在。 */
function checkPackage(pkg) {
  const problems = [];
  const packageDir = path.join(ROOT, pkg.dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const dist = path.join(packageDir, 'dist');
  const entry = entryOf(pkg);

  if (!fs.existsSync(path.join(packageDir, entry))) {
    problems.push(`${pkg.name}: 缺少 ${entry}（还没构建）`);
    return problems;
  }
  if (newestSourceTime(packageDir) > newestOutputTime(packageDir)) {
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
  // CLI 的模板必须随包发布（否则装完 `npx actor new` 找不到模板）
  if (pkg.name === '@actor/cli' && !(manifest.files ?? []).includes('templates')) {
    problems.push(`${pkg.name}: files 里缺 "templates"（脚手架模板要随包发布）`);
  }
  // bin 指向的文件必须存在
  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    if (!fs.existsSync(path.join(packageDir, target))) problems.push(`${pkg.name}: bin "${name}" 指向的 ${target} 不存在`);
  }
  return problems;
}

// `--package` 的三种写法都要认：绝对路径、相对仓库根的路径（`packages/mail`）、
// 以及**当前目录**（各包 `prepublishOnly` 就是站在包目录里跑 `--package .` 的）。
const target = only === undefined ? undefined : path.resolve(only);
const selected = target === undefined
  ? PACKAGES
  : PACKAGES.filter((pkg) => path.resolve(ROOT, pkg.dir) === target);
if (selected.length === 0) {
  console.error(`[build] 找不到包：${String(only)}`);
  process.exit(2);
}

/**
 * 缺产物但 tsbuildinfo 还在时，`tsc -b` 会**跳过**（它以为产物是最新的）→ dist 一直是空的。
 * 真实场景：有人删了 `dist/`（或只删了某个包），构建脚本却报"完成"，然后运行时找不到模块。
 * 所以只要发现有包的入口产物缺失，就退化成 `--force`（12 个包全量构建也就 0.2~0.3 秒）。
 */
function needsForceBuild(list) {
  return list.some((pkg) => !fs.existsSync(path.join(ROOT, pkg.dir, entryOf(pkg))));
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
      const force = needsForceBuild(esm) ? ['--force'] : [];
      await run(process.execPath, [TSC, '-b', path.join(ROOT, 'tsconfig.build.json'), ...force], { cwd: ROOT });
    } catch (error) {
      console.error(`[build] 项目引用构建失败：\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`);
      process.exit(1);
    }
    console.log(`[build] ${esm.map((pkg) => pkg.name).join(', ')} → 一次 tsc -b（${String(Date.now() - at)}ms）`);
  }
  for (const pkg of kernel) {
    const at = Date.now();
    try {
      // 单包也走 `-b` + 按需 `--force`：`-p` 遇到"产物被删但 tsbuildinfo 还在"同样会跳过
      const force = needsForceBuild([pkg]) ? ['--force'] : [];
      await run(process.execPath, [TSC, '-b', path.join(ROOT, pkg.dir, 'tsconfig.build.json'), ...force], { cwd: ROOT });
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
    // 与全量路径一致：产物缺失时必须 `--force`（否则 tsc 以为 tsbuildinfo 里的产物还在，直接跳过）
    const force = needsForceBuild([pkg]) ? ['--force'] : [];
    await run(process.execPath, [TSC, '-b', config, ...force], { cwd: ROOT });
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
