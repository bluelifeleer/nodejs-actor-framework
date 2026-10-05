import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AssemblyError,
  createApp,
  defineApp,
  defineConfig,
  defineModule,
  definePlugin,
  type Application,
} from '../src/index.ts';

function tempConfigDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-plugin-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('plugin: setup 在 provider 解析与 Actor spawn 之前执行', async () => {
  const order: string[] = [];
  const app = createApp(
    defineApp({
      plugins: [
        definePlugin({
          name: 'audit',
          setup: () => {
            order.push('plugin.setup');
          },
          teardown: () => {
            order.push('plugin.teardown');
          },
        }),
      ],
      modules: [
        defineModule({
          name: 'main',
          providers: {
            p: {
              factory: () => {
                order.push('provider');
                return 1;
              },
            },
          },
          actors: {
            Echo: async (msg: unknown) => {
              order.push('actor');
              return msg;
            },
          },
          onStart: () => {
            order.push('module.onStart');
          },
          onStop: () => {
            order.push('module.onStop');
          },
        }),
      ],
    }),
    { configDir: tempConfigDir(), env: {} },
  );

  await app.start();
  assert.deepStrictEqual(order, ['plugin.setup', 'provider', 'module.onStart']);
  // Actor 确实已 spawn 且可用（spawn 发生在 module.onStart 之前）
  assert.strictEqual(await app.actor('Echo').ask('ping'), 'ping');
  assert.ok(order.includes('actor'), 'Actor 应能处理消息');
  await app.stop();
  assert.deepStrictEqual(order.slice(-2), ['module.onStop', 'plugin.teardown']);
});

test('plugin: 多个插件按声明顺序 setup、逆序 teardown', async () => {
  const order: string[] = [];
  const make = (name: string) =>
    definePlugin({
      name,
      setup: () => {
        order.push(`setup:${name}`);
      },
      teardown: () => {
        order.push(`teardown:${name}`);
      },
    });
  const app = createApp(
    defineApp({ plugins: [make('a'), make('b'), make('c')], modules: [defineModule({ name: 'm' })] }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app.start();
  await app.stop();
  assert.deepStrictEqual(order, [
    'setup:a',
    'setup:b',
    'setup:c',
    'teardown:c',
    'teardown:b',
    'teardown:a',
  ]);
});

test('plugin: 插件配置走同一套配置体系（默认值 + 环境变量覆盖 + secret 打码）', async () => {
  let received: Record<string, unknown> | null = null;
  const app = createApp(
    defineApp({
      plugins: [
        definePlugin({
          name: 'audit',
          config: {
            level: { type: 'string', default: 'info', enum: ['info', 'warn'] },
            apiKey: { type: 'string', default: '', secret: true },
          },
          setup: (_app: Application, config) => {
            received = config;
          },
        }),
      ],
      modules: [defineModule({ name: 'm' })],
    }),
    {
      configDir: tempConfigDir(),
      env: { APP_PLUGINS__AUDIT__LEVEL: 'warn', APP_PLUGINS__AUDIT__API_KEY: 'k-123' },
    },
  );

  await app.start();
  assert.deepStrictEqual(received, { level: 'warn', apiKey: 'k-123' });
  assert.strictEqual(
    app.config.redacted().plugins !== undefined &&
      ((app.config.redacted().plugins as Record<string, Record<string, unknown>>).audit)
        .apiKey,
    '***',
    '插件里的 secret 也应打码',
  );
  await app.stop();
});

test('plugin: 插件配置校验失败会在启动时报错（复用同一套校验）', async () => {
  const app = createApp(
    defineApp({
      plugins: [
        definePlugin({ name: 'audit', config: { level: { type: 'string', enum: ['info', 'warn'] } } }),
      ],
      modules: [defineModule({ name: 'm' })],
    }),
    { configDir: tempConfigDir(), env: { APP_PLUGINS__AUDIT__LEVEL: 'verbose' } },
  );
  await assert.rejects(
    () => app.start(),
    (err: unknown) => {
      assert.ok(err instanceof AssemblyError || err instanceof Error);
      assert.match(String((err as Error).message), /plugins\.audit\.level/);
      return true;
    },
  );
});

test('plugin: 重复声明同名插件会报错', async () => {
  const app = createApp(
    defineApp({
      plugins: [definePlugin({ name: 'dup' }), definePlugin({ name: 'dup' })],
      modules: [defineModule({ name: 'm' })],
    }),
    { configDir: tempConfigDir(), env: {} },
  );
  await assert.rejects(
    () => app.start(),
    (err: unknown) => {
      assert.match(String((err as Error).message), /插件 'dup' 被重复声明/);
      return true;
    },
  );
});
