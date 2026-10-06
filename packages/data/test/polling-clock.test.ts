import { test } from 'node:test';
import assert from 'node:assert';

import { createVirtualClock } from '@actor/testkit';

import {
  createEventEnvelope,
  createEventRegistry,
  createMemoryOutboxCursor,
  createMemoryRepository,
  createOutboxDispatcher,
  createOutboxLogReader,
  createProjectionRunner,
  defineEventSchema,
} from '../src/index.ts';

/**
 * 数据层的轮询以前写死 `setInterval`，于是"跑一轮"在测试里必须真等（M3 文档 §9.3 如实记过这条）。
 * 现在时钟可注入：`advance()` 一推，轮询瞬时发生——下面是这条能力的两条证据。
 */

function makeLog() {
  const records: unknown[] = [];
  const registry = createEventRegistry([defineEventSchema({ type: 'ItemAdded', version: 1 })]);
  return {
    registry,
    append: () => {
      const seq = records.length + 1;
      records.push(createEventEnvelope({ type: 'ItemAdded', version: 1, seq, eventId: `e${seq}`, payload: { price: 10 } }));
    },
    reader: () => createOutboxLogReader({ loadRecords: async () => records, registry, actorPath: 'cart' }),
  };
}

test('polling: 投递器的轮询由虚拟时钟驱动（advance 一推就投，不用真等 1 秒）', async () => {
  const vc = createVirtualClock();
  const log = makeLog();
  const delivered: string[] = [];
  const dispatcher = createOutboxDispatcher({
    reader: log.reader(),
    cursor: createMemoryOutboxCursor(),
    publish: async (entry) => delivered.push(entry.deliveryId),
    clock: vc.clock,
  });

  log.append();
  dispatcher.start({ intervalMs: 1000 });
  assert.deepStrictEqual(delivered, [], '还没到轮询点');

  const realStart = Date.now();
  await vc.advance(1000);
  assert.deepStrictEqual(delivered, ['e1'], 'advance 推进到轮询点即投递');
  assert.ok(Date.now() - realStart < 100, '真实耗时应当极小');

  log.append();
  await vc.advance(1000);
  assert.deepStrictEqual(delivered, ['e1', 'e2'], '下一轮再投一条');

  await dispatcher.stop();
  await vc.advance(10_000);
  assert.deepStrictEqual(delivered, ['e1', 'e2'], '停掉之后不再轮询');
});

test('polling: 投影的轮询同样由虚拟时钟驱动（断点追平）', async () => {
  const vc = createVirtualClock();
  const log = makeLog();
  const repository = createMemoryRepository();
  const runner = createProjectionRunner({
    projection: {
      name: 'totals',
      subscriptions: ['ItemAdded'],
      async handle(entry, ctx) {
        const row = await ctx.repository.findById('all');
        const total = Number(row?.total ?? 0) + (entry.event as { price: number }).price;
        if (row === null) await ctx.repository.insert({ id: 'all', total });
        else await ctx.repository.update('all', { total }, { expectedVersion: row.version });
      },
    },
    reader: log.reader(),
    repository,
    dedupeRepository: createMemoryRepository(),
    cursor: createMemoryOutboxCursor(),
    clock: vc.clock,
  });

  log.append();
  log.append();
  runner.start({ intervalMs: 500 });

  const realStart = Date.now();
  await vc.advance(500);
  assert.strictEqual((await repository.findById('all'))?.total, 20, 'advance 之后读模型已追平');
  assert.ok(Date.now() - realStart < 100, '真实耗时应当极小');

  await runner.stop();
});
