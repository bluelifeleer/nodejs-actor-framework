/**
 * 测试入口包装：给**整个进程树**加上 `development` 导出条件。
 *
 * 为什么需要包装而不只是 `node --test`：
 *   - 包的 `exports` 现在是"发布看 dist、仓库内看 src"（见各包 package.json）：
 *     `"." : { "development": "./src/index.ts", "default": "./dist/index.js" }`；
 *   - 测试会 spawn 子进程（CLI、脚手架项目、文档里的 verify 块、examples），
 *     子进程**不会**继承父进程的 `--conditions` 命令行参数，但会继承环境变量 ——
 *     所以把条件塞进 `NODE_OPTIONS`，一次设置、整棵树生效；
 *   - 于是仓库内跑测试**不需要先构建**（改了源码立刻生效），而发布出去的是编译产物。
 *
 * 额外参数会转发给 node（`npm test -- test/unit-x.test.js` 可只跑某个文件）。
 *
 * **先构建一次 dist**：内核与各包的默认入口是编译产物，而有些测试就是要验"发布形态"
 * （把包装进干净工程、用 dist 起应用、脚手架项目 typecheck 时按 `types` 解析到 `dist/*.d.ts`）。
 * 干净 checkout（CI / 新克隆）上 `dist/` 不存在，不先构建这些用例必挂 —— 2026-10 就这么红过一次。
 * 构建是增量的（12 包约 0.2 秒，冷启动约 2 秒），所以放在测试入口而不是 CI 配置里：
 * **本地和 CI 走同一条命令**，不会出现"CI 绿、本地绿、但干净克隆红"。
 */
import { spawn, spawnSync } from 'node:child_process';

/** 与之前 npm script 里完全相同的测试范围（改动它等于改测试覆盖面，别顺手改）。 */
const GLOBS = [
  'packages/cli/test/*.test.ts',
  'packages/testkit/test/*.test.ts',
  'packages/core/test/*.test.js',
  'packages/app/test/*.test.ts',
  'packages/web/test/*.test.ts',
  'packages/data/test/*.test.ts',
  'packages/resource/test/*.test.ts',
  'packages/db-core/test/*.test.ts',
  'packages/db/test/*.test.ts',
  'packages/redis/test/*.test.ts',
  'packages/mongodb/test/*.test.ts',
  'packages/mail/test/*.test.ts',
  'test/*.test.js',
];

if (process.env.SKIP_BUILD !== '1') {
  const build = spawnSync(process.execPath, [new URL('./build-packages.mjs', import.meta.url).pathname], {
    stdio: 'inherit',
    env: process.env,
  });
  if (build.status !== 0) {
    console.error('[test] 构建失败，先修构建再跑测试（想跳过：SKIP_BUILD=1 npm test）');
    process.exit(build.status ?? 1);
  }
}

// 单测超时 180 秒（不是 120）：最重的几条是"真起进程/真装包/真跑 verify"，
// 在共享 runner 或机器负载高时会明显变慢；120 秒曾把两个正常用例误判成超时（实测 378 秒那次是
// 我泄漏了一个 demo 服务在跑）。放宽到 180 秒是为了**不把慢当挂**，真挂住照样会被兜住。
const conditions = [process.env.NODE_OPTIONS, '--conditions=development'].filter(Boolean).join(' ');
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=180000', ...GLOBS, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: conditions },
});
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
