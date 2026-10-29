/**
 * **自定义命令**（P4）：让项目可以往 `actor` 里加自己的子命令。
 *
 * 发现位置（三处，都在**项目自己声明过**的范围里）：
 *   `<项目>/.actor/commands.ts`        —— 集中声明（推荐，类型与 IDE 都友好）
 *   `<项目>/.actor/commands/*.ts`      —— 一个文件一个命令（每个文件 default 导出一个 spec）
 *   `node_modules/actor-command-*`     —— npm 包（**必须**在项目 package.json 的 dependencies 里，
 *                                        或在 `"actor": { "commands": ["..."] }` 里显式列出）
 *
 * 为什么不扫遍 node_modules：加载一个包就是执行它的代码。只认"这个项目自己声明过的依赖"，
 * 才能把"谁有权在你的 CLI 进程里跑代码"这个问题答清楚。
 *
 * 为什么**子进程执行**：自定义命令是用户代码，`process.exit()` / 未捕获异常 / 阻塞事件循环
 * 都不该把主 CLI 带崩，而且独立进程能加超时与清晰的退出码。代价是拿不到主进程的内存状态
 * —— 但命令本来就该自己读文件/连库，不该依赖 CLI 的进程内状态。
 *
 * 约定（与内置命令一致）：退出码 0 成功 / 1 用法错误 / 2 环境问题；`--help` 自动可用。
 */

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';

import { UsageError } from '../args.ts';

/** 选项声明（自定义命令里 `flags` 的值）。 */
export type CommandFlagType = 'string' | 'number' | 'boolean';

export interface CommandFlagSpec {
  type: CommandFlagType;
  /** 缺省值（给了就不必传）。 */
  default?: string | number | boolean;
  description?: string;
}

