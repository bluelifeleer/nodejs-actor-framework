import { test } from 'node:test';
import assert from 'node:assert';

import {
  realDatabaseUrl,
  runManagedConnectionContract,
  supervise,
  type ContractResourceFactory,
} from '@actor/resource';

import { redisAdapter } from '../src/index.ts';

/**
 * **真库用例**：设了 `ACTOR_TEST_REDIS_URL` / `ACTOR_TEST_IOREDIS_URL` 才跑，否则**显式跳过**。
 *
 * 起库：`node scripts/dev-databases.mjs up redis` 然后 `eval "$(node scripts/dev-databases.mjs env)"`。
 * ⚠️ 本环境离线无 docker，也没有 redis 服务 → 这两条在这里必然跳过。
 */
const TARGETS = [
  { env: 'ACTOR_TEST_REDIS_URL', driver: 'redis' },
  { env: 'ACTOR_TEST_IOREDIS_URL', driver: 'ioredis' },
] as const;

for (const target of TARGETS) {
  const url = realDatabaseUrl(target.env);
  const skipped = `${target.env} not set（真库用例：先 node scripts/dev-databases.mjs up redis）`;

  if (url === undefined) {
    test(`real(${target.driver}): 连接管理契约`, { skip: skipped }, () => {});
    test(`real(${target.driver}): KV 往返 + 清理`, { skip: skipped }, () => {});
    continue;
  }

  const make: ContractResourceFactory = (input) =>
    supervise(redisAdapter({ driver: target.driver }), {
      connection: { url },
      onEvent: input.onEvent,
      ...(input.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: input.drainTimeoutMs }),
      ...(input.healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs: input.healthCheckIntervalMs }),
      ...(input.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: input.keepAliveIntervalMs }),
    });

  // 真库也跑同一套连接管理契约（counters/setHealthy 不提供 → 那两条显示为 skip）
  runManagedConnectionContract({ name: `real-${target.driver}`, make, supportsKeepAlive: true });

  test(`real(${target.driver}): KV 往返 + 清理`, async () => {
    const prefix = `actor_probe_${process.pid}_${Math.random().toString(36).slice(2, 8)}:`;
    const resource = supervise(redisAdapter({ driver: target.driver, prefix }), { connection: { url } });
    await resource.connect();
    try {
      const kv = await resource.acquire();

      await kv.set('s', 'v', { ttlMs: 5_000 });
      assert.strictEqual(await kv.get('s'), 'v');
      assert.ok((await kv.ttl('s')) > 0, 'TTL 应当为正');

      await kv.setJson('o', { a: 1 });
      assert.deepStrictEqual(await kv.getJson('o'), { a: 1 });

      await kv.hSet('h', 'f', '1');
      assert.deepStrictEqual(await kv.hGetAll('h'), { f: '1' });

      await kv.lPush('l', 'a');
      assert.deepStrictEqual(await kv.lRange('l', 0, -1), ['a']);

      await kv.sAdd('set', 'm');
      assert.deepStrictEqual(await kv.sMembers('set'), ['m']);

      const scanned = await kv.scan('0', { match: 's*', count: 100 });
      assert.ok(scanned.keys.includes('s'), `scan 应当找到 s（前缀已剥掉）：${JSON.stringify(scanned)}`);

      // 订阅（适配器会自动另开一条连接）
      const received: string[] = [];
      const unsubscribe = await kv.subscribe('chan', (message) => received.push(message));
      await kv.publish('chan', 'hi');
      await new Promise((resolve) => setTimeout(resolve, 100)); // 订阅投递是异步的
      assert.deepStrictEqual(received, ['hi']);
      await unsubscribe();

      assert.ok((await kv.command<string[]>(['KEYS', `${prefix}*`])).length >= 0, '逃生通道 command 可用');
    } finally {
      const kv = await resource.acquire().catch(() => null);
      if (kv !== null) {
        // 清理本次运行的所有键
        const keys = await kv.command<string[]>(['KEYS', `${prefix}*`]).catch(() => []);
        if (keys.length > 0) await kv.command(['DEL', ...keys]).catch(() => undefined);
      }
      await resource.close();
    }
  });
}
