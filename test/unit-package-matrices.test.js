import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * **矩阵接线完整性门禁**：新加一个包，很容易漏接线 —— 漏了它就不进 CI / 不进类型检查 / 不进 API 文档，
 * 而"漏了"这件事**不会自己报错**（M8a0 抽 @actor/resource 时我就漏过一处，靠人工核对才发现）。
 *
 * 四张矩阵（各自的真相来源）：
 *   1. 工作区测试矩阵：根 `package.json` 的 `scripts.test` 里的 glob
 *   2. 类型检查矩阵：根 `tsconfig.json` 的 `include`
 *   3. API 文档：`tools/docs-site.mjs` 的 `PACKAGES`
 *   4. 导出基线：`test/unit-package-surfaces.test.js`（只对有手写 `src/index.d.ts` 的包；内核有专门门禁，见下）
 *
 * 写成**纯函数**，于是"门禁能不能失败"本身可以被证伪（见最后一条测试）。
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 剥掉 JSONC 注释（根 tsconfig.json 带注释，纯 JSON.parse 会炸）。 */
function stripJsonComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

/** 包目录 → 该有的接线缺口（纯函数：便于证伪）。 */
export function findWiringGaps(input) {
  const gaps = [];
  for (const pkg of input.packages) {
    if (pkg.hasTests && !input.testScript.includes(`packages/${pkg.dir}/test/`)) {
      gaps.push(`${pkg.name}（packages/${pkg.dir}）有测试，但根 package.json 的 scripts.test 里没有它的 glob`);
    }
    const inTypecheck = input.tsconfigInclude.includes(`packages/${pkg.dir}/src/`);
    const excused = input.typecheckExceptions.includes(`packages/${pkg.dir}`);
    if (pkg.hasSrc && !inTypecheck && !excused) {
      gaps.push(`${pkg.name}（packages/${pkg.dir}）有 src，但根 tsconfig.json 的 include 里没有它`);
    }
    // 例外可以自清：一旦它进了 tsconfig，就该把例外删掉（否则"例外"会变成永久的洞）
    if (pkg.hasSrc && inTypecheck && excused) {
      gaps.push(`${pkg.name}（packages/${pkg.dir}）已经在 typecheck 里了 —— 请把它从 TYPECHECK_EXCEPTIONS 里删掉`);
    }
    if (!pkg.private && !input.docsSite.includes(`packages/${pkg.dir}/src/index.ts`)) {
      gaps.push(`${pkg.name}（packages/${pkg.dir}）是公开包，但 tools/docs-site.mjs 的 PACKAGES 里没有它`);
    }
    if (pkg.hasDeclarations && !input.surfaceBaseline.includes(`@actor/${pkg.dir}`) && !input.kernelCovered.includes(pkg.name)) {
      gaps.push(
        `${pkg.name}（packages/${pkg.dir}）有手写 src/index.d.ts，但既不在导出基线里、也不在已知的专门门禁名单里`,
      );
    }
  }
  return gaps.sort();
}

const KERNEL_COVERED = ['nodejs-actor-framework']; // 内核有专门的门禁（test/unit-kernel-surface.test.js）

/**
 * **已记录的 typecheck 例外**（带自清机制，见下一条门禁）。
 *
 * 曾经的例外：`packages/cli` 与 `packages/testkit`（本门禁第一次跑就证明那不是"故意的省略"，而是
 * **遗留缺口** —— 接进 tsconfig 会暴露 11 处类型错误，全是"从没被 typecheck 过"积累的）。
 * 这 11 处已经修完、两个包也真的接进了 tsconfig，所以名单**清空**了 —— 这正是"例外必须能自清"的用法：
 * 下面那条用例保证"例外包一旦进了 tsconfig 就必须把例外删掉"，防止例外变成永久的洞。
 */
const TYPECHECK_EXCEPTIONS = [];  // 曾经有 cli/testkit（11 处类型错误）——已修完并接进 tsconfig，例外自清机制要求清空

