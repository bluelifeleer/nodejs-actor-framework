#!/usr/bin/env node
/**
 * 发布前检查（零依赖，M5 第 5 步）。
 *
 *   npm run release:check                 # = npm run ci（typecheck + 全量测试 + 文档站）+ 下面这些
 *   npm run release:check -- --skip-ci    # 只跑打包与一致性检查
 *
 * 它检查的是**"发了会不会出事"**，而不是再跑一遍测试：
 *   - 工作区测试矩阵：每个有 `test/` 的包都要出现在根 `npm test` 的 glob 里
 *     （踩过：新加的包忘了进矩阵，CI 里根本没跑它的测试）；
 *   - `npm pack` 内容：可发布的包里**不能**有测试、证书、数据目录（凭据/私钥绝不能进 tarball）；
 *   - CHANGELOG 与版本一致：最新版本号 == 可发布包的 version；
 *   - 各包 engines 一致：Node 下限只有一个来源；
 *   - 工作区干净：发布应当从干净树出发（`--allow-dirty` 可跳过）。
 *
 * 每个检查都是**纯函数 + 可注入输入**，所以能被测试直接拿假数据验证"该失败时会失败"
 * （门禁自己不失败 = 没有门禁）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkPublicSurface, kernelUntypedFiles } from './api-extract.mjs';

const run = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 可发布（非 private）的包目录。 */
export async function publishablePackages(root = ROOT) {
  const found = [];
  for (const dir of await workspaceDirs(root)) {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
    if (manifest.private !== true) found.push({ dir, name: manifest.name, version: manifest.version, manifest });
  }
  return found;
}

