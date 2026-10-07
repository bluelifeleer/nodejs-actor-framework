#!/usr/bin/env node
/**
 * `actor` 命令行（零依赖：参数解析、模板、输出都是自己写的）。
 *
 * 约定：**退出码有意义**（0 成功 / 1 用法错误 / 2 环境或用户操作问题），错误写 stderr 并给出
 * "下一步该做什么"；除非 `--debug` 不打印堆栈——堆栈对使用者没有信息量。
 */

import path from 'node:path';

import { UsageError, parseArgs } from './args.ts';
import type { Capability, WebPlugin } from './capabilities.ts';
import type { Layout } from './templates/app.ts';
import { doctor } from './commands/doctor.ts';
import { migrate } from './commands/migrate.ts';
import { addCapability } from './commands/add.ts';
import { newApp } from './commands/new.ts';
import { ProjectError } from './project/load.ts';

const VERSION = '0.1.0';

function usage(): string {
  return [
    'actor —— actor 框架的命令行工具',
    '',
    '用法：',
    '  actor new app <dir> [--layout layered|flat] [--with redis,mail] [--web-plugins upload,auth,debug] [--dry-run] [--force]',
    '  actor add <capability> [--web-plugin <name>] [--dir <项目目录>] [--dry-run]',
    '                                              给已有项目增量加能力（非破坏性；不覆盖已有片段）',
    '                                              生成可运行骨架（CRUD + Actor + 持久化 + 测试）',
    '                                              layered（默认）= 按业务分层；flat = 最小扁平形状',
    '  actor migrate status|up|down [--to <v>]      查看/应用/回滚迁移（默认项目目录 = 当前目录）',
    '  actor doctor                                 体检：Node/依赖/配置/数据目录/迁移/端口',
    '  actor --help | --version                     帮助与版本',
    '',
    '通用选项：--dir <path>（项目目录，默认当前目录）、--data <path>（数据目录，默认 APP_DATA_DIR 或 <dir>/data）、',
    '          --json（机器可读输出）、--debug（打印堆栈）',
    '',
    '约定：目标目录非空时会拒绝写入（除非 --force）；生成后不自动安装依赖；',
    '      退出码 0 成功 / 1 用法错误 / 2 环境或用户操作问题（doctor 有问题时退出码 2）。',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    commands: { new: ['app'], migrate: ['status', 'up', 'down'], doctor: [], add: [] },
  });

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
    const layout = typeof parsed.flags.layout === 'string' ? (parsed.flags.layout as Layout) : undefined;
    const capabilities =
      typeof parsed.flags['with'] === 'string'
        ? (parsed.flags['with']
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== '') as Capability[])
        : undefined;
    const webPlugins =
      typeof parsed.flags['web-plugins'] === 'string'
        ? (parsed.flags['web-plugins']
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== '') as WebPlugin[])
        : undefined;
    const result = await newApp(parsed.positionals[0] ?? '', {
      force: parsed.flags.force === true,
      ...(layout === undefined ? {} : { layout }),
      ...(webPlugins === undefined ? {} : { webPlugins }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(parsed.flags['dry-run'] === true ? { dryRun: true } : {}),
    });
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

  const projectDir = typeof parsed.flags.dir === 'string' ? parsed.flags.dir : process.cwd();
  const data = typeof parsed.flags.data === 'string' ? parsed.flags.data : undefined;
  const asJson = parsed.flags.json === true;

  if (first === 'add') {
    const projectDir = typeof parsed.flags.dir === 'string' ? parsed.flags.dir : process.cwd();
    const capabilities =
      typeof parsed.flags['with'] === 'string'
        ? (parsed.flags['with'].split(',').map((name) => name.trim()).filter((name) => name !== '') as Capability[])
        : [];
    // `--web-plugin auth` 与 `--with redis` 是两类东西（前者是 web 的插件选项）
    const webPlugins =
      typeof parsed.flags['web-plugin'] === 'string'
        ? (parsed.flags['web-plugin'].split(',').map((name) => name.trim()).filter((name) => name !== '') as WebPlugin[])
        : [];
    const result = await addCapability(projectDir, {
      capabilities,
      webPlugins,
      ...(parsed.flags.force === true ? { force: true } : {}),
      ...(parsed.flags['dry-run'] === true ? { dryRun: true } : {}),
    });
    process.stdout.write(
      `${result.dryRun ? '[dry-run] 计划' : '已增量添加'}到 ${path.relative(process.cwd(), result.dir) || '.'}\n`,
    );
    if (result.added.length > 0) process.stdout.write(`  新增片段：${result.added.join(', ')}\n`);
    if (result.skipped.length > 0) process.stdout.write(`  已有片段（跳过，不覆盖）：${result.skipped.join(', ')}\n`);
    process.stdout.write(`  依赖：${result.packages.join(', ')}\n`);
    process.stdout.write(`  文件：\n${result.files.map((file) => `    ${file}`).join('\n')}\n`);
    if (result.manualSteps.length > 0) {
      process.stdout.write(`\n需要你确认/配置：\n${result.manualSteps.map((step) => `  - ${step}`).join('\n')}\n`);
    }
    return 0;
  }

  if (first === 'migrate') {
    const action = second ?? parsed.positionals[0] ?? 'status';
    const to = typeof parsed.flags.to === 'string' ? Number(parsed.flags.to) : undefined;
    const result = await migrate(action, { dir: projectDir, ...(data === undefined ? {} : { data }), ...(to === undefined ? {} : { to }) });

    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const { status } = result;
      process.stdout.write(`项目 ${result.project}（数据目录 ${result.dataDir}）\n`);
      process.stdout.write(
        `已应用 ${status.applied.length ? status.applied.map((v) => `v${v}`).join(', ') : '(无)'}` +
          `；待应用 ${status.pending.length ? status.pending.map((v) => `v${v}`).join(', ') : '(无)'}\n`,
      );
      if (result.action === 'up') {
        const applied = (result.applied ?? []) as { version: number; description?: string }[];
        process.stdout.write(applied.length > 0 ? `本次应用：${applied.map((m) => `v${m.version}`).join(', ')}\n` : '没有需要应用的迁移\n');
      }
      if (result.action === 'down') {
        const rolled = (result.rolledBack ?? []) as { version: number }[];
        process.stdout.write(rolled.length > 0 ? `本次回滚：${rolled.map((m) => `v${m.version}`).join(', ')}\n` : '没有需要回滚的迁移\n');
      }
      for (const note of result.notes) process.stdout.write(`注意：${note}\n`);
    }
    // 有未应用/中断/数据更新时给出非零退出码：CI 与启动脚本要靠它
    const problematic = result.status.pending.length > 0 || result.status.interrupted.length > 0 || result.status.unknown.length > 0;
    if (action === 'status' && problematic) return 2;
    return 0;
  }

  if (first === 'doctor') {
    const portFlag = typeof parsed.flags.port === 'string' ? Number(parsed.flags.port) : undefined;
    const result = await doctor(projectDir, { ...(data === undefined ? {} : { data }), ...(portFlag === undefined ? {} : { port: portFlag }) });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`项目 ${result.project}（${result.dir}）\n\n`);
      for (const check of result.checks) {
        process.stdout.write(`${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}\n`);
        if (!check.ok && check.fix !== undefined) process.stdout.write(`    → ${check.fix}\n`);
      }
      process.stdout.write(
        result.problems === 0 ? '\n全部通过。\n' : `\n发现 ${result.problems} 个问题（上面带 → 的是下一步该做的事）。\n`,
      );
    }
    return result.problems === 0 ? 0 : 2;
  }

  throw new UsageError(`未知命令 '${parsed.command.join(' ')}'`, '跑 `actor --help` 看支持的用法');
}

const debug = process.argv.includes('--debug');
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`actor: ${message}\n`);
  // 提示不是 UsageError 的专利：ProjectError（目录不对、迁移导出有问题）也要告诉用户下一步
  const hint = (err as { hint?: unknown }).hint;
  if (typeof hint === 'string' && hint !== '') process.stderr.write(`提示：${hint}\n`);
  if (debug && err instanceof Error && err.stack !== undefined) process.stderr.write(`${err.stack}\n`);
  // 用法错误 1；项目/环境问题（ProjectError 等）2 —— 脚本能区分"我传错了"和"项目有问题"
  process.exitCode = err instanceof UsageError ? 1 : 2;
}
