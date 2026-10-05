import { test } from 'node:test';
import assert from 'node:assert';

import { MemoryPersistence } from 'nodejs-actor-framework';

import { createApp, defineApp, defineModule } from '../src/index.ts';
import { clusterPlugin } from '../src/plugins.ts';

/**
 * 应用层要为集群接管提供"路径 → 定义"（M4 第 3b 步）。
 *
 * 内核只知道 `spawn(definition, options)`；"这个 actorId 是哪个定义、用什么持久化选项"是应用层的
 * 知识。这里断言接线真的装上了——否则接管在新 owner 上会静默失败（`cluster_adoption_no_definition`）。
 */
test('app: 装了集群插件时，ownership.recreate 能按路径还原 Actor 的定义与 spawn 选项', async () => {
  const spec = defineApp({
    modules: [
      defineModule({
        name: 'm',
        actors: {
          Counter: {
            definition: {
              preStart() {
                // eslint-disable-next-line @typescript-eslint/no-this-alias
                (this as { state: { hits: number } }).state = { hits: 0 };
              },
              receive() {
                return 'ok';
              },
            },
            options: { persistence: { mode: 'snapshot', store: new MemoryPersistence() } },
          },
        },
      }),
    ],
    plugins: [clusterPlugin({ nodeId: 'app-node', port: 0 })],
  });

  const app = createApp(spec);
  try {
    await app.start();
    const ownership = (app.kernel as { ownership?: { recreate?: (path: string) => unknown } }).ownership;
    assert.ok(ownership, '集群插件应当装上 system.ownership');
    assert.strictEqual(typeof ownership?.recreate, 'function');

    const recreated = ownership?.recreate?.('Counter') as
      | { definition: unknown; options: Record<string, unknown> }
      | null;
    assert.ok(recreated, '已知路径要能还原出定义');
    assert.strictEqual(typeof recreated?.definition, 'object');
    assert.strictEqual(
      (recreated?.options.persistence as { mode?: string })?.mode,
      'snapshot',
      'spawn 选项也要带上（否则接管出来的 Actor 存不进去）',
    );
    assert.strictEqual(ownership?.recreate?.('不存在的路径'), null, '未知路径返回 null（内核据此报 no_definition）');
  } finally {
    await app.stop({ timeoutMs: 2000 }).catch(() => undefined);
  }
});