/** 工作区里的所有包目录（按 package.json 的 workspaces 展开；只支持 `packages/*` 这种一层通配）。 */
export async function workspaceDirs(root = ROOT) {
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const dirs = [];
  for (const pattern of manifest.workspaces ?? []) {
    const base = path.join(root, pattern.replace(/\/\*$/, ''));
    if (!fs.existsSync(base)) continue;
    for (const entry of await fsp.readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      if (fs.existsSync(path.join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

/** 检查 1：每个有 test/ 的包都在根 test 脚本里。 */
export async function checkTestMatrix({ root = ROOT, packages } = {}) {
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const script = String(manifest.scripts?.test ?? '');
  const dirs = packages ?? (await workspaceDirs(root));
  const missing = [];
  for (const dir of dirs) {
    const name = path.basename(dir);
    if (!fs.existsSync(path.join(dir, 'test'))) continue;
    if (!script.includes(`packages/${name}/test/`)) missing.push(name);
  }
  return {
    name: '工作区测试矩阵',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `根 npm test 覆盖了所有带测试的包（${dirs.length} 个包）`
        : `这些包有测试但不在根 npm test 的 glob 里：${missing.join(', ')}`,
    fix: missing.length === 0 ? undefined : '把它们加进 package.json 的 test 脚本（否则 CI 不会跑）',
    missing,
  };
}

/** tarball 里不该出现的路径（测试/凭据/数据/依赖）。 */
const FORBIDDEN_PATTERN = /(^|\/)(test|tests|fixtures|data|msg_store|node_modules)\//;
const FORBIDDEN_EXT = /\.(pem|key|crt|p12)$/;

/** 检查 2：可发布包的 `npm pack` 内容。 */
export async function checkPackContents({ root = ROOT, packages, packFiles } = {}) {
  const list = packages ?? (await publishablePackages(root));
  if (list.length === 0) {
    return { name: 'npm pack 内容', ok: true, detail: '没有可发布的包（全是 private）', files: [] };
  }
  const forbidden = [];
  const files = [];
  for (const pkg of list) {
    if (typeof packFiles === 'function') {
      // 可注入：测试用假文件清单验证"该拦的能拦住"，不必真的跑 npm pack
      const paths = await packFiles(pkg);
      files.push(...paths.map((file) => `${pkg.name}/${file}`));
      for (const file of paths) {
        if (FORBIDDEN_PATTERN.test(file)) forbidden.push(`${pkg.name}/${file}`);
      }
      continue;
    }
    // npm 默认往 $HOME/.npm 写日志与缓存；在受限环境（沙箱/CI 容器）里那可能不可写。
    // 指到工作区内的临时目录：检查因此不依赖"家目录可写"这种无关前提。
    const npmTmp = path.join(root, '.tmp-npm');
    fs.mkdirSync(npmTmp, { recursive: true });
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json'], {
      cwd: pkg.dir,
      timeout: 120_000,
      env: {
        ...process.env,
        npm_config_logs_dir: path.join(npmTmp, 'logs'),
        npm_config_cache: path.join(npmTmp, 'cache'),
        npm_config_update_notifier: 'false',
      },
    });
    const parsed = JSON.parse(stdout);
    const paths = (parsed[0]?.files ?? []).map((file) => file.path);
    files.push(...paths.map((file) => `${pkg.name}/${file}`));
    for (const file of paths) {
      // 凭据、测试、数据目录、源码映射都不该进 tarball
      if (FORBIDDEN_PATTERN.test(file) || FORBIDDEN_EXT.test(file)) {
        forbidden.push(`${pkg.name}/${file}`);
      }
    }
  }
  return {
    name: 'npm pack 内容',
    ok: forbidden.length === 0,
    detail:
      forbidden.length === 0
        ? `${list.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')} 的 tarball 不含测试/凭据/数据`
        : `tarball 里有不该发布的文件：${forbidden.slice(0, 10).join(', ')}`,
    fix: forbidden.length === 0 ? undefined : '检查该包的 files 字段与 .npmignore',
    files,
    forbidden,
  };
}

/** 检查 3：CHANGELOG 的最新版本与可发布包的版本一致。 */
export async function checkChangelog({ root = ROOT, packages, changelog } = {}) {
  const file = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(file)) {
    return { name: 'CHANGELOG 版本一致', ok: false, detail: '仓库里没有 CHANGELOG.md', fix: '写一个（参考 Keep a Changelog）' };
  }
  const text = changelog ?? (await fsp.readFile(file, 'utf8'));
  const list = packages ?? (await publishablePackages(root));
  // 只对**内核**负责：CHANGELOG 承诺的是内核的兼容性；@actor/* 是 0.x 实验包（是否公开见 Q7）
  const target = list.find((pkg) => pkg.name === 'nodejs-actor-framework') ?? list[0];
  if (target === undefined) {
    return { name: 'CHANGELOG 版本一致', ok: true, detail: '没有可发布的包，跳过' };
  }
  const hasVersion = new RegExp(`^##\\s*\\[?${target.version.replace(/\./g, '\\.')}\\]?`, 'm').test(text);
  const hasUnreleased = /^##\s*\[?Unreleased\]?/m.test(text);
  return {
    name: 'CHANGELOG 版本一致',
    ok: hasVersion,
    detail: hasVersion
      ? `${target.name}@${target.version} 在 CHANGELOG 里有条目`
      : `CHANGELOG 里没有 ${target.version} 的条目（当前只有${hasUnreleased ? ' Unreleased' : '空'}）`,
    fix: hasVersion ? undefined : `发布前把 Unreleased 收成 ## [${target.version}] - <日期>`,
  };
}

/** 检查 4：各包 engines 一致。 */
export async function checkEngines({ root = ROOT, packages } = {}) {
  const dirs = packages ?? (await workspaceDirs(root));
  const rootManifest = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const expected = rootManifest.engines?.node;
  const mismatched = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
    const declared = manifest.engines?.node;
    if (declared === undefined) {
      mismatched.push(`${path.basename(dir)}（未声明）`);
      continue;
    }
    if (declared !== expected) mismatched.push(`${path.basename(dir)}（${declared}）`);
  }
  return {
    name: 'engines 一致',
    ok: mismatched.length === 0,
    detail:
      mismatched.length === 0
        ? `所有包都要求 node ${expected}`
        : `与根 package.json（${expected}）不一致：${mismatched.join(', ')}`,
    fix: mismatched.length === 0 ? undefined : '统一 Node 下限（源码直接跑 TS 且用 node:sqlite）',
    mismatched,
  };
}

/**
 * 检查 5：内核公开面与类型覆盖。
 *
 * `index.d.ts` 是使用者看到的类型、运行时导出才是真正存在的 API；两者漂移时**没有测试会变红**，
 * 发布出去就是"文档里的类型不存在"或"实际 API 全是 any"。同时内核不应再有跳过严格检查的文件。
 */
export async function checkKernelSurface({ root = ROOT } = {}) {
  const module = await import(pathToFileURL(path.join(root, 'packages/core/src/index.ts')).href);
  const exported = module.default && typeof module.default === 'object' ? module.default : module;
  const runtimeNames = Object.keys(exported).filter((key) => key !== 'default' && key !== '__esModule');
  const surface = checkPublicSurface({ root, runtimeNames });
  const untyped = kernelUntypedFiles(root);
  const ok = surface.ok && untyped.length === 0;
  return {
    name: '内核公开面与类型覆盖',
    ok,
    detail: ok
      ? `运行时导出 ${surface.declared}/${surface.total} 都有类型声明；内核源码 0 个文件跳过严格检查`
      : [
          surface.ok ? null : `缺少声明的导出：${surface.missing.join(', ')}`,
          untyped.length === 0 ? null : `${untyped.length} 个内核文件仍带 @ts-nocheck：${untyped.slice(0, 5).join(', ')}`,
        ]
          .filter(Boolean)
          .join('；'),
    fix: ok ? undefined : '补 packages/core/src/index.d.ts 的声明，或补完类型后删掉 @ts-nocheck',
    missing: surface.missing,
    untyped,
  };
}

/** 检查 6：工作区干净。 */
export async function checkCleanTree({ root = ROOT, allowDirty = false } = {}) {
  if (allowDirty) return { name: '工作区干净', ok: true, detail: '按 --allow-dirty 跳过' };
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root, timeout: 30_000 });
  const dirty = String(stdout).trim();
  return {
    name: '工作区干净',
    ok: dirty === '',
    detail: dirty === '' ? '没有未提交改动' : `有未提交改动：\n${dirty}`,
    fix: dirty === '' ? undefined : '先提交（或用 --allow-dirty 明确跳过）',
  };
}

