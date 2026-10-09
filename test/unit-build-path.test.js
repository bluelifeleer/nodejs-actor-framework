import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * 部署双轨的门禁：**直跑 `.ts`** 与 **编译成 JS** 两条路都要真的能跑，且行为一致。
 *
 * 为什么需要这条门禁：`npm run build` 成功 ≠ 产物能跑。换到构建路线后最常踩的两个坑是
 *   ① 忘了把非 TS 资产（`config/` 里的 JSON/模板）拷进 `dist/` → 启动时报"配置目录不存在"；
 *   ② 源码里写的是 `./x.ts`，编译后没被改写成 `./x.js` → `ERR_MODULE_NOT_FOUND`。
 * 两者都只在"真的起一次产物"时才会暴露，所以这里真构建、真起、真发请求。
 */

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'src', 'cli.ts');

function tempProject(name) {
  const dir = path.join(ROOT, '.tmp-cli', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function childEnv() {
  const env = { ...process.env, APP_PLUGINS__HTTP__PORT: '0' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** 起一个入口（`main.ts` 或 `dist/main.js`），等它打印监听地址，返回 base 与子进程。 */
async function boot(project, entry) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [entry], { cwd: project, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`启动超时：\n${output}`)), 15_000);
    const onData = (chunk) => {
      output += String(chunk);
      const match = /listening on (?:[^:\s]+):(\d+)/.exec(output);
      if (match === null) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${match[1]}`);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出（code=${String(code)}）：\n${output}`));
    });
  });
  return { base, child, output: () => output };
}

/** 同组请求：状态码必须一致（直跑 vs 编译产物）。 */
async function probe(base) {
  const post = (body) =>
    fetch(`${base}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return [
    ['GET /health', (await fetch(`${base}/health`)).status],
    ['GET /nope', (await fetch(`${base}/nope`)).status],
    ['GET /notes?limit=5', (await fetch(`${base}/notes?limit=5`)).status],
    ['POST /notes 空体', (await post({})).status],
    ['POST /notes 合法', (await post({ title: 'x' })).status],
    ['PATCH /notes/1 版本不符', (await fetch(`${base}/notes/1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'y', expectedVersion: 99 }) })).status],
    ['DELETE /notes/1', (await fetch(`${base}/notes/1`, { method: 'DELETE' })).status],
    ['GET /counter', (await fetch(`${base}/counter`)).status],
  ];
}

