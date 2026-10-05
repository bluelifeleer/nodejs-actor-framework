import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.join(import.meta.dirname, '..');
const APP_DIR = path.join(ROOT, 'packages', 'app');
const DATA_DIR = path.join(ROOT, 'packages', 'data');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|js|mjs|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 扫描前先去掉注释：否则"文档里写了某个路径"会被当成"代码 import 了它"，
 * 得到假失败（这与"注释里也出现关键字 → 假通过"是同一类陷阱的两个方向）。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 读文件并去掉注释（守卫断言只看真实代码）。 */
function readCode(file) {
  return stripComments(fs.readFileSync(file, 'utf8'));
}

/**
 * 应用层边界：这些断言保证「用户不接触内核」不靠约定，而靠结构。
 * 背景见 docs/design/m1-app-assembly.md §1。
 */
test('app boundary: @actor/app 存在、依赖内核，并由工作区链接解析', () => {
  assert.ok(fs.existsSync(APP_DIR), 'packages/app 必须存在');
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.name, '@actor/app');
  assert.ok(pkg.dependencies['nodejs-actor-framework'], '应用层必须依赖内核（依赖方向向下）');

  const resolved = require.resolve('@actor/app');
  assert.ok(
    resolved.includes(path.join('packages', 'app')),
    `@actor/app 必须解析到工作区内的包，实际: ${resolved}`,
  );
});

test('app boundary: 应用层与 Web 层都不 re-export 内核内部类型', () => {
  const internals = ['ActorSystem', 'Mailbox', 'ActorCell', 'ChildSupervisor', 'RemoteRef', 'Actor', 'Peer'];
  const roots = [
    path.join(APP_DIR, 'src'),
    path.join(ROOT, 'packages', 'web', 'src'),
    path.join(DATA_DIR, 'src'),
  ];
  for (const file of roots.flatMap((dir) => walk(dir))) {
    const text = readCode(file);
    for (const name of internals) {
      const reexport = new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`);
      assert.ok(
        !reexport.test(text),
        `${path.relative(ROOT, file)} 不得 re-export 内核内部类型 ${name}（应用层只暴露应用层概念）`,
      );
    }
  }
});

/**
 * 数据层边界（M3）：`@actor/data` 只通过**结构类型**与内核对接，不 import 上层包。
 * 这样依赖方向恒为 data → app → core，内核也保持零依赖。
 */
test('data boundary: @actor/data 的 src 不 import 内核或其它包（只认结构类型）', () => {
  const forbidden =
    /(?:from|require\()\s*['"](?:nodejs-actor-framework|@actor\/app|@actor\/core|@actor\/web)(?:\/[^'"]*)?['"]|packages\/(?:core|app|web)\/src/;
  for (const file of walk(path.join(DATA_DIR, 'src'))) {
    assert.ok(
      !forbidden.test(readCode(file)),
      `${path.relative(ROOT, file)} 不得 import 上层包（数据层只依赖结构类型）`,
    );
  }
});

/**
 * 真实事故：`.gitignore` 里的 `data/`（未锚定）会把整个 `packages/data` 吃掉，
 * 于是新包**一个文件都提交不进去**，而 `git status` 看起来"很干净"。
 * 这条守卫让这种静默失效当场失败。
 */
test('data boundary: packages/data 不被 .gitignore 吃掉', () => {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return; // 非 git 检出（如 npm tarball）时无从判断
  const target = path.join('packages', 'data', 'src', 'events.ts');
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '--quiet', target], { cwd: ROOT, stdio: 'ignore' });
    ignored = true;
  } catch {
    ignored = false; // git check-ignore 用退出码 1 表示"未被忽略"
  }
  assert.strictEqual(ignored, false, `${target} 被 .gitignore 忽略了：新包会被静默排除在提交之外`);
});

test('app boundary: 用户示例不得直接 import 内核或深路径源码', () => {
  const examplesDir = path.join(ROOT, 'examples');
  const apps = fs.existsSync(examplesDir)
    ? fs.readdirSync(examplesDir).filter((name) => name.startsWith('app-'))
    : [];
  // 用户示例不得直接依赖内核：包名、深路径、源码路径都算
  const forbidden =
    /(?:from|require\()\s*['"](?:@actor\/core|nodejs-actor-framework)(?:\/[^'"]*)?['"]|packages\/core\/src/;
  for (const name of apps) {
    for (const file of walk(path.join(examplesDir, name))) {
      const text = readCode(file);
      assert.ok(
        !forbidden.test(text),
        `${path.relative(ROOT, file)} 直接引用了内核，用户代码必须只依赖 @actor/app`,
      );
    }
  }
});