/** 跑完整流程。 */
export async function runReleaseCheck(options = {}) {
  const root = options.root ?? ROOT;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const results = [];

  if (options.skipCi !== true) {
    log('▶ 先跑 CI 门禁（typecheck + 全量测试 + 文档站）…');
    try {
      await run('npm', ['run', 'ci'], { cwd: root, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
      results.push({ name: 'CI 门禁', ok: true, detail: 'npm run ci 通过' });
    } catch (err) {
      results.push({
        name: 'CI 门禁',
        ok: false,
        detail: `npm run ci 失败：${String(err.stdout ?? err.message).split('\n').slice(-8).join('\n')}`,
      });
    }
  }

  results.push(await checkTestMatrix({ root }));
  results.push(await checkPackContents({ root }));
  results.push(await checkChangelog({ root }));
  results.push(await checkEngines({ root }));
  results.push(await checkKernelSurface({ root }));
  results.push(await checkCleanTree({ root, allowDirty: options.allowDirty === true }));
  return results;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const asJson = process.argv.includes('--json');
  const results = await runReleaseCheck({
    skipCi: process.argv.includes('--skip-ci'),
    allowDirty: process.argv.includes('--allow-dirty'),
    log: asJson ? () => {} : (line) => process.stdout.write(`${line}\n`),
  });
  const failed = results.filter((result) => !result.ok);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ results, failed: failed.length }, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`${result.ok ? '✓' : '✗'} ${result.name}：${result.detail}\n`);
      if (!result.ok && result.fix !== undefined) process.stdout.write(`    → ${result.fix}\n`);
    }
    process.stdout.write(failed.length === 0 ? '\n可以发布。\n' : `\n${failed.length} 项未通过。\n`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}
