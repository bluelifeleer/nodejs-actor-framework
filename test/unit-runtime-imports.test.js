import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * P2 门禁：**运行时源码不许静态 import `node:test`**。
 *
 * 契约套件是测试工具，可以随包发布，但生产入口 import 一个常量时不应该把
 * 测试运行器带进进程/打包产物。实现用惰性 `require('node:test')`；
 * 这里检查静态 import，防止以后又加回来。
 *
 * `packages/cli/src/commands/generate.ts` 里的字符串模板是**生成给用户的测试代码**，
 * 不是运行时 import，所以正则只匹配行首的 import 声明。
 */

const ROOT = path.join(import.meta.dirname, '..');

function findStaticNodeTest(dir) {
  const findings = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (/^\s*import\b[^\n]*from\s+['"]node:test['"]/.test(line)) {
          findings.push({ file: path.relative(ROOT, full), line: index + 1, text: line.trim() });
        }
      }
    }
  };
  walk(dir);
  return findings;
}

test('P2: 运行时源码没有静态 import node:test（契约套件必须惰性加载）', () => {
  const packages = path.join(ROOT, 'packages');
  const findings = fs
    .readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => findStaticNodeTest(path.join(packages, entry.name, 'src')));
  assert.deepStrictEqual(
    findings,
    [],
    '这些文件静态 import 了 node:test，生产入口会把测试运行器一起加载：\n' +
      findings.map((item) => `  ${item.file}:${String(item.line)}  ${item.text}`).join('\n'),
  );
});

test('P2: 门禁能证伪 —— 一行静态 import 必须被抓到', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-gate-'));
  try {
    fs.writeFileSync(path.join(tmp, 'bad.ts'), ["import { test } from 'node:test';", 'export const x = test;', ''].join('\n'), 'utf8');
    assert.strictEqual(findStaticNodeTest(tmp).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2: import 生产入口不会加载 node:test 运行器（运行时验证）', () => {
  const script = `
await import('@actor/web');
await import('@actor/resource');
await import('@actor/mail');
const loaded = process.moduleLoadList.filter((item) => item.includes('test_runner') || item.includes('node:test'));
if (loaded.length > 0) {
  console.error('node:test 被加载了：' + loaded.join(', '));
  process.exit(1);
}
`;
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: '--conditions=development' },
      stdio: 'pipe',
    }),
  );
});
