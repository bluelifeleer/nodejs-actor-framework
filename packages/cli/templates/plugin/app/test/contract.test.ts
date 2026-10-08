import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, defineModule } from '@actor/app';

import { SERVICE, __PLUGIN_CAMEL__Plugin } from '../src/index.ts';

/**
 * __PLUGIN_NAME__ 的**行为契约**（自带，`npm test` 即自证）。
 *
 * 应用插件没有像 web/resource/mail 那样的"已发布契约套件"（它的契约就是**生命周期与配置**本身），
 * 所以这里直接对这两样下断言：钩子顺序、配置节生效、服务可被 ctx.get 取到、停机幂等。
 */

/** 起一个装了本插件的最小应用，跑完自动停止。 */
async function withApp(
  options: Parameters<typeof __PLUGIN_CAMEL__Plugin>[0],
  run: (app: ReturnType<typeof createApp>) => Promise<void>,
): Promise<void> {
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'main' })],
      plugins: [__PLUGIN_CAMEL__Plugin(options)],
    }),
    // 配置节名就是插件名（包名可能带 - 或 @scope/，所以键要加引号）
    { configDir: null, env: {}, overrides: { plugins: { '__PLUGIN_NAME__': { greeting: 'hi' } } } },
  );
  await app.start();
  try {
    await run(app);
  } finally {
    await app.stop();
  }
}

test('[app-plugin:__PLUGIN_NAME__] 插件名与配置节合法（name 是配置节名）', () => {
  const plugin = __PLUGIN_CAMEL__Plugin();
  assert.strictEqual(plugin.name, '__PLUGIN_NAME__');
  assert.ok(plugin.config !== undefined, '骨架自带配置节');
});

test('[app-plugin:__PLUGIN_NAME__] setup 注册服务，控制器/其它插件能取到', async () => {
  await withApp({}, async (app) => {
    const service = app.get<{ kind: string; greet: (who: string) => string }>(SERVICE);
    assert.strictEqual(service.kind, '__PLUGIN_NAME__');
    assert.strictEqual(service.greet('world'), 'hi, world', '配置里的 greeting 生效（overrides 覆盖默认值）');
  });
});

test('[app-plugin:__PLUGIN_NAME__] 生命周期顺序：setup → onReady → onStopping → teardown', async () => {
  const events: string[] = [];
  const logger = (event: string): void => {
    events.push(event);
  };
  await withApp({ logger }, async () => {
    // onReady 在 start() 返回前已经跑过
    assert.deepStrictEqual(events, ['__PLUGIN_CAMEL___setup', '__PLUGIN_CAMEL___ready']);
  });
  assert.deepStrictEqual(events, [
    '__PLUGIN_CAMEL___setup',
    '__PLUGIN_CAMEL___ready',
    '__PLUGIN_CAMEL___stopping',
    '__PLUGIN_CAMEL___teardown',
  ]);
});

test('[app-plugin:__PLUGIN_NAME__] 停机幂等（第二次 stop() 不再触发钩子）', async () => {
  const events: string[] = [];
  const app = createApp(
    defineApp({
      modules: [defineModule({ name: 'main' })],
      plugins: [__PLUGIN_CAMEL__Plugin({ logger: (event) => void events.push(event) })],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  await app.stop();
  const afterFirst = events.length;
  await app.stop();
  assert.strictEqual(events.length, afterFirst, '幂等：重复 stop 不该重复触发');
});

test('[app-plugin:__PLUGIN_NAME__] 选项优先于配置（显式给的就用给的）', async () => {
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'main' })], plugins: [__PLUGIN_CAMEL__Plugin({ greeting: 'hey' })] }),
    // 配置节名就是插件名（包名可能带 - 或 @scope/，所以键要加引号）
    { configDir: null, env: {}, overrides: { plugins: { '__PLUGIN_NAME__': { greeting: 'hi' } } } },
  );
  await app.start();
  try {
    assert.strictEqual(app.get<{ greet: (who: string) => string }>(SERVICE).greet('x'), 'hey, x');
  } finally {
    await app.stop();
  }
});
