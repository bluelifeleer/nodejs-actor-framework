import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clusterPlugin,
  createApp,
  deadLettersPlugin,
  defineApp,
  defineModule,
  definePlugin,
  metricsPlugin,
  pubsubPlugin,
  rateLimitPlugin,
  tracingPlugin,
  type PluginSpec,
} from '../src/index.ts';

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-builtin-'));
}

test('builtin: 插件贡献的内核能力只在显式声明时才被装入', async () => {
  const installed: string[] = [];
  const fakeKernelPlugin = {
    name: 'fake',
    setup: () => {
      installed.push('fake');
    },
  };

  const withoutPlugin = createApp(defineApp({ modules: [defineModule({ name: 'm' })] }), {
    configDir: tempConfigDir(),
    env: {},
  });
  await withoutPlugin.start();
  await withoutPlugin.stop();
  assert.deepStrictEqual(installed, [], '未声明插件时不应装入任何内核能力');

  const contributor: PluginSpec = definePlugin({ name: 'fake-contrib', kernelPlugins: [fakeKernelPlugin] });
  const withPlugin = createApp(
    defineApp({
      plugins: [contributor],
      // 至少要有一个 Actor：内核的插件 setup 是懒执行的（首次 spawn/listen 才初始化）
      modules: [defineModule({ name: 'm', actors: { Echo: async (msg: unknown) => msg } })],
    }),
    { configDir: tempConfigDir(), env: {} },
  );
  await withPlugin.start();
  await withPlugin.stop();
  assert.deepStrictEqual(installed, ['fake'], '声明并由内核初始化后应真正 setup');
});

test('builtin: 六个内置能力包装都可用，且能被应用接受', async () => {
  const allSix = [
    metricsPlugin,
    tracingPlugin,
    deadLettersPlugin,
    rateLimitPlugin,
    pubsubPlugin,
    clusterPlugin,
  ];
  assert.strictEqual(allSix.length, 6);
  for (const factory of allSix) assert.strictEqual(typeof factory, 'function');

  const app = createApp(
    defineApp({
      plugins: [metricsPlugin()],
      modules: [
        defineModule({ name: 'm', actors: { Echo: async (msg: unknown) => `echo:${String(msg)}` } }),
      ],
    }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app.start();
  assert.strictEqual(await app.actor('Echo').ask('hi'), 'echo:hi', '启用内置插件后应用仍正常工作');
  await app.stop();
});

test('builtin: 插件包装生成的对象形状正确（name + kernelPlugins）', () => {
  const spec = metricsPlugin();
  assert.strictEqual(spec.name, 'metrics');
  assert.ok(Array.isArray(spec.kernelPlugins) && spec.kernelPlugins.length === 1);
});
