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
 */
import { spawn } from 'node:child_process';

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

const conditions = [process.env.NODE_OPTIONS, '--conditions=development'].filter(Boolean).join(' ');
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', ...GLOBS, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: conditions },
});
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
