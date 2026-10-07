import { test } from 'node:test';
import assert from 'node:assert';

import { createApp, defineApp, definePlugin } from '../src/index.ts';

/**
 * 审计（里程碑 M1）：设计文档写"插件依赖成环时启动失败并打印环"，但 `PluginSpec` 一直没有
 * `requires`/`provides`，这条验收**根本没实现**（当时只有 provider/DI 级的环检测）。
 */
function makeApp(plugins: readonly ReturnType<typeof definePlugin>[]) {
  return createApp(
    defineApp({ name: 'plugin-graph', modules: [], plugins }),
    { configDir: null },
  );
}

test('plugin graph: 依赖成环时启动失败，并把环打印出来', async () => {
  const a = definePlugin({ name: 'a', requires: ['b'] });
  const b = definePlugin({ name: 'b', requires: ['a'] });
  const app = makeApp([a, b]);
  await assert.rejects(
    () => app.start(),
    (err: Error) => {
      assert.match(err.message, /插件循环依赖/);
      assert.match(err.message, /a -> b -> a|b -> a -> b/);
      return true;
    },
  );
});

test('plugin graph: 未知依赖要在启动时明确指出', async () => {
  const lonely = definePlugin({ name: 'lonely', requires: ['nobody'] });
  const app = makeApp([lonely]);
  await assert.rejects(() => app.start(), /依赖未知能力 'nobody'/);
});

test('plugin graph: 声明顺序无关，setup 按依赖顺序执行（被依赖者先跑）', async () => {
  const order: string[] = [];
  const base = definePlugin({ name: 'base', provides: ['storage'], setup: () => void order.push('base') });
  const app = makeApp([
    // 故意把依赖方写在前面：拓扑排序必须纠正它
    definePlugin({ name: 'consumer', requires: ['storage'], setup: () => void order.push('consumer') }),
    base,
  ]);
  await app.start();
  try {
    assert.deepStrictEqual(order, ['base', 'consumer'], `setup 顺序不对：${JSON.stringify(order)}`);
  } finally {
    await app.stop({ timeoutMs: 500 }).catch(() => {});
  }
});
