import { test } from 'node:test';
import assert from 'node:assert';

import {
  memoryRefreshStore,
  redisRefreshStore,
  runRefreshStoreContract,
  type RefreshKeyValueClient,
} from '../src/auth/refresh.ts';

// 假 KeyValueClient：**共享同一份 Map** → 两个"实例"之间语义与真 Redis 一致（reopen 才是真验证）
const backing = new Map<string, { value: unknown; expiresAt?: number }>();
const fakeClient = (namespace: string): RefreshKeyValueClient => {
  const key = (raw: string): string => `${namespace}${raw}`;
  return {
    async get<T>(raw: string): Promise<T | null> {
      const entry = backing.get(key(raw));
      if (entry === undefined) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
        backing.delete(key(raw));
        return null;
      }
      return entry.value as T;
    },
    async set(raw, value, options) {
      if (options?.ifNotExists === true && backing.has(key(raw))) return false;
      backing.set(key(raw), {
        value,
        ...(options?.ttlMs === undefined ? {} : { expiresAt: Date.now() + options.ttlMs }),
      });
      return true;
    },
    async del(...raws) {
      let removed = 0;
      for (const raw of raws) if (backing.delete(key(raw))) removed += 1;
      return removed;
    },
  };
};

// 内存实现：单节点语义
runRefreshStoreContract({ name: 'memory', make: () => memoryRefreshStore() });

// redis 形状：共享存储 → reopen 后仍认得（跨实例/跨重启语义）
runRefreshStoreContract({
  name: 'redis-shape',
  make: () => redisRefreshStore(fakeClient('t:'), { prefix: 'auth:' }),
  reopen: () => redisRefreshStore(fakeClient('t:'), { prefix: 'auth:' }),
  // KV 存储到期键就没了 → 只能报 unknown（诚实答案）
  expiryReportsAs: 'unknown',
});

test('refresh: 存储里放的是 **token 的 sha256**，不是原文', async () => {
  const store = memoryRefreshStore();
  const issued = await store.issue({ subject: 'u' });
  // 内存实现内部不暴露；这里用 redis 形状的共享 backing 来验证"存的是哈希不是原文"
  const client = fakeClient('hashcheck:');
  const redisStore = redisRefreshStore(client, { prefix: 'p:' });
  const issued2 = await redisStore.issue({ subject: 'u' });
  const dumped = JSON.stringify([...backing.entries()]);
  assert.ok(!dumped.includes(issued2.token), '存储里不能出现 token 原文');
  assert.ok(dumped.includes('p:'), '至少要有键（证明我们确实看的是这个存储）');
  assert.strictEqual((await store.consume(issued.token)).ok, true);
});

test('refresh: 生产环境下内存实现**拒绝启动**，显式承认才允许（并留下日志）', () => {
  const original = process.env['NODE_ENV'];
  const logged: string[] = [];
  process.env['NODE_ENV'] = 'production';
  try {
    assert.throws(() => memoryRefreshStore(), /单节点实现/);
    const store = memoryRefreshStore({ allowInMemoryInProduction: true, logger: (event) => logged.push(event) });
    assert.ok(store !== undefined);
    assert.ok(logged.includes('refresh_store_in_memory_in_production'), `要留痕：${logged.join(',')}`);
  } finally {
    if (original === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = original;
  }
});

test('refresh: 重放会留下服务端日志（对外只回 401 的语义由 auth 层负责）', async () => {
  const events: Array<{ event: string; meta?: Record<string, unknown> }> = [];
  const store = memoryRefreshStore({ logger: (event, meta) => events.push({ event, ...(meta === undefined ? {} : { meta }) }) });
  const issued = await store.issue({ subject: 'u' });
  await store.consume(issued.token);
  const replay = await store.consume(issued.token);
  assert.strictEqual(replay.ok, false);
  assert.ok(events.some((item) => item.event === 'refresh_replay_detected'), `要记重放：${JSON.stringify(events)}`);
});

test('refresh: 同一 token 并发消费只能有一个成功（回归：读-改-写竞态发两把新 token）', async () => {
  const store = redisRefreshStore(fakeClient('race:'), { prefix: 'auth:' });
  const issued = await store.issue({ subject: 'u1' });
  const results = await Promise.all([store.consume(issued.token), store.consume(issued.token)]);
  assert.strictEqual(results.filter((result) => result.ok).length, 1, '并发消费必须只有一个赢家');
  assert.ok(results.some((result) => result.ok === false && result.reason === 'replay'));
});
