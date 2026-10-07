import { test } from 'node:test';
import assert from 'node:assert';

import {
  realDatabaseUrl,
  runManagedConnectionContract,
  supervise,
  type ContractResourceFactory,
} from '@actor/db-core';

import { defineCollection, mongoAdapter } from '../src/index.ts';

/**
 * **真库用例**：设了 `ACTOR_TEST_MONGO_URL` 才跑，否则**显式跳过**。
 *
 * 起库：`node scripts/dev-databases.mjs up mongo` 然后 `eval "$(node scripts/dev-databases.mjs env)"`。
 * ⚠️ 本环境离线无 docker、也没有 mongo 服务 → 这里必然跳过。
 */
const url = realDatabaseUrl('ACTOR_TEST_MONGO_URL');
const skipped = 'ACTOR_TEST_MONGO_URL not set（真库用例：先 node scripts/dev-databases.mjs up mongo）';

const Probe = defineCollection({
  name: `actor_probe_${process.pid}`,
  fields: {
    note: { type: 'string', required: true },
    at: { type: 'date', auto: 'create' },
  },
  indexes: [{ fields: ['note'] }],
  validator: { strict: true },
});

if (url === undefined) {
  test('real(mongodb): 连接管理契约', { skip: skipped }, () => {});
  test('real(mongodb): defineCollection sync + CRUD 往返 + 清理', { skip: skipped }, () => {});
} else {
  const make: ContractResourceFactory = (input) =>
    supervise(mongoAdapter(), {
      connection: { url },
      onEvent: input.onEvent,
      ...(input.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: input.drainTimeoutMs }),
      ...(input.healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs: input.healthCheckIntervalMs }),
      ...(input.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: input.keepAliveIntervalMs }),
    });

  runManagedConnectionContract({ name: 'real-mongodb', make, supportsKeepAlive: true });

  test('real(mongodb): defineCollection sync + CRUD 往返 + 清理', async () => {
    const resource = supervise(mongoAdapter({ collections: [Probe] }), { connection: { url } });
    await resource.connect();
    try {
      const db = await resource.acquire();
      const inserted = await db.collection(Probe.name).insertOne({ note: 'hello-real-mongo' });
      assert.ok(inserted.insertedId !== undefined);
      assert.strictEqual(await db.collection(Probe.name).countDocuments({ note: 'hello-real-mongo' }), 1);
      const found = await db.collection(Probe.name).findOne({ note: 'hello-real-mongo' });
      assert.strictEqual(found?.note, 'hello-real-mongo');
      // 索引也应当建出来了
      assert.ok((await db.collection(Probe.name).listIndexes()).some((index) => index.name === `${Probe.name}_note`));
    } finally {
      await (await resource.acquire()).collection(Probe.name).drop().catch(() => undefined);
      await resource.close();
    }
  });
}
