/**
 * 占住无 scope 名 `nodejs-actor-framework`（防止被第三方抢注）。
 *
 * 只发布一个**最小占位包**（`package.json` + `README.md` + `index.js`），**不含本仓库源码**：
 * 它的唯一作用是占名字；将来要公开正式版时直接发新版本覆盖。
 *
 * 为什么单独一个临时目录，而不是从仓库根发布：
 *   - 仓库里的版本是 1.0.0，占位要发 0.0.1；改仓库版本号会污染 git 历史；
 *   - 占位包不该带上 `dist/`、`src/`、模板这些东西。
 *
 * 用法：
 *   node tools/reserve-name.mjs             # 干跑：生成占位包并 `npm pack --dry-run` 验证
 *   node tools/reserve-name.mjs --publish   # 真发（需要先 `npm login`；已存在同名版本则跳过）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const NAME = 'nodejs-actor-framework';
const VERSION = '0.0.1';
const publish = process.argv.includes('--publish');

const placeholder = path.join(ROOT, '.tmp-reserve-name');
fs.rmSync(placeholder, { recursive: true, force: true });
fs.mkdirSync(placeholder, { recursive: true });

fs.writeFileSync(
  path.join(placeholder, 'package.json'),
  `${JSON.stringify(
    {
      name: NAME,
      version: VERSION,
      description: 'Name reserved. The framework is published under the @actor scope.',
      license: 'MIT',
      engines: { node: '>=24' },
      files: ['index.js', 'README.md'],
    },
    null,
    2,
  )}\n`,
  'utf8',
);
fs.writeFileSync(
  path.join(placeholder, 'README.md'),
  `# ${NAME}\n\nThis package name is **reserved**.\n\nThe Actor framework is published under the \`@actor\` scope\n(\`@actor/app\`, \`@actor/web\`, \`@actor/data\`, …), with the CLI at \`@actor/cli\`.\n\nThis placeholder contains no source code.\n`,
  'utf8',
);
fs.writeFileSync(
  path.join(placeholder, 'index.js'),
  `'use strict';\n\n// 占位包：不含实现。框架在 @actor scope 下（@actor/app、@actor/cli …）。\nmodule.exports = {\n  reserved: true,\n  seeInstead: '@actor/app',\n};\n`,
  'utf8',
);

// npm 默认往 $HOME/.npm 写日志/缓存；在受限环境（沙箱、CI 容器）里那可能不可写 ——
// 指到工作区内的临时目录，检查因此不依赖"家目录可写"这种无关前提。
const npmTmp = path.join(ROOT, '.tmp-reserve-name', 'npm');
fs.mkdirSync(npmTmp, { recursive: true });
const env = {
  ...process.env,
  npm_config_cache: path.join(npmTmp, 'cache'),
  npm_config_logs_dir: path.join(npmTmp, 'logs'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};

// ① 先干跑，确认真要发的就这三个文件
const packed = await run('npm', ['pack', '--dry-run', '--json'], { cwd: placeholder, env, timeout: 120_000 });
const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path).sort();
const expected = ['README.md', 'index.js', 'package.json'];
if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error(`[reserve] 占位包内容不是预期的三个文件：${files.join(', ')}`);
  process.exit(1);
}
console.log(`[reserve] ${NAME}@${VERSION} 的占位包内容：${files.join(' / ')}`);

if (!publish) {
  console.log('[reserve] 干跑完成。真发：`npm run release:reserve-name -- --publish`（需先 npm login）');
  fs.rmSync(placeholder, { recursive: true, force: true });
  process.exit(0);
}

// ② 已存在就不重复发（版本号不可覆盖）
const existing = await run('npm', ['view', `${NAME}@${VERSION}`, 'version'], { env, timeout: 120_000 }).catch(() => null);
if (existing !== null && existing.stdout.trim() !== '') {
  console.log(`[reserve] ${NAME}@${VERSION} 已经存在（${existing.stdout.trim()}），跳过`);
  fs.rmSync(placeholder, { recursive: true, force: true });
  process.exit(0);
}

// ③ 真发：显式 --access public（无 scope 包只能公开）
try {
  const result = await run('npm', ['publish', '--access', 'public', '--json'], { cwd: placeholder, env, timeout: 300_000 });
  console.log(`[reserve] 已发布：${result.stdout.trim().split('\n').slice(-1)[0]}`);
} catch (error) {
  console.error(`[reserve] 发布失败：\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`);
  process.exit(1);
} finally {
  fs.rmSync(placeholder, { recursive: true, force: true });
}
