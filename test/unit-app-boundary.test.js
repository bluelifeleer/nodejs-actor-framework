import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.join(import.meta.dirname, '..');
const APP_DIR = path.join(ROOT, 'packages', 'app');

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
  const roots = [path.join(APP_DIR, 'src'), path.join(ROOT, 'packages', 'web', 'src')];
  for (const file of roots.flatMap((dir) => walk(dir))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of internals) {
      const reexport = new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`);
      assert.ok(
        !reexport.test(text),
        `${path.relative(ROOT, file)} 不得 re-export 内核内部类型 ${name}（应用层只暴露应用层概念）`,
      );
    }
  }
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
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(
        !forbidden.test(text),
        `${path.relative(ROOT, file)} 直接引用了内核，用户代码必须只依赖 @actor/app`,
      );
    }
  }
});
