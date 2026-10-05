import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, defineApp, defineModule, definePlugin } from '../src/index.ts';

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-hooks-'));
}

/** onReady 必须晚于模块 onStart（端口监听依赖 Actor 已就绪）；onStopping 必须早于 onStop。 */
test('plugin lifecycle: onReady 在 onStart 之后，onStopping 在 onStop 之前', async () => {
  const order: string[] = [];
  const app = createApp(
    defineApp({
      plugins: [
        definePlugin({
          name: 'entry',
          onReady: () => {
            order.push('plugin.onReady');
          },
          onStopping: () => {
            order.push('plugin.onStopping');
          },
          teardown: () => {
            order.push('plugin.teardown');
          },
        }),
      ],
      modules: [
        defineModule({
          name: 'm',
          actors: { Echo: async (msg: unknown) => msg },
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
  assert.deepStrictEqual(order, ['module.onStart', 'plugin.onReady']);
  await app.stop();
  assert.deepStrictEqual(order, [
    'module.onStart',
    'plugin.onReady',
    'plugin.onStopping',
    'module.onStop',
    'plugin.teardown',
  ]);
});