export interface CommandContext {
  /** 项目根（解析 `--dir` 之后）。 */
  cwd: string;
  /** 位置参数（命令名之后的非选项部分）。 */
  args: readonly string[];
  /** 解析后的选项（带默认值）。 */
  flags: Record<string, string | number | boolean>;
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CommandSpec {
  /** 子命令名（`actor <name>`）。 */
  name: string;
  /** 一行说明（`actor commands` 与 `--help` 用）。 */
  summary?: string;
  /** 用法行（例如 `actor seed [--count 100]`）。 */
  usage?: string;
  /** 选项声明：解析 + `--help` + 默认值都靠它。 */
  flags?: Record<string, CommandFlagSpec>;
  /** 跑命令；返回值是退出码（不返回视为 0）。抛 `UsageError` → 退出码 1。 */
  run(context: CommandContext): number | void | Promise<number | void>;
}

/** 声明一个自定义命令（目前是**恒等 + 校验**：定义期就能发现"名字/summary 忘了写"）。 */
export function defineCommand(spec: CommandSpec): CommandSpec {
  if (typeof spec?.name !== 'string' || spec.name.trim() === '') {
    throw new UsageError('defineCommand: "name" 是必需项', '例如：defineCommand({ name: "seed", async run() {} })');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) {
    throw new UsageError(
      `defineCommand: 命令名不合法 '${spec.name}'`,
      '用小写 kebab-case（字母开头，可含数字与 -）：例如 seed / import-data',
    );
  }
  if (typeof spec.run !== 'function') {
    throw new UsageError(`defineCommand("${spec.name}"): "run" 必须是函数`);
  }
  for (const [name, flag] of Object.entries(spec.flags ?? {})) {
    if (!['string', 'number', 'boolean'].includes(flag?.type)) {
      throw new UsageError(
        `defineCommand("${spec.name}"): 选项 '--${name}' 的 type 必须是 string|number|boolean（拿到 '${String(flag?.type)}'）`,
      );
    }
  }
  return spec;
}

/** 发现结果：命令 + 它从哪来（`actor commands` 与 doctor 都要显示来源）。 */
export interface DiscoveredCommand {
  spec: CommandSpec;
  /** 相对项目根的文件（或 "(programmatic)"）。 */
  source: string;
}

/** 内置命令名（自定义命令**不许**与之重名 —— 否则用户不知道自己调的是谁）。 */
export const BUILTIN_COMMANDS: readonly string[] = ['new', 'generate', 'add', 'migrate', 'doctor', 'commands', 'help'];

const COMMANDS_DIR = path.join('.actor', 'commands');
const COMMANDS_FILE = path.join('.actor', 'commands.ts');
/** npm 命令包的命名约定（也允许在 `actor.commands` 里显式列出别的名字）。 */
const COMMAND_PACKAGE_PREFIX = 'actor-command-';

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 带**缓存键**地导入一个命令文件。
 *
 * 为什么需要：`import()` 是按 URL 缓存的，同一个进程里第二次发现会拿到**旧模块**
 * （实测：测试里先写 `alpha/beta` 再改写文件，发现结果还是旧的 —— 这是真 bug，不只是测试问题：
 * 长驻进程/`doctor` 反复扫描时会看到过期内容）。用文件 mtime 当 query 即可让 Node 重新加载。
 */
async function importFresh(file: string): Promise<Record<string, unknown>> {
  let key = '0';
  try {
    key = String(statSync(file).mtimeMs);
  } catch {
    /* 读不到 mtime 就退化成普通导入 */
  }
  const url = `${pathToFileURL(file).href}?v=${key}`;
  return (await import(url)) as Record<string, unknown>;
}

function specFrom(value: unknown, source: string): CommandSpec {
  const candidate = (value as { default?: unknown })?.default ?? value;
  if (typeof candidate !== 'object' || candidate === null || typeof (candidate as CommandSpec).run !== 'function') {
    throw new UsageError(
      `${source} 没有 default 导出一个命令（需要 { name, run }）`,
      '用 defineCommand({ name: "seed", run() {} }) 声明，并 export default it',
    );
  }
  return candidate as CommandSpec;
}

/**
 * 发现项目里的自定义命令（**不去公网找包**：只认项目内的两处，安全面最小）。
 *
 * 返回按名字排序；重名（含与内置命令重名）**明确报错**，不静默取一个。
 */
const DISCOVERY_MARKER = '__ACTOR_DISCOVERY_JSON__';
const execFileAsync = promisify(execFile);

/**
 * 在**子进程**里发现命令：`actor commands` / 未知命令提示只需要元数据，
 * 而用户命令文件可能 `process.exit()` / 崩溃 —— 绝不能把主 CLI 一起带走。
 * 子进程只回传 name/summary/usage/flags/source（run 是函数，无法也无需序列化）。
 */
async function discoverInChild(projectDir: string): Promise<DiscoveredCommand[]> {
  const self = import.meta.filename;
  const script = `
import { pathToFileURL } from 'node:url';
const self = process.env.ACTOR_DISCOVERY_SELF;
const dir = process.env.ACTOR_DISCOVERY_DIR;
const mod = await import(pathToFileURL(self).href);
try {
  const found = await mod.discoverCommands(dir, true);
  const out = found.map(({ spec, source }) => ({
    source,
    spec: { name: spec.name, summary: spec.summary, usage: spec.usage, flags: spec.flags },
  }));
  process.stdout.write('\\n${DISCOVERY_MARKER}' + JSON.stringify({ ok: true, found: out }));
} catch (err) {
  process.stdout.write('\\n${DISCOVERY_MARKER}' + JSON.stringify({
    ok: false,
    error: { message: err?.message ?? String(err), hint: err?.hint, name: err?.name },
  }));
}
`;
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        ACTOR_DISCOVERY_CHILD: '1',
        ACTOR_DISCOVERY_SELF: self,
        ACTOR_DISCOVERY_DIR: projectDir,
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    const start = stdout.indexOf(DISCOVERY_MARKER);
    if (start < 0) throw new Error(`自定义命令发现子进程没有返回结果：${stdout.slice(-500)}`);
    const parsed = JSON.parse(stdout.slice(start + DISCOVERY_MARKER.length)) as
      | { ok: true; found: Array<{ source: string; spec: Omit<CommandSpec, 'run'> }> }
      | { ok: false; error: { message?: string; hint?: string; name?: string } };
    if (parsed.ok !== true) {
      const error = new UsageError(parsed.error.message ?? '自定义命令发现失败', parsed.error.hint);
      if (parsed.error.name !== 'UsageError') error.name = parsed.error.name ?? 'Error';
      throw error;
    }
    return parsed.found.map((item) => ({ source: item.source, spec: item.spec as CommandSpec }));
  } catch (err) {
    if (err instanceof UsageError) throw err;
    const error = err as { stderr?: string; message?: string };
    throw new Error(`自定义命令发现失败（子进程）：${String(error.stderr ?? error.message ?? err)}`);
  }
}

