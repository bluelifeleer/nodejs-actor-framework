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

test('args: 带值选项吃掉下一个词——即使它看起来像已知开关（--web-plugin debug / --with debug）', () => {
  const commands = { add: [] as string[], new: ['app'] };
  const one = parseArgs(['add', '--web-plugin', 'debug'], { commands });
  assert.strictEqual(one.flags['web-plugin'], 'debug', '`debug` 是已知开关名，但它在这里是**值**');
  assert.strictEqual(one.flags['debug'], undefined, '不该同时把它当成开关');

  const two = parseArgs(['add', '--with', 'debug'], { commands });
  assert.strictEqual(two.flags['with'], 'debug');

  // 纯开关仍然正常
  const three = parseArgs(['add', '--dry-run', '--force'], { commands });
  assert.strictEqual(three.flags['dry-run'], true);
  assert.strictEqual(three.flags['force'], true);

  // `=` 形式也仍然正常
  const four = parseArgs(['add', '--web-plugin=upload,auth'], { commands });
  assert.strictEqual(four.flags['web-plugin'], 'upload,auth');
});
