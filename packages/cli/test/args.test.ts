import { test } from 'node:test';
import assert from 'node:assert';

import { UsageError, parseArgs } from '../src/args.ts';

const words = { commands: { new: ['app'], migrate: ['status', 'up', 'down'], doctor: [] } } as const;

test('cli args: 子命令 + 位置参数 + --flag / --key value / --key=value', () => {
  const parsed = parseArgs(['new', 'app', 'my-app', '--force'], words);
  assert.deepStrictEqual(parsed.command, ['new', 'app']);
  assert.deepStrictEqual(parsed.positionals, ['my-app']);
  assert.strictEqual(parsed.flags.force, true);

  const withValue = parseArgs(['new', 'app', 'dir', '--debug'], words);
  assert.strictEqual(withValue.flags.debug, true);

  assert.deepStrictEqual(parseArgs(['--version'], words).flags, { version: true });
  assert.deepStrictEqual(parseArgs(['new', 'app', 'a', 'b'], words).positionals, ['a', 'b']);
});

test('cli args: 未知选项要报错（错拼一个选项不该被静默忽略）', () => {
  assert.throws(
    () => parseArgs(['new', 'app', 'x', '--forse'], words),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.match((err as Error).message, /未知选项 '--forse'/);
      assert.match((err as UsageError).hint ?? '', /--force/, '提示里要列出已知选项');
      return true;
    },
  );
});

test('cli args: `--` 之后一律当位置参数（目录名以 - 开头时用得上）', () => {
  const parsed = parseArgs(['new', 'app', '--', '--weird-dir'], words);
  assert.deepStrictEqual(parsed.positionals, ['--weird-dir']);
  assert.deepStrictEqual(parsed.flags, {});
});

test('cli args: 子命令词不匹配时不吞掉位置参数', () => {
  const parsed = parseArgs(['new', 'service', 'x'], words);
  assert.deepStrictEqual(parsed.command, ['new'], '只匹配到 new');
  assert.deepStrictEqual(parsed.positionals, ['service', 'x']);
});

test('cli args: 命令表驱动 —— migrate 的动作词、doctor 无子命令', () => {
  assert.deepStrictEqual(parseArgs(['migrate', 'up'], words).command, ['migrate', 'up']);
  assert.deepStrictEqual(parseArgs(['migrate'], words).command, ['migrate']);
  assert.deepStrictEqual(parseArgs(['migrate', 'rollback'], words).command, ['migrate'], '未知动作不当子命令');
  assert.deepStrictEqual(parseArgs(['migrate', 'rollback'], words).positionals, ['rollback']);
  assert.deepStrictEqual(parseArgs(['doctor', '--json'], words).command, ['doctor']);
  assert.deepStrictEqual(parseArgs(['migrate', 'down', '--to', '3'], words).flags, { to: '3' });
});