export async function discoverCommands(projectDir: string, internal = false): Promise<DiscoveredCommand[]> {
  if (!internal && process.env.ACTOR_DISCOVERY_CHILD !== '1') return discoverInChild(projectDir);
  const found: DiscoveredCommand[] = [];
  const seen = new Map<string, string>();

  const add = (spec: CommandSpec, source: string): void => {
    if (BUILTIN_COMMANDS.includes(spec.name)) {
      throw new UsageError(
        `自定义命令 '${spec.name}' 与内置命令重名（${source}）`,
        `换一个名字（内置：${BUILTIN_COMMANDS.join(' / ')}）`,
      );
    }
    const previous = seen.get(spec.name);
    if (previous !== undefined) {
      throw new UsageError(
        `自定义命令 '${spec.name}' 重复定义：${previous} 与 ${source}`,
        '命令名必须唯一（否则不知道该跑哪个）',
      );
    }
    seen.set(spec.name, source);
    found.push({ spec, source });
  };

  const barrel = path.join(projectDir, COMMANDS_FILE);
  if (await exists(barrel)) {
    const module = await importFresh(barrel);
    const exported = module['commands'] ?? module['default'];
    if (Array.isArray(exported)) {
      for (const item of exported) {
        const spec = specFrom(item, COMMANDS_FILE);
        add(spec, COMMANDS_FILE);
      }
    } else if (exported !== undefined) {
      const spec = specFrom(exported, COMMANDS_FILE);
      add(spec, COMMANDS_FILE);
    }
  }

  for (const entry of await resolveCommandPackages(projectDir)) {
    const module = await importFresh(entry.entry);
    const exported = module['commands'] ?? module['default'];
    const list = Array.isArray(exported) ? exported : [exported];
    for (const item of list) {
      if (item === undefined) continue;
      add(specFrom(item, `npm:${entry.name}`), `npm:${entry.name}`);
    }
  }

  const dir = path.join(projectDir, COMMANDS_DIR);
  if (await exists(dir)) {
    const entries = (await fs.readdir(dir)).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts')).sort();
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const module = await importFresh(full);
      const spec = specFrom(module, `${COMMANDS_DIR}/${entry}`);
      add(spec, `${COMMANDS_DIR}/${entry}`);
    }
  }

  return found.sort((left, right) => left.spec.name.localeCompare(right.spec.name));
}

/**
 * 解析项目声明的**命令包**（npm 来源）。
 *
 * 只认两处声明，绝不通扫 node_modules：
 *   1. `package.json` 的 `dependencies` 里名字符合 `actor-command-*` 的包；
 *   2. `package.json` 的 `"actor": { "commands": ["<包名>", …] }` —— 显式白名单（名字不必带前缀）。
 *
 * 包内入口优先级：`package.json` 的 `"actor": { "commandsModule": "<相对路径>" }` → `exports["./commands"]` → 包根（读它的 `main`/`exports["."]`/`index.ts`）。
 * 包不在 `node_modules` 里就跳过（没装依赖时不该报错 —— 与 `new app` 不自动安装的纪律一致）。
 */