function readPackages() {
  const packages = [];
  for (const dir of fs.readdirSync(path.join(ROOT, 'packages'))) {
    const file = path.join(ROOT, 'packages', dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.name === undefined) continue;
    packages.push({
      dir,
      name: pkg.name,
      private: pkg.private === true,
      hasTests: fs.existsSync(path.join(ROOT, 'packages', dir, 'test')),
      hasSrc: fs.existsSync(path.join(ROOT, 'packages', dir, 'src')),
      hasDeclarations: fs.existsSync(path.join(ROOT, 'packages', dir, 'src', 'index.d.ts')),
    });
  }
  return packages;
}

function reality() {
  return {
    packages: readPackages(),
    testScript: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test,
    tsconfigInclude: stripJsonComments(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')),
    docsSite: fs.readFileSync(path.join(ROOT, 'tools', 'docs-site.mjs'), 'utf8'),
    surfaceBaseline: fs.readFileSync(path.join(ROOT, 'test', 'unit-package-surfaces.test.js'), 'utf8'),
    kernelCovered: KERNEL_COVERED,
    typecheckExceptions: TYPECHECK_EXCEPTIONS,
  };
}

test('package matrices: 每个包都接进了四张矩阵（测试 / typecheck / API 文档 / 导出基线）', () => {
  const input = reality();
  assert.ok(input.packages.length >= 10, `包数量不对（测试前提不成立）：${input.packages.length}`);
  assert.deepStrictEqual(findWiringGaps(input), [], '这些包漏接线了（漏了不会自己报错，所以要有这条门禁）');
});

test('package matrices: 门禁**能证伪** —— 造一个只缺接线的包，必须被报出来', () => {
  const fake = {
    packages: [
      { dir: 'ghost', name: '@actor/ghost', private: false, hasTests: true, hasSrc: true, hasDeclarations: true },
    ],
    testScript: '',
    tsconfigInclude: '',
    docsSite: '',
    surfaceBaseline: '',
    kernelCovered: KERNEL_COVERED,
    typecheckExceptions: [],
  };
  const gaps = findWiringGaps(fake);
  assert.strictEqual(gaps.length, 4, `应当四条矩阵各报一次：${JSON.stringify(gaps, null, 2)}`);
  for (const keyword of ['scripts.test', 'tsconfig.json', 'docs-site.mjs', '导出基线']) {
    assert.ok(gaps.some((gap) => gap.includes(keyword)), `该报 ${keyword}：${JSON.stringify(gaps)}`);
  }
  // 私有包不该被要求进 API 文档
  assert.ok(
    !findWiringGaps({ ...fake, packages: [{ ...fake.packages[0], private: true }] }).some((gap) => gap.includes('docs-site')),
    '私有包不要求 API 文档',
  );
});

test('package matrices: typecheck 例外**能自清** —— 例外包一旦进了 tsconfig，必须要求删掉例外', () => {
  const base = {
    packages: [{ dir: 'cli', name: '@actor/cli', private: true, hasTests: true, hasSrc: true, hasDeclarations: false }],
    testScript: 'packages/cli/test/*.test.ts',
    tsconfigInclude: '',
    docsSite: 'packages/cli/src/index.ts',
    surfaceBaseline: '',
    kernelCovered: KERNEL_COVERED,
  };
  // 仍在例外里 → 不报缺口（但例外本身是"已记录的债"）
  assert.deepStrictEqual(findWiringGaps({ ...base, typecheckExceptions: ['packages/cli'] }), []);
  // 已经接进 tsconfig 却还留着例外 → 必须报出来，要求删掉例外
  const stale = findWiringGaps({ ...base, tsconfigInclude: 'packages/cli/src/**/*.ts', typecheckExceptions: ['packages/cli'] });
  assert.strictEqual(stale.length, 1);
  assert.match(stale[0], /请把它从 TYPECHECK_EXCEPTIONS 里删掉/);
});
