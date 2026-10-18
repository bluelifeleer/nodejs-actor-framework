/**
 * 发布链路自检：对每个**公开包**真的跑一遍 `npm publish --dry-run`。
 *
 * 为什么不用 `npm pack --dry-run` 就够了：`pack` **不会**执行 `prepublishOnly`，
 * 而发布时会。实测正是这条差异抓到过一个真 bug：各包的
 * `prepublishOnly` 传 `--package .` 而构建脚本不认这个写法 → 发布在**预处理**阶段就失败，
 * 而 `npm pack` 一路绿灯。
 *
 * 所以这里做的是"发布路径"而不是"打包路径"：
 *   1. 真跑 `npm publish --dry-run --json`（会执行 prepublishOnly → 真构建）；
 *   2. 断言 tarball 里有默认入口与源码（`dist/index.js`、`src/index.ts`；内核另要两个 ESM 包装）；
 *   3. 任一包失败 → 退出码 1，并打印 npm 的原始输出（不吞错）。
 *
 * 用法：`npm run release:publish-dry-run`
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.tmp-publish', 'cache');
const LOGS = path.join(ROOT, '.tmp-publish', 'logs');

/** 公开包 = `packages/<名字>/package.json` 里没有 `private: true` 的。 */
function publicPackages() {
  const found = [];
  for (const entry of fs.readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(ROOT, 'packages', entry.name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.private === true) continue;
    found.push({ dir: `packages/${entry.name}`, name: manifest.name, version: manifest.version });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** 从一个混合了构建日志的 stdout 里取出 JSON 对象（按括号配对找结尾）。 */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  return null;
}

/** 每个包必要的入口（发布出去必须带上）。CLI 是 bin 包：靠 `dist/cli.js` + 模板，不含 index.js。 */
function requiredPaths(name, manifest) {
  if (name === '@actor/cli') {
    return [
      'package.json',
      'dist/cli.js',
      'templates/capabilities.json',
      'templates/app/main.ts',
      'templates/app-flat/main.ts',
    ];
  }
  const required = ['package.json', 'dist/index.js', 'src/index.ts'];
  if (name === 'nodejs-actor-framework') required.push('index.mjs', 'index.dev.mjs');
  // bin 的指向必须真的在包里（否则 `npx actor` 会在装完后报找不到文件）
  const bin = manifest?.bin;
  if (typeof bin === 'object' && bin !== null) {
    for (const target of Object.values(bin)) required.push(String(target).replace(/^\.\//, ''));
  }
  return required;
}

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const env = {
  ...process.env,
  npm_config_cache: CACHE,
  npm_config_logs_dir: LOGS,
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};

const packages = publicPackages();
console.log(`[release] 对 ${String(packages.length)} 个公开包跑 publish --dry-run`);

const failures = [];
for (const pkg of packages) {
  let stdout = '';
  let stderr = '';
  try {
    const result = await run('npm', ['publish', '--dry-run', '--json'], {
      cwd: path.join(ROOT, pkg.dir),
      env,
      timeout: 300_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    failures.push({ pkg, reason: 'npm publish --dry-run 失败', output: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}` });
    continue;
  }

  const parsed = extractJson(stdout);
  if (parsed === null) {
    failures.push({ pkg, reason: '输出里找不到 JSON 结果', output: `${stdout}${stderr}` });
    continue;
  }
  // 注意：`npm publish --json` 的形状是 **按包名分组**的 `{ "@actor/mail": {...} }`，
  // 与 `npm pack --json` 的数组形状不同（这是实测出来的，别按 pack 的形状写）。
  const manifest = parsed[pkg.name] ?? Object.values(parsed)[0];
  if (manifest === undefined || typeof manifest !== 'object') {
    failures.push({ pkg, reason: 'JSON 结果里没有该包的信息', output: stdout });
    continue;
  }
  const paths = new Set((manifest.files ?? []).map((file) => file.path));
  const required = requiredPaths(pkg.name, JSON.parse(fs.readFileSync(path.join(ROOT, pkg.dir, 'package.json'), 'utf8')));
  const missing = required.filter((file) => !paths.has(file));
  if (missing.length > 0) {
    failures.push({ pkg, reason: `tarball 缺少：${missing.join(', ')}`, output: '' });
    continue;
  }
  console.log(`  ✓ ${pkg.name}@${String(manifest.version)}（${String(manifest.entryCount)} 个文件，含 ${required.join(' / ')}）`);
}

fs.rmSync(path.join(ROOT, '.tmp-publish'), { recursive: true, force: true });

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n✗ ${failure.pkg.name}（${failure.pkg.dir}）：${failure.reason}`);
    if (failure.output !== '') console.error(failure.output.trim());
  }
  console.error(`\n[release] ${String(failures.length)}/${String(packages.length)} 个包没通过发布自检`);
  process.exit(1);
}
console.log(`[release] 全部 ${String(packages.length)} 个包的发布路径可用（dry-run，未真的上传）`);
