import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * 打包形态门禁：**发布出去的那份东西真的能用**。
 *
 * 包的 `exports` 现在是"发布看 `dist/`、仓库内看 `src/`"：
 *   `".": { "types": "./dist/index.d.ts", "development": "./src/index.ts", "default": "./dist/index.js" }`
 * 仓库内跑测试时 `NODE_OPTIONS=--conditions=development`（见 `tools/test.mjs`），所以源码改动立刻生效；
 * 而**消费者拿到的默认入口是 dist**。两类风险必须在这里盯住：
 *   ① 产物只是"能 import"却跑不起来（例如 `require('./x.ts')` 没被改写、worker 宿主路径还指着 .ts）；
 *   ② exports 指向的文件根本不在包里（发布出去就 404）。
 *
 * 所以下面**故意把 development 条件去掉**（模拟消费者），真起应用、真发请求、真跑 worker 隔离。
 */

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'src', 'cli.ts');

/** 公开包（内核 + 9 个 @actor/*）：都要有可用的默认入口。 */
const PUBLIC_PACKAGES = [
  { name: 'nodejs-actor-framework', probe: 'createSystem' },
  { name: '@actor/app', probe: 'createApp' },
  { name: '@actor/web', probe: 'defineController' },
  { name: '@actor/data', probe: 'createMemoryMigrationStore' },
  { name: '@actor/resource', probe: 'ResourceError' },
  { name: '@actor/db-core', probe: 'defineManagedResource' },
  { name: '@actor/db', probe: 'defineModel' },
  { name: '@actor/redis', probe: 'redisAdapter' },
  { name: '@actor/mongodb', probe: 'defineCollection' },
  { name: '@actor/mail', probe: 'renderMail' },
];

/** 消费者的环境：**没有** development 条件（这正是"发布形态"）。 */
function consumerEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** 仓库内开发者的环境：带 development 条件（解析到 src，零构建）。 */
function devEnv() {
  return { ...process.env, NODE_OPTIONS: '--conditions=development' };
}

