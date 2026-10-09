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
import { GENERATE_KINDS, generate, parseField, type GenerateKind } from './commands/generate.ts';
import { missingMarkerHelp, MOUNT_MARKER } from './commands/mount.ts';
import { BUILTIN_COMMANDS, commandUsage, discoverCommands, renderCommands } from './commands/custom.ts';
import { migrate } from './commands/migrate.ts';
import { addCapability } from './commands/add.ts';
import { newPlugin } from './commands/new-plugin.ts';
import { newApp } from './commands/new.ts';
import { ProjectError } from './project/load.ts';

const VERSION = '0.1.0';

function usage(): string {
  return [
    'actor —— actor 框架的命令行工具',
    '',
    '用法：',
    '  actor new app <dir> [--layout layered|flat] [--with redis,mail] [--web-plugins upload,auth,debug] [--dry-run] [--force]',
    '  actor new plugin <name> --kind web|resource [--dir <父目录>] [--repo] [--dry-run] [--force]',
    '                                              生成能自证合规的插件包骨架（自带已发布契约套件的测试）',
    '  actor add <capability> [--web-plugin <name>] [--dir <项目目录>] [--dry-run]',
    '                                              给已有项目增量加能力（非破坏性；不覆盖已有片段）',
    '                                              生成可运行骨架（CRUD + Actor + 持久化 + 测试）',
    '                                              layered（默认）= 按业务分层；flat = 最小扁平形状',
    '  actor generate <kind> <name> [--field k:type]… [--optimistic-lock] [--migration-version <n>]',
    '                                [--no-test] [--dry-run] [--force] [--mount]',
    '                                              生成常用骨架（controller/actor/service/model/schema/middleware/test）',
    '                                              不覆盖已有文件；默认只打印 module.ts 的接线片段，',
    '                                              --mount 才自动插到 `// @actor:mount <槽位>` 标记后面（没有标记就提示你加）',
    '  actor migrate status|up|down [--to <v>]      查看/应用/回滚迁移（默认项目目录 = 当前目录）',
    '  actor doctor                                 体检：Node/依赖/配置/数据目录/迁移/端口',
    '  actor commands [--json]                      列出内置与**项目自定义**命令（.actor/commands/）',
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
  // 自定义命令（P4）走"**先看首词、直接子进程转发**"这条路：
  // 自定义命令的选项声明在用户代码里，主 CLI 的选项白名单**不该**去校验它们
  // （否则 `actor seed --count 3` 会在主进程就被"未知选项"挡掉 —— 实测踩到）。
  const customExit = await dispatchCustomCommand(argv);
  if (customExit !== null) return customExit;

  const parsed = parseArgs(argv, {
    commands: {
      new: ['app', 'plugin'],
      migrate: ['status', 'up', 'down'],
      doctor: [],
      add: [],
      generate: [...GENERATE_KINDS],
      commands: [],
      help: [],
    },
  });

  if (parsed.flags.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.flags.help === true) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  // `actor commands`：列出内置 + 项目自定义命令（自定义命令来自 .actor/commands/）
  if (parsed.command[0] === 'commands') {
    const dir = typeof parsed.flags.dir === 'string' ? parsed.flags.dir : process.cwd();
    let discovered: Awaited<ReturnType<typeof discoverCommands>> = [];
    try {
      discovered = await discoverCommands(path.resolve(dir));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      discovered = [];
    }
    process.stdout.write(renderCommands(discovered, { json: parsed.flags.json === true }));
    return 0;
  }

  if (parsed.command.length === 0) {
    // 给了位置参数但没有命令词 → 说清是哪个命令不认识（比直接糊一屏用法有用）。
    // 这里也要提一句"项目自定义命令"：用户最可能的意图就是他自己加的那个命令。
    if (parsed.positionals.length > 0) {
      const dirFlag = typeof parsed.flags.dir === 'string' ? parsed.flags.dir : undefined;
      let customCount = 0;
      try {
        customCount = (await discoverCommands(path.resolve(dirFlag ?? process.cwd()))).length;
      } catch {
        customCount = 0;
      }
      throw new UsageError(
        `未知命令 '${parsed.positionals[0]}'`,
        `跑 \`actor --help\` 看内置用法；项目自定义命令看 \`actor commands\`（当前发现 ${String(customCount)} 个）`,
      );
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

  if (first === 'new' && second === 'plugin') {
    const result = await newPlugin(parsed.positionals[0] ?? '', {
      ...(typeof parsed.flags.kind === 'string' ? { kind: parsed.flags.kind } : {}),
      ...(typeof parsed.flags.dir === 'string' ? { dir: parsed.flags.dir } : {}),
      ...(parsed.flags.force === true ? { force: true } : {}),
      ...(parsed.flags['dry-run'] === true ? { dryRun: true } : {}),
      ...(parsed.flags.repo === true ? { repo: true } : {}),
    });
    process.stdout.write(
      `${result.dryRun ? '[dry-run] 计划生成' : '已生成'} ${result.kind} 插件 ${result.name} → ${path.relative(process.cwd(), result.dir) || '.'}\n`,
    );
    for (const file of result.files) process.stdout.write(`  ${file}\n`);
    if (result.wiring.length > 0) process.stdout.write(`\n仓库内接线清单：\n${result.wiring.map((line) => `  - ${line}`).join('\n')}\n`);
    process.stdout.write(`\n下一步：cd ${path.relative(process.cwd(), result.dir) || '.'} && npm install && npm test\n`);
    return 0;
  }

  if (first === 'new') {
    // `actor new service x`：命令词匹配到 new，但下一个词不是 app —— 把用户实际打的那个词报出来
    const scaffold = second ?? parsed.positionals[0] ?? '';
    throw new UsageError(`未知的脚手架 '${scaffold}'`, '目前只有：actor new app <dir>');
  }

  const projectDir = typeof parsed.flags.dir === 'string' ? parsed.flags.dir : process.cwd();
  const projectDirFlag = typeof parsed.flags.dir === 'string' ? parsed.flags.dir : undefined;
  // 未知命令的报错要能告诉用户"项目里发现了几个自定义命令"
  const customName = parsed.positionals[0] ?? '';
  let custom: Awaited<ReturnType<typeof discoverCommands>> = [];
  try {
    custom = await discoverCommands(path.resolve(projectDir));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    custom = [];
  }
  const data = typeof parsed.flags.data === 'string' ? parsed.flags.data : undefined;
  const asJson = parsed.flags.json === true;

  if (first === 'add') {
    const projectDir = typeof parsed.flags.dir === 'string' ? parsed.flags.dir : process.cwd();
  const projectDirFlag = typeof parsed.flags.dir === 'string' ? parsed.flags.dir : undefined;
  // 未知命令的报错要能告诉用户"项目里发现了几个自定义命令"
  const customName = parsed.positionals[0] ?? '';
  let custom: Awaited<ReturnType<typeof discoverCommands>> = [];
  try {
    custom = await discoverCommands(path.resolve(projectDir));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    custom = [];
  }
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

  if (first === 'generate') {
    const rawKind = second ?? parsed.positionals.shift() ?? '';
    if (!(GENERATE_KINDS as readonly string[]).includes(rawKind)) {
      throw new UsageError(
        `未知的骨架 '${rawKind}'`,
        `可选：${GENERATE_KINDS.join(' / ')}（用法：actor generate <kind> <name>）`,
      );
    }
    const kind = rawKind as GenerateKind;
    const rawFields = parsed.flags.field;
    const fields = (Array.isArray(rawFields) ? rawFields : typeof rawFields === 'string' ? [rawFields] : [])
      .filter((raw): raw is string => typeof raw === 'string' && raw !== '')
      .map((raw) => parseField(raw));
    const result = await generate(kind, parsed.positionals[0] ?? '', {
      ...(projectDirFlag === undefined ? {} : { dir: projectDirFlag }),
      fields,
      ...(parsed.flags['optimistic-lock'] !== undefined ? { version: true } : {}),
      ...(parsed.flags.mount !== undefined ? { mount: true } : {}),
      ...(typeof parsed.flags['migration-version'] === 'string'
        ? { migrationVersion: Number(parsed.flags['migration-version']) }
        : {}),
      ...(parsed.flags.force === true ? { force: true } : {}),
      ...(parsed.flags['dry-run'] === true ? { dryRun: true } : {}),
      ...(parsed.flags['no-test'] !== undefined ? { test: false } : {}),
    });
    process.stdout.write(
      `${result.dryRun ? '[dry-run] 计划生成' : '已生成'} ${result.kind} 骨架 ${result.name}（${result.layout} 布局）\n`,
    );
    for (const file of result.files) process.stdout.write(`  + ${file}\n`);
    for (const file of result.skipped) process.stdout.write(`  = ${file}（已存在，跳过；要覆盖加 --force）\n`);
    // `--mount` 的结果：插了什么要说清（用户能在 git diff 里逐行核对）
    const mount = result.mount;
    if (mount !== undefined) {
      if (mount.note === 'no-wiring') {
        process.stdout.write(`\n${result.kind} 不需要接线：模型/表声明是用到的地方自己 import；测试与自定义命令各有自己的发现机制。\n`);
      } else if (mount.note === 'created') {
        process.stdout.write(`\n已新建 ${String(mount.file)}（含 \`${MOUNT_MARKER}\` 标记），并把接线插了进去。\n`);
      }
      if (mount.inserted.length > 0) {
        process.stdout.write(
          `\n${mount.dryRun ? '[dry-run] 会把' : '已把'}这些行插进 ${String(mount.file)}：\n` +
            `${mount.inserted.map((line) => `  + ${line.trim()}`).join('\n')}\n`,
        );
        if (mount.dryRun) process.stdout.write('（--dry-run：没有真的写盘）\n');
      }
      if (mount.alreadyPresent.length > 0 && mount.inserted.length === 0) {
        process.stdout.write(`\n接线已经在 ${String(mount.file)} 里了（幂等，没有重复插入）。\n`);
      }
      if (mount.note === 'missing-file') {
        process.stdout.write(
          `\n找不到 ${String(mount.file)}：这个项目的模块声明不在约定位置。\n` +
            '  请在模块声明文件里加上标记（`// @actor:mount imports` 等），或用 `--dir` 指定正确的项目目录；\n' +
            '  也可以按上面打印的片段手工合并。\n',
        );
      }
      if (mount.missingMarkers.length > 0) {
        process.stdout.write(`\n${missingMarkerHelp(String(mount.file), mount.missingMarkers)}\n`);
      }
    }

    // 没给 --mount（或没挂上）时，仍然把片段打出来 —— 手工合并永远可用
    const shouldPrintSnippet =
      result.snippet !== '' && (mount === undefined || mount.missingMarkers.length > 0 || mount.note === 'missing-file');
    if (shouldPrintSnippet) {
      process.stdout.write(`\n下一步：把下面这段合并进 src/module.ts${mount === undefined ? '（本命令不改你的代码；加 --mount 可自动插入标记处）' : ''}\n`);
      process.stdout.write(`${result.snippet.split('\n').map((line) => `  ${line}`).join('\n')}\n`);
    }
    if (result.skipped.length > 0) {
      process.stdout.write(`\n注意：有 ${String(result.skipped.length)} 个文件已存在而被跳过（没有覆盖你改过的代码）。\n`);
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

  // 走到这里说明：不是内置命令，也不是项目里的自定义命令
  throw new UsageError(
    `未知命令 '${customName}'`,
    `跑 \`actor --help\` 看内置用法；项目自定义命令看 \`actor commands\`（当前发现 ${String(custom.length)} 个）`,
  );
}

/**
 * 如果 argv 的首个位置参数是**项目自定义命令**，就在子进程里跑它并返回退出码；否则返回 null。
 *
 * 两条刻意的设计：
 *   1. **选项原样转发**（`--count 3` 直接给子进程，由子进程按自己的声明解析并报错）；
 *   2. 只从 argv 里手动取 `--dir`（项目定位），不解析其它选项（避免与自定义命令的选项冲突）。
 */
/** 去掉 `--dir <path>` / `--dir=<path>`（主 CLI 自己消费掉的选项，不转发给自定义命令）。 */
function stripDirFlag(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] as string;
    if (word === '--dir') {
      index += 1;
      continue;
    }
    if (word.startsWith('--dir=')) continue;
    out.push(word);
  }
  return out;
}

async function dispatchCustomCommand(argv: readonly string[]): Promise<number | null> {
  const words: string[] = [];
  let dir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] as string;
    if (word === '--dir') {
      dir = argv[index + 1];
      index += 1;
      continue;
    }
    if (word.startsWith('--dir=')) {
      dir = word.slice('--dir='.length);
      continue;
    }
    if (!word.startsWith('-')) words.push(word);
  }
  const name = words[0];
  if (name === undefined || BUILTIN_COMMANDS.includes(name)) return null;

  let discovered: Awaited<ReturnType<typeof discoverCommands>> = [];
  try {
    discovered = await discoverCommands(path.resolve(dir ?? process.cwd()));
  } catch (error) {
    if (error instanceof UsageError) throw error; // 命令定义本身有问题（重名/形状不对）→ 直接报
    discovered = [];
  }
  const found = discovered.find((item) => item.spec.name === name);
  if (found === undefined) return null; // 不是自定义命令：交回内置流程（由它报"未知命令"）

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${commandUsage(found.spec)}\n`);
    return 0;
  }

  // 只把**命令名之后的原始参数**转发给子进程（顺序与取值原样保留），并去掉主 CLI 自己的 `--dir`。
  // 两次踩坑都记在这：按"过滤 --dir"重建 argv 会漏掉选项的值；把位置参数也拼进来会重复转发。
  const nameIndex = argv.indexOf(name);
  const forwarded = stripDirFlag(argv.slice(nameIndex + 1));
  const runner = path.join(import.meta.dirname, 'run-command.ts');
  const { spawn } = await import('node:child_process');
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [runner, path.resolve(dir ?? process.cwd()), name, ...forwarded], { stdio: 'inherit' });
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
    child.on('error', () => resolve(2));
  });
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