test('部署双轨: 脚手架带 build/start:prod/smoke:prod 与两份 Dockerfile', async () => {
  const project = tempProject('build-files');
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    for (const script of ['build', 'start:prod', 'smoke:prod', 'start', 'typecheck']) {
      assert.ok(manifest.scripts[script] !== undefined, `脚手架缺少脚本：${script}`);
    }
    for (const file of ['tsconfig.build.json', 'scripts/copy-assets.mjs', 'scripts/smoke.mjs', 'Dockerfile', 'Dockerfile.direct', '.dockerignore', '.gitignore']) {
      assert.ok(fs.existsSync(path.join(project, file)), `脚手架缺少文件：${file}`);
    }
    // 构建配置必须开 rewriteRelativeImportExtensions（源码里到处是 `./x.ts`）
    const buildConfig = fs.readFileSync(path.join(project, 'tsconfig.build.json'), 'utf8');
    assert.match(buildConfig, /"rewriteRelativeImportExtensions":\s*true/);
    assert.match(buildConfig, /"outDir":\s*"dist"/);
    // dist 不该进版本库
    assert.match(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), /dist\//);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('部署双轨: 真构建 → 产物能起、/health 200、无 .ts 残留、直接跑冒烟脚本', async () => {
  const project = tempProject('build-run');
  let booted = null;
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);
    const built = await run('npm', ['run', 'build'], { cwd: project, env: childEnv(), timeout: 240_000 });
    assert.match(`${built.stdout}${built.stderr}`, /copy-assets|已拷贝/, '构建要包含资产拷贝这一步');

    // ① 产物存在
    for (const file of ['dist/main.js', 'dist/server.js', 'dist/config/default.js']) {
      assert.ok(fs.existsSync(path.join(project, file)), `构建产物缺少 ${file}`);
    }

    // ② 源码里的 `./x.ts` 必须都被改写成 `./x.js`（否则产物跑不起来）
    const leftovers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const match of text.matchAll(/from\s+'([^']+\.ts)'/g)) leftovers.push(`${path.relative(project, full)} → ${match[1]}`);
      }
    };
    walk(path.join(project, 'dist'));
    assert.deepStrictEqual(leftovers, [], `产物里不该残留 .ts 引用：${leftovers.join(', ')}`);

    // ③ 真起产物 + /health
    booted = await boot(project, 'dist/main.js');
    assert.strictEqual((await fetch(`${booted.base}/health`)).status, 200);

    // ④ 自带的生产冒烟脚本（部署流水线里会用到它）
    const smoke = await run('npm', ['run', 'smoke:prod'], { cwd: project, env: childEnv(), timeout: 120_000 });
    assert.match(`${smoke.stdout}${smoke.stderr}`, /\/health → 200/, 'smoke:prod 要真打一次 /health');
  } finally {
    booted?.child.kill('SIGKILL');
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('部署双轨: 直跑与编译产物**行为一致**（同组请求状态码完全相同）', async () => {
  const project = tempProject('build-parity');
  let direct = null;
  let compiled = null;
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);
    await run('npm', ['run', 'build'], { cwd: project, env: childEnv(), timeout: 240_000 });

    direct = await boot(project, 'main.ts');
    const directResults = await probe(direct.base);
    direct.child.kill('SIGKILL');

    compiled = await boot(project, 'dist/main.js');
    const compiledResults = await probe(compiled.base);

    assert.deepStrictEqual(
      compiledResults,
      directResults,
      `两条路的响应必须一致：\n直跑=${JSON.stringify(directResults)}\n产物=${JSON.stringify(compiledResults)}`,
    );
    assert.ok(directResults.some(([, status]) => status === 200), '探针要有成功的请求，否则一致性没意义');
    assert.ok(directResults.some(([, status]) => status >= 400), '探针要覆盖失败路径（校验/404）');
  } finally {
    direct?.child.kill('SIGKILL');
    compiled?.child.kill('SIGKILL');
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('部署双轨: doctor 看得出"产物陈旧"与"缺资产"，没有 dist 时不误报', async () => {
  const project = tempProject('build-doctor');
  try {
    await run(process.execPath, [CLI, 'new', 'app', project]);
    const checkOf = async () => {
      const { stdout } = await run(process.execPath, [CLI, 'doctor', '--dir', project, '--port', '0', '--json'], {
        cwd: project,
        env: childEnv(),
      }).catch((error) => error);
      const parsed = JSON.parse(String(stdout));
      const found = parsed.checks.find((check) => check.name === '生产构建');
      assert.ok(found !== undefined, `doctor 要有「生产构建」一节：${parsed.checks.map((c) => c.name).join(', ')}`);
      return found;
    };

    // ① 还没构建：不是问题（走直跑路线的项目本来就没有 dist）
    const before = await checkOf();
    assert.strictEqual(before.ok, true);
    assert.match(before.detail, /还没有 dist/);

    // ② 构建之后：通过
    await run('npm', ['run', 'build'], { cwd: project, env: childEnv(), timeout: 240_000 });
    assert.strictEqual((await checkOf()).ok, true);

    // ③ 改了源码没重建 → 陈旧，要报出来并给"重新构建"
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(path.join(project, 'src', 'module.ts'), '\n// 改了点东西\n');
    const stale = await checkOf();
    assert.strictEqual(stale.ok, false, '陈旧产物必须报出来');
    assert.match(stale.detail, /dist 比源码旧/);
    assert.match(stale.fix ?? '', /npm run build/);

    // ④ 有非 TS 资产但没拷进 dist → 报"缺资产"（这正是启动失败的第一个坑）
    fs.writeFileSync(path.join(project, 'config', 'extra.json'), '{"a":1}\n');
    await run('npm', ['run', 'build'], { cwd: project, env: childEnv(), timeout: 240_000 });
    const assetOk = await checkOf();
    assert.strictEqual(assetOk.ok, true, '重新构建会把新资产拷进 dist');
    fs.rmSync(path.join(project, 'dist', 'config', 'extra.json'));
    const missing = await checkOf();
    assert.strictEqual(missing.ok, false);
    assert.match(missing.detail, /缺少非 TS 资产：extra\.json/);
    assert.match(missing.fix ?? '', /copy-assets/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
