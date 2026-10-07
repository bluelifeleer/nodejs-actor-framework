import { test } from 'node:test';
import assert from 'node:assert';

import { createDedupeSet, createIdempotentConsumer, createMemoryRepository } from '../src/index.ts';

/**
 * 审计（文档承诺一致性 §8）：「createDedupeSet（仓储主键）| 恰好一次」这句承诺原本**不成立** ——
 * `createIdempotentConsumer` 先 `mark()` 再 `handle()`，handler 抛错不回滚，重试被判成 `duplicate`
 * 而永久跳过（"恰好一次"实际是"至多一次"，也就是丢消息）。
 *
 * 对照：投影 runner 一直有回滚（`runner.ts` 在 catch 里删掉去重记录）。
 */
test('audit/outbox: handler 失败后必须能重试（去重标记要回滚）', async () => {
  const dedupe = createDedupeSet({ repository: createMemoryRepository<Record<string, unknown>>() });
  let attempts = 0;
  const handle = createIdempotentConsumer({
    dedupe,
    async handle() {
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt fails');
    },
  });
  const entry = { deliveryId: 'd-1', seq: 1, topic: 't', payload: {} } as never;

  await assert.rejects(() => handle(entry), /first attempt fails/);
  // 重试：必须真的再执行一次，而不是被判成重复
  const outcome = await handle(entry);
  assert.strictEqual(outcome, 'handled', `重试被判成 ${outcome}（去重标记没有回滚 → 消息被永久丢弃）`);
  assert.strictEqual(attempts, 2);

  // 第二次成功之后再投递同一条，才是真正的重复
  assert.strictEqual(await handle(entry), 'duplicate');
});