async function resolveCommandPackages(projectDir: string): Promise<Array<{ name: string; entry: string }>> {
  const manifestPath = path.join(projectDir, 'package.json');
  if (!(await exists(manifestPath))) return [];
  let manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    actor?: { commands?: unknown; commandsModule?: string };
  };
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    return [];
  }

  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  const explicit = Array.isArray(manifest.actor?.commands)
    ? manifest.actor.commands.filter((item): item is string => typeof item === 'string')
    : [];
  const names = [...declared].filter((name) => name.startsWith(COMMAND_PACKAGE_PREFIX)).concat(explicit);

  const out: Array<{ name: string; entry: string }> = [];
  for (const name of [...new Set(names)]) {
    if (name.includes('/') && !name.startsWith('@')) continue; // 只接受包名（不接任意相对路径）
    const packageDir = path.join(projectDir, 'node_modules', name);
    if (!(await exists(packageDir))) continue; // 没装就跳过
    let packageManifest: { main?: string; module?: string; exports?: Record<string, unknown>; actor?: { commandsModule?: string } } = {};
    try {
      packageManifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')) as typeof packageManifest;
    } catch {
      continue;
    }
    const relative =
      packageManifest.actor?.commandsModule ??
      (typeof packageManifest.exports?.['./commands'] === 'string' ? String(packageManifest.exports['./commands']) : undefined) ??
      (typeof packageManifest.exports?.['.'] === 'string' ? String(packageManifest.exports['.']) : undefined) ??
      packageManifest.main ??
      packageManifest.module ??
      (await exists(path.join(packageDir, 'index.ts')) ? 'index.ts' : 'index.js');
    const entry = path.resolve(packageDir, relative);
    if (await exists(entry)) out.push({ name, entry });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

/** 把 `--key value` / `--flag` 按声明解析成选项（未知选项直接报错，不静默吞）。 */
export function parseCommandFlags(
  spec: CommandSpec,
  argv: readonly string[],
): { flags: Record<string, string | number | boolean>; positionals: string[] } {
  const declared = spec.flags ?? {};
  const flags: Record<string, string | number | boolean> = {};
  for (const [name, flag] of Object.entries(declared)) {
    if (flag.default !== undefined) flags[name] = flag.default;
  }
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] as string;
    if (!word.startsWith('--')) {
      positionals.push(word);
      continue;
    }
    const equals = word.indexOf('=');
    const name = (equals === -1 ? word.slice(2) : word.slice(2, equals)).trim();
    const flag = declared[name];
    if (flag === undefined) {
      throw new UsageError(
        `未知选项 '--${name}'（命令 '${spec.name}'）`,
        Object.keys(declared).length === 0
          ? `'${spec.name}' 没有声明任何选项`
          : `可用选项：${Object.keys(declared).map((item) => `--${item}`).join(' ')}`,
      );
    }
    if (flag.type === 'boolean') {
      flags[name] = equals === -1 ? true : word.slice(equals + 1) !== 'false';
      continue;
    }
    const raw = equals === -1 ? argv[(index += 1)] : word.slice(equals + 1);
    if (raw === undefined || raw.startsWith('--')) {
      throw new UsageError(`选项 '--${name}' 需要一个值（命令 '${spec.name}'）`);
    }
    if (flag.type === 'number') {
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) throw new UsageError(`选项 '--${name}' 需要数字（拿到 '${raw}'）`);
      flags[name] = parsed;
      continue;
    }
    flags[name] = raw;
  }
  return { flags, positionals };
}

/** `--help` 文本（自定义命令与内置命令同款）。 */
export function commandUsage(spec: CommandSpec): string {
  const lines = [`actor ${spec.name}`, ''];
  if (spec.summary !== undefined) lines.push(spec.summary, '');
  lines.push(`用法：${spec.usage ?? `actor ${spec.name} [选项]`}`);
  const flags = Object.entries(spec.flags ?? {});
  if (flags.length > 0) {
    lines.push('', '选项：');
    for (const [name, flag] of flags) {
      const fallback = flag.default === undefined ? '' : `（默认 ${JSON.stringify(flag.default)}）`;
      lines.push(`  --${name} <${flag.type}>${fallback}${flag.description === undefined ? '' : `  ${flag.description}`}`);
    }
  }
  return lines.join('\n');
}

/** 把发现到的命令渲染成 `actor commands` 的输出。 */
export function renderCommands(commands: readonly DiscoveredCommand[], options: { json?: boolean } = {}): string {
  if (options.json === true) {
    return `${JSON.stringify(
      {
        builtin: BUILTIN_COMMANDS,
        custom: commands.map((item) => ({
          name: item.spec.name,
          summary: item.spec.summary ?? '',
          usage: item.spec.usage ?? `actor ${item.spec.name}`,
          flags: Object.keys(item.spec.flags ?? {}),
          source: item.source,
        })),
      },
      null,
      2,
    )}\n`;
  }
  const lines = [`内置命令：${BUILTIN_COMMANDS.join(' / ')}`, ''];
  if (commands.length === 0) {
    lines.push('没有自定义命令。加一个：actor generate command <name>（写到 .actor/commands/<name>.ts）');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`自定义命令（${String(commands.length)} 个）：`);
  for (const item of commands) {
    lines.push(`  ${item.spec.name.padEnd(16)} ${item.spec.summary ?? ''}`);
    lines.push(`  ${''.padEnd(16)} 来源：${item.source}`);
  }
  return `${lines.join('\n')}\n`;
}
