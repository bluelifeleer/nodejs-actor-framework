#!/usr/bin/env node
/**
 * `actor` 命令行（零依赖：参数解析、模板、输出都是自己写的）。
 *
 * 约定：**退出码有意义**（0 成功 / 1 用法错误 / 2 环境或用户操作问题），错误写 stderr 并给出
 * "下一步该做什么"；除非 `--debug` 不打印堆栈——堆栈对使用者没有信息量。
 */

import path from 'node:path';

import { UsageError, parseArgs } from './args.ts';
import { newApp } from './commands/new.ts';

const VERSION = '0.1.0';

function usage(): string {
  return [
    'actor —— actor 框架的命令行工具',
    '',
    '用法：',
    '  actor new app <dir> [--force]     生成可运行骨架（CRUD + Actor + 持久化 + 测试）',
    '  actor --help                      显示本帮助',
    '  actor --version                   显示版本',
    '',
    '约定：目标目录非空时会拒绝写入（除非 --force）；生成后不自动安装依赖。',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, { commandWords: ['new', 'app'] });

  if (parsed.flags.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.flags.help === true) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (parsed.command.length === 0) {
    // 给了位置参数但没有命令词 → 说清是哪个命令不认识（比直接糊一屏用法有用）
    if (parsed.positionals.length > 0) {
      throw new UsageError(`未知命令 '${parsed.positionals[0]}'`, '跑 `actor --help` 看支持的用法');
    }
    // 什么都没给：打印用法并给出**用法错误**的退出码（Unix 惯例，脚本里能区分）
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  const [first, second] = parsed.command;
  if (first === 'new' && second === 'app') {
    const result = await newApp(parsed.positionals[0] ?? '', { force: parsed.flags.force === true });
    process.stdout.write(`已生成 ${result.files.length} 个文件到 ${path.relative(process.cwd(), result.dir) || '.'}\n`);
    for (const file of result.files) process.stdout.write(`  ${file}\n`);
    process.stdout.write(`\n下一步：\n${result.nextSteps.map((step) => `  ${step}`).join('\n')}\n`);
    return 0;
  }

  if (first === 'new') {
    // `actor new service x`：命令词匹配到 new，但下一个词不是 app —— 把用户实际打的那个词报出来
    const scaffold = second ?? parsed.positionals[0] ?? '';
    throw new UsageError(`未知的脚手架 '${scaffold}'`, '目前只有：actor new app <dir>');
  }
  throw new UsageError(`未知命令 '${parsed.command.join(' ')}'`, '跑 `actor --help` 看支持的用法');
}

const debug = process.argv.includes('--debug');
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`actor: ${message}\n`);
  if (err instanceof UsageError && err.hint !== undefined) process.stderr.write(`提示：${err.hint}\n`);
  if (debug && err instanceof Error && err.stack !== undefined) process.stderr.write(`${err.stack}\n`);
  process.exitCode = err instanceof UsageError ? 1 : 2;
}
