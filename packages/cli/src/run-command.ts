/**
 * 自定义命令的**子进程入口**（P4）。
 *
 * 主 CLI 发现命令后用它拉起：`node run-command.mjs <项目目录> <命令名> [...args]`。
 * 与 `index.mjs` 同一套约定：退出码有意义、用法错误写 stderr 并给"下一步"、默认不打印堆栈。
 *
 * 为什么单独一个进程：自定义命令是用户代码，`process.exit()` / 抛错 / 死循环都不该影响主 CLI；
 * 独立进程还能被外层加超时与信号处理。
 */

import path from 'node:path';

import { UsageError } from './args.ts';
import { commandUsage, discoverCommands, parseCommandFlags } from './commands/custom.ts';

async function main(argv: readonly string[]): Promise<number> {
  const [projectDir, name, ...rest] = argv;
  if (projectDir === undefined || name === undefined) {
    process.stderr.write('用法：node run-command.mjs <项目目录> <命令名> [...参数]\n');
    return 1;
  }

  const found = (await discoverCommands(path.resolve(projectDir))).find((item) => item.spec.name === name);
  if (found === undefined) {
    process.stderr.write(`找不到自定义命令 '${name}'（在 ${path.resolve(projectDir)} 下发现 0 个同名命令）\n`);
    process.stderr.write('看一下有哪些：actor commands\n');
    return 1;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${commandUsage(found.spec)}\n`);
    return 0;
  }

  const { flags, positionals } = parseCommandFlags(found.spec, rest);
  const code = await found.spec.run({
    cwd: path.resolve(projectDir),
    args: positionals,
    flags,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  return typeof code === 'number' ? code : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      if (error.hint !== undefined) process.stderr.write(`\n${error.hint}\n`);
      process.exitCode = 1;
      return;
    }
    // 自定义命令自己抛的错：**完整堆栈**（它在开发，需要能定位）
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
