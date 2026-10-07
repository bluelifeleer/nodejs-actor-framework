/**
 * 命令行参数解析（零依赖）。
 *
 * 只支持这个 CLI 真正需要的东西：子命令、位置参数、`--flag`、`--key value`、`--key=value`。
 * 不做短选项合并、不做 `-abc` 展开——那些在 shell 里容易歧义，而"给框架用户的 CLI"不该在这里炫技。
 * 用法错误一律抛 `UsageError`，由 CLI 顶层统一转成 stderr + 退出码 1。
 */

export class UsageError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

export interface ParsedArgs {
  /** 子命令路径，例如 `['new', 'app']`。 */
  command: string[];
  /** 位置参数（子命令之后、非 flag 的部分）。 */
  positionals: string[];
  /** `--flag` = true；`--key value` / `--key=value` = 字符串。 */
  flags: Record<string, string | boolean>;
}

/** 已知的开关（有这些才算 flag，其余 `--x` 会报错——错拼一个选项不该被静默忽略）。 */
const KNOWN_FLAGS = new Set([
  'force', 'install', 'debug', 'json', 'help', 'version', 'dir', 'data', 'to', 'port', 'layout', 'web-plugins',
]);

/**
 * `commands` 是命令表：`{ new: ['app'], migrate: ['status', 'up', 'down'], doctor: [] }`。
 * 只匹配**已知**的词，所以 `actor new service x` 会得到 `command: ['new']` + 两个位置参数
 * （调用方据此报"未知的脚手架 'service'"），而不是静默吞掉用户打的字。
 */
export function parseArgs(argv: readonly string[], options: { commands: Record<string, readonly string[]> }): ParsedArgs {
  const command: string[] = [];
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let index = 0;
  const head = argv[index];
  if (head !== undefined && !head.startsWith('-') && Object.prototype.hasOwnProperty.call(options.commands, head)) {
    command.push(head);
    index += 1;
    const sub = argv[index];
    if (sub !== undefined && !sub.startsWith('-') && (options.commands[head] ?? []).includes(sub)) {
      command.push(sub);
      index += 1;
    }
  }

  for (; index < argv.length; index += 1) {
    const word = argv[index] as string;
    if (word === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!word.startsWith('--')) {
      positionals.push(word);
      continue;
    }
    const body = word.slice(2);
    const equals = body.indexOf('=');
    const name = equals === -1 ? body : body.slice(0, equals);
    if (!KNOWN_FLAGS.has(name)) {
      throw new UsageError(`未知选项 '--${name}'`, `已知选项：${[...KNOWN_FLAGS].sort().map((f) => `--${f}`).join(' ')}`);
    }
    if (equals !== -1) {
      flags[name] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--') && !KNOWN_FLAGS.has(next)) {
      // `--dir src` 这种形式：值不是另一个已知开关
      flags[name] = next;
      index += 1;
      continue;
    }
    flags[name] = true;
  }

  return { command, positionals, flags };
}