let scratchSeq = 0;
function scratchFile(name, content) {
  const dir = path.join(ROOT, '.tmp-cli', `pkgshape-${String(process.pid)}-${String(++scratchSeq)}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

test('打包形态: 每个公开包的默认入口解析到 dist/，且探针导出可用', async () => {
  const probes = PUBLIC_PACKAGES.map(
    (entry) => `  { name: ${JSON.stringify(entry.name)}, probe: ${JSON.stringify(entry.probe)} },`,
  ).join('\n');
  const { dir, file } = scratchFile(
    'resolve.mjs',
    [
      'const targets = [',
      probes,
      '];',
      'const out = [];',
      'for (const target of targets) {',
      '  const url = import.meta.resolve(target.name);',
      '  const module = await import(target.name);',
      '  out.push({ name: target.name, url, kind: typeof module[target.probe] });',
      '}',
      'console.log(JSON.stringify(out));',
      '',
    ].join('\n'),
  );
  try {
    // ① 消费者视角（无条件）：必须是 dist
    const consumer = await run(process.execPath, [file], { cwd: ROOT, env: consumerEnv() });
    const resolved = JSON.parse(consumer.stdout);
    for (const entry of resolved) {
      assert.ok(!entry.url.includes('/src/'), `${entry.name} 不该在无条件时解析到 src（实际 ${entry.url}）`);
      // 内核的 ESM 入口是**手写的 index.mjs**（把 CJS 具名导出显式列出来），它再 import 编译产物；
      // 其它包直接指向 dist。两者都算"发布形态"，但都不能是 .ts。
      const isPublishedShape = entry.url.includes('/dist/') || /packages\/core\/index\.mjs$/.test(entry.url);
      assert.ok(isPublishedShape, `${entry.name} 的默认入口应当指向编译产物（实际 ${entry.url}）`);
      assert.notStrictEqual(entry.kind, 'undefined', `${entry.name} 的探针导出应当存在`);
    }
    // 内核的 index.mjs 必须指向 dist（而不是 src）——否则 ESM 消费者会拿到 .ts
    const kernelWrapper = fs.readFileSync(path.join(ROOT, 'packages', 'core', 'index.mjs'), 'utf8');
    assert.match(kernelWrapper, /from '\.\/dist\/index\.js'/, 'index.mjs 必须从编译产物重导出');

    // ② 仓库内视角（development 条件）：必须回到 src，保证改完源码不用构建
    const dev = await run(process.execPath, [file], { cwd: ROOT, env: devEnv() });
    for (const entry of JSON.parse(dev.stdout)) {
      // 内核的开发入口是 index.dev.mjs（它从 src 重导出，原因见包装文件里的说明）；其余包直接指向 src
      const isDevShape = entry.url.includes('/src/') || /packages\/core\/index\.dev\.mjs$/.test(entry.url);
      assert.ok(isDevShape, `${entry.name} 在 development 条件下应当解析到源码（实际 ${entry.url}）`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('打包形态: 内核的两个 ESM 包装导出列表一致（dev→src / 发布→dist，名字不能漂移）', () => {
  const read = (file) => {
    const text = fs.readFileSync(path.join(ROOT, 'packages', 'core', file), 'utf8');
    const block = text.slice(text.indexOf('export const {'), text.indexOf('} = cjs;'));
    const names = block
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line !== '' && line !== 'export const {')
      .map((line) => line.replace(/,$/, ''))
      .filter((line) => /^[A-Za-z_$][\w$]*$/.test(line));
    const target = /from '(\.\/[^']+)'/.exec(text)?.[1];
    return { names: names.sort(), target };
  };
  const published = read('index.mjs');
  const development = read('index.dev.mjs');
  assert.strictEqual(published.target, './dist/index.js', '发布包装必须从编译产物重导出');
  assert.strictEqual(development.target, './src/index.ts', '开发包装必须从源码重导出');
  assert.deepStrictEqual(development.names, published.names, '两个包装的具名导出列表必须完全一致');
  assert.ok(published.names.length > 20, `导出列表看起来不完整（${String(published.names.length)} 个）`);
});

test('打包形态: 内核的 CJS require 路径也走 dist（且具名导出可用）', async () => {
  const { dir, file } = scratchFile(
    'cjs.cjs',
    [
      "const assert = require('node:assert');",
      "const kernel = require('nodejs-actor-framework');",
      "assert.strictEqual(typeof kernel.createSystem, 'function');",
      "assert.strictEqual(typeof kernel.createLogAdapter, 'function');",
      "console.log(require.resolve('nodejs-actor-framework'));",
      '',
    ].join('\n'),
  );
  try {
    const { stdout } = await run(process.execPath, [file], { cwd: ROOT, env: consumerEnv() });
    assert.match(stdout, /packages[\\/]core[\\/]dist[\\/]index\.js/, `require 应当解析到 dist：${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('打包形态: dist 里不残留 .ts 说明符（TS 不管 require()，我们自己改写）', async () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.matchAll(/(?:from\s+|require\(\s*)['"](\.[^'"]+\.ts)['"]/g)) {
        offenders.push(`${path.relative(ROOT, full)} → ${match[1]}`);
      }
    }
  };
  for (const entry of fs.readdirSync(path.join(ROOT, 'packages'))) {
    const dist = path.join(ROOT, 'packages', entry, 'dist');
    if (fs.existsSync(dist)) walk(dist);
  }
  assert.deepStrictEqual(offenders.slice(0, 5), [], `dist 里不该残留 .ts 说明符（否则运行时找不到模块）：\n${offenders.join('\n')}`);
});

