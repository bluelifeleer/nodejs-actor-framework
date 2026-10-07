import { test } from 'node:test';
import assert from 'node:assert';

/**
 * **T1 短名的恒等断言**：短名不是"另一个实现"，而是**同一个对象**的别名。
 *
 * 为什么必须有：短名一旦被写成包装函数（`const model = (x) => defineModel(x)`），就会悄悄分叉 ——
 * 类型、实例标识、`===` 比较、文档示例全会开始对不上。这条门禁用 `===` 钉死。
 */
const PACKAGES = {
  '@actor/app': ['defineApp', 'defineConfig', 'defineModule', 'definePlugin'],
  '@actor/web': ['defineController', 'defineRouter', 'defineWebPlugin', 'defineUploadStorage', 'defineMiddleware'],
  '@actor/db': ['defineModel'],
  '@actor/mongodb': ['defineCollection'],
  '@actor/data': ['defineAggregate', 'defineEventSchema', 'defineEvolution'],
  '@actor/mail': ['defineMailTransport'],
  '@actor/resource': ['defineManagedResource'],
};

/** 短名规则：defineApp → app；defineWebPlugin → webPlugin；defineUploadStorage → uploadStorage。 */
function shortNameOf(canonical) {
  const rest = canonical.slice('define'.length);
  return rest[0].toLowerCase() + rest.slice(1);
}

test('sugar aliases: 每个应用层短名都与 define* **是同一个对象**（不是包装）', async () => {
  const missing = [];
  for (const [pkg, canonicals] of Object.entries(PACKAGES)) {
    const module = await import(pkg);
    for (const canonical of canonicals) {
      const short = shortNameOf(canonical);
      // 先断言"前提成立"：缺 define* 或缺短名都要报出来，绝不静默跳过
      if (module[canonical] === undefined) {
        missing.push(`${pkg}: 缺少 ${canonical}`);
        continue;
      }
      if (module[short] === undefined) {
        missing.push(`${pkg}: 缺少短名 ${short}（对应 ${canonical}）`);
        continue;
      }
      assert.strictEqual(module[short], module[canonical], `${pkg}: ${short} 必须与 ${canonical} 是同一个对象`);
    }
  }
  assert.deepStrictEqual(missing, [], `短名不全：\n${missing.join('\n')}`);
});

test('sugar aliases: 设计文档里写到了每个短名（文档与实现不许分叉）', async () => {
  const fs = await import('node:fs');
  const doc = fs.readFileSync(new URL('../docs/design/m9-define-sugar.md', import.meta.url), 'utf8');
  const absent = [];
  for (const canonicals of Object.values(PACKAGES)) {
    for (const canonical of canonicals) {
      const short = shortNameOf(canonical);
      if (!doc.includes(short)) absent.push(`${short}（${canonical}）`);
    }
  }
  assert.deepStrictEqual(absent, [], `设计文档里缺这些短名：${absent.join(', ')}`);
});

test('sugar aliases: 手写 .d.ts 里也声明了短名（有声明文件的包才要求）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const absent = [];
  for (const [pkg, canonicals] of Object.entries(PACKAGES)) {
    const dir = pkg.replace('@actor/', '');
    const decl = path.join(root, 'packages', dir, 'src', 'index.d.ts');
    if (!fs.existsSync(decl)) continue; // 没手写声明的包（源码即类型）
    const text = fs.readFileSync(decl, 'utf8');
    for (const canonical of canonicals) {
      const short = shortNameOf(canonical);
      if (!new RegExp(`\\b${short}\\b`).test(text)) absent.push(`${pkg}: ${short}`);
    }
  }
  assert.deepStrictEqual(absent, [], `这些包的手写声明缺短名（导出面门禁会红）：${absent.join(', ')}`);
});