test('打包形态: 用 dist 真起一个应用（消费者视角，无条件）', async () => {
  const { dir, file } = scratchFile(
    'app.mjs',
    [
      "import assert from 'node:assert';",
      "import { createApp, defineApp, defineModule } from '@actor/app';",
      "import { defineController, defineRoutes, get, httpPlugin } from '@actor/web';",
      '',
      'const http = httpPlugin({ port: 0, accessLog: false });',
      'const app = createApp(',
      "  defineApp({ modules: [defineModule({ name: 'main', routes: defineRoutes([get('/health', defineController({ handle: () => ({ ok: true }) }))]) })], plugins: [http] }),",
      "  { configDir: '', env: {}, kernel: { logger: false } },",
      ');',
      'await app.start();',
      'try {',
      '  const base = `http://127.0.0.1:${String(http.address()?.port)}`;',
      '  const response = await fetch(`${base}/health`);',
      '  assert.strictEqual(response.status, 200);',
      '  assert.deepStrictEqual(await response.json(), { ok: true });',
      "  console.log('dist-app-ok');",
      '} finally {',
      '  await app.stop();',
      '}',
      '',
    ].join('\n'),
  );
  try {
    const { stdout } = await run(process.execPath, [file], { cwd: ROOT, env: consumerEnv(), timeout: 60_000 });
    assert.match(stdout, /dist-app-ok/, `用 dist 起的应用应当能响应请求：${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('打包形态: 用 dist 真起 worker 隔离的 Actor（覆盖 worker 宿主路径这类资产坑）', async () => {
  const { dir, file } = scratchFile(
    'worker.mjs',
    [
      "import assert from 'node:assert';",
      "import { createSystem } from 'nodejs-actor-framework';",
      '',
      'const system = createSystem({ logger: false });',
      'try {',
      "  const ref = await system.spawn('./packages/core/test/fixtures/actors/worker-player.js', { id: 'pkgshape-worker', isolation: 'worker' });",
      "  assert.ok((await ref.ask({ type: 'state' })).calls >= 1, 'worker 里的 Actor 要真的在处理消息');",
      "  assert.strictEqual(await ref.ask({ type: 'hurt', damage: 5 }), 95);",
      "  console.log('dist-worker-ok');",
      '} finally {',
      '  await system.stop();',
      '}',
      '',
    ].join('\n'),
  );
  try {
    const { stdout } = await run(process.execPath, [file], { cwd: ROOT, env: consumerEnv(), timeout: 60_000 });
    assert.match(stdout, /dist-worker-ok/, `worker 隔离必须能从 dist 正常起：${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('打包形态: 构建自检（--check）能发现"缺产物/陈旧/缺文件"', async () => {
  const buildScript = path.join(ROOT, 'tools', 'build-packages.mjs');
  // ① 先构建再自检（发布路径就是"prepublishOnly 构建 → 打包"，所以门禁也照这个顺序来）
  await run(process.execPath, [buildScript], { cwd: ROOT, timeout: 240_000 });
  const ok = await run(process.execPath, [buildScript, '--check'], { cwd: ROOT, timeout: 120_000 }).catch((error) => error);
  assert.strictEqual(ok.code ?? 0, 0, `--check 应当通过：${String(ok.stdout ?? '')}${String(ok.stderr ?? '')}`);

  // ② 故意把某个包的 dist 弄陈旧 → 必须报出来（门禁要能证伪）
  const victim = path.join(ROOT, 'packages', 'data', 'dist', 'index.js');
  const backup = fs.readFileSync(victim);
  // 要比该包**最新的源码**还旧才算陈旧，所以直接推到一年前（而不是固定的 24 小时）
  const older = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  try {
    fs.utimesSync(victim, older, older);
    const stale = await run(process.execPath, [buildScript, '--check'], { cwd: ROOT, timeout: 120_000 }).catch((error) => error);
    assert.notStrictEqual(stale.code ?? 0, 0, '陈旧产物必须被 --check 报出来');
    assert.match(String(stale.stderr ?? ''), /比 src 旧/);
  } finally {
    fs.writeFileSync(victim, backup);
    const now = new Date();
    fs.utimesSync(victim, now, now);
  }
});

test('打包形态: `npm pack` 出来的 tarball 里确实带 dist（files 配错是最难查的事故）', async () => {
  const cacheDir = path.join(ROOT, '.tmp-cli', `npm-cache-${String(process.pid)}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const env = { ...consumerEnv(), npm_config_cache: cacheDir, npm_config_logs_dir: cacheDir, npm_config_update_notifier: 'false' };
  try {
    for (const pkg of ['packages/app', 'packages/core']) {
      const { stdout } = await run('npm', ['pack', '--dry-run', '--json'], {
        cwd: path.join(ROOT, pkg),
        env,
        timeout: 120_000,
      });
      const manifest = JSON.parse(stdout)[0];
      const files = manifest.files.map((entry) => entry.path);
      assert.ok(files.includes('dist/index.js'), `${pkg} 的 tarball 里必须有 dist/index.js（实际：${files.slice(0, 8).join(', ')}…）`);
      assert.ok(files.includes('src/index.ts'), `${pkg} 的 tarball 里要保留源码（直跑/读源码用）`);
      assert.ok(!files.some((file) => file.startsWith('test/')), `${pkg} 不该把测试打进包里`);
      // 内核额外要有两个 ESM 包装
      if (pkg.endsWith('core')) {
        assert.ok(files.includes('index.mjs') && files.includes('index.dev.mjs'), `内核要带两个 ESM 包装：${files.join(', ')}`);
      }
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('打包形态: 发布路径可用（`publish --dry-run` 会跑 prepublishOnly —— pack 不会）', async () => {
  // 这条曾经是**断的**：各包 prepublishOnly 传 `--package .`，构建脚本只认包名，
  // 于是 `npm publish` 在预处理阶段就失败 —— 而 `npm pack` 一路绿灯（pack 不跑 prepublishOnly）。
  const script = path.join(ROOT, 'tools', 'publish-dry-run.mjs');
  assert.ok(fs.existsSync(script), '要有发布自检脚本 tools/publish-dry-run.mjs');

  const { stdout } = await run(process.execPath, [script], { cwd: ROOT, timeout: 600_000 }).catch((error) => {
    assert.fail(`发布自检失败：\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`);
  });
  // 每个公开包都要被覆盖（10 个：内核 + 9 个 @actor/*）
  const covered = [...stdout.matchAll(/✓ (\S+?)@/g)].map((match) => match[1]);
  assert.strictEqual(covered.length, 10, `应当覆盖 10 个公开包，实际 ${String(covered.length)}：${covered.join(', ')}`);
  assert.ok(covered.includes('nodejs-actor-framework'), '内核也要覆盖');
  assert.match(stdout, /全部 10 个包的发布路径可用/);
});

test('打包形态: 各包的 prepublishOnly 都指向构建脚本，且 `--package .` 在包目录里可用', async () => {
  // 上一条是端到端；这条把"约定"钉死，出问题时定位更快
  const dirs = fs.readdirSync(path.join(ROOT, 'packages'));
  const offenders = [];
  for (const dir of dirs) {
    const file = path.join(ROOT, 'packages', dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.private === true) continue;
    if (manifest.scripts?.prepublishOnly === undefined) offenders.push(`${manifest.name} 没有 prepublishOnly`);
  }
  assert.deepStrictEqual(offenders, [], offenders.join('; '));

  // 真的站在包目录里跑一次（npm 就是这么调用的）
  const out = await run(process.execPath, ['../../tools/build-packages.mjs', '--package', '.'], {
    cwd: path.join(ROOT, 'packages', 'mail'),
    timeout: 240_000,
  });
  assert.match(out.stdout, /@actor\/mail/);
});

test('打包形态: 脚手架项目里 `npx actor ...` 仍然可用（CLI 保持 TS-only）', async () => {
  const project = path.join(ROOT, '.tmp-cli', `pkgshape-cli-${String(process.pid)}`);
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  try {
    await run(process.execPath, [CLI, 'new', 'app', project], { cwd: ROOT, env: devEnv() });
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
    assert.strictEqual(manifest.private, true, 'CLI 是私有包（不发布），因此不需要 dist 入口');
    assert.ok(fs.existsSync(path.join(project, 'main.ts')), '脚手架仍然生成可直接直跑的项目');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
