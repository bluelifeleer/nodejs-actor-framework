import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSystem } from 'nodejs-actor-framework';

import {
  createDedupeSet,
  createEventEnvelope,
  createEventRegistry,
  createFileOutboxCursor,
  createFileRepository,
  createIdempotentConsumer,
  createMemoryOutboxCursor,
  createMemoryRepository,
  createOutboxDispatcher,
  createOutboxLogReader,
  createSqlOutboxCursor,
  createSqlRepository,
  defineEventSchema,
  OutboxError,
  type OutboxEntry,
  type OutboxSqlRunner,
} from '../src/index.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一条假的事件日志（用真信封，走真注册表）。 */
function makeLog(eventTypes = ['ItemAdded', 'Audited']) {
  const records: unknown[] = [];
  const registry = createEventRegistry(eventTypes.map((type) => defineEventSchema({ type, version: 1 })));
  return {
    records,
    registry,
    append(event: { type: string; [field: string]: unknown }) {
      const seq = records.length + 1;
      records.push(
        createEventEnvelope({ type: event.type, version: 1, payload: event, seq, eventId: `evt-${seq}` }),
      );
      return seq;
    },
    reader: createOutboxLogReader({ loadRecords: async () => records, registry, actorPath: 'order-1' }),
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-outbox-'));
}

test('outbox: drainOnce 投递所有未投递事件；再跑一轮不重复', async () => {
  const log = makeLog();
  log.append({ type: 'ItemAdded', price: 1 });
  log.append({ type: 'ItemAdded', price: 2 });
  log.append({ type: 'Audited', who: 'ada' });

  const delivered: string[] = [];
  const dispatcher = createOutboxDispatcher({
    reader: log.reader,
    cursor: createMemoryOutboxCursor(),
    publish: async (entry) => {
      delivered.push(entry.deliveryId);
    },
  });

  const first = await dispatcher.drainOnce();
  assert.deepStrictEqual(first, { published: 3, failed: 0, deadLettered: 0, skipped: 0, cursor: 3 });
  assert.deepStrictEqual(delivered, ['evt-1', 'evt-2', 'evt-3']);

  const second = await dispatcher.drainOnce();
  assert.strictEqual(second.published, 0, '已推进的不会重投');
  assert.deepStrictEqual(delivered.length, 3);

  const stats = await dispatcher.stats();
  assert.deepStrictEqual(
    { cursor: stats.cursor, backlog: stats.backlog, published: stats.published },
    { cursor: 3, backlog: 0, published: 3 },
  );
});

test('outbox: **至少一次**——发布成功但游标没落盘（≈ 崩溃），下轮会重发', async () => {
  const log = makeLog();
  log.append({ type: 'ItemAdded', price: 1 });
  log.append({ type: 'ItemAdded', price: 2 });
  log.append({ type: 'ItemAdded', price: 3 });

  const delivered: string[] = [];
  let persisted = 0;
  let crashOnce = true;
  const flakyCursor = {
    async read() {
      return persisted;
    },
    async write(seq: number) {
      if (seq === 1 && crashOnce) {
        crashOnce = false;
        throw new Error('模拟：发布成功之后、游标落盘之前崩溃');
      }
      persisted = seq;
    },
  };

  const dispatcher = createOutboxDispatcher({
    reader: log.reader,
    cursor: flakyCursor,
    publish: async (entry) => {
      delivered.push(entry.deliveryId);
    },
  });

  await assert.rejects(() => dispatcher.drainOnce(), /崩溃/);
  assert.deepStrictEqual(delivered, ['evt-1'], '第一条已经发出去了（但游标没推进）');

  await dispatcher.drainOnce();
  assert.deepStrictEqual(
    delivered,
    ['evt-1', 'evt-1', 'evt-2', 'evt-3'],
    'evt-1 被重发了一次——这就是"至少一次"，消费方必须按 deliveryId 去重',
  );
});

test('outbox: 失败重试到上限后进死信并**跳过**（不让一条毒消息堵死后面）', async () => {
  const log = makeLog();
  log.append({ type: 'ItemAdded', price: 1 });
  log.append({ type: 'ItemAdded', price: 2 }); // 这条永远失败
  log.append({ type: 'ItemAdded', price: 3 });

  const delivered: string[] = [];
  const dead: { deliveryId: string; message: string }[] = [];
  const dispatcher = createOutboxDispatcher({
    reader: log.reader,
    cursor: createMemoryOutboxCursor(),
    maxAttempts: 2,
    publish: async (entry) => {
      if (entry.deliveryId === 'evt-2') throw new Error('下游 500');
      delivered.push(entry.deliveryId);
    },
    onDeadLetter: (entry, error) => dead.push({ deliveryId: entry.deliveryId, message: String((error as Error).message) }),
  });

  const round1 = await dispatcher.drainOnce();
  assert.deepStrictEqual(
    { published: round1.published, failed: round1.failed, cursor: round1.cursor },
    { published: 1, failed: 1, cursor: 1 },
    '保序：第二条没成功，第三条先不发；游标停在 1',
  );

  const round2 = await dispatcher.drainOnce();
  assert.deepStrictEqual(
    { published: round2.published, deadLettered: round2.deadLettered, cursor: round2.cursor },
    { published: 1, deadLettered: 1, cursor: 3 },
    '重试到上限 → 进死信 → 跳过它，第三条继续投递',
  );
  assert.deepStrictEqual(delivered, ['evt-1', 'evt-3']);
  assert.deepStrictEqual(dead, [{ deliveryId: 'evt-2', message: '下游 500' }]);
  const stats = await dispatcher.stats();
  assert.strictEqual(stats.deadLettered, 1);
  assert.strictEqual(stats.backlog, 0);
});

test('outbox: select 可以只投一部分事件——被过滤的也会推进游标', async () => {
  const log = makeLog();
  log.append({ type: 'ItemAdded', price: 1 });
  log.append({ type: 'Audited', who: 'ada' });
  log.append({ type: 'ItemAdded', price: 2 });

  const delivered: string[] = [];
  const dispatcher = createOutboxDispatcher({
    reader: log.reader,
    cursor: createMemoryOutboxCursor(),
    select: (entry) => (entry.event as { type: string }).type === 'ItemAdded',
    publish: async (entry) => {
      delivered.push(entry.deliveryId);
    },
  });

  const result = await dispatcher.drainOnce();
  assert.deepStrictEqual(delivered, ['evt-1', 'evt-3']);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.cursor, 3, '被过滤的事件也把游标推过去了（不然每轮都要重读）');
});

test('outbox: 消费幂等——同一 deliveryId 只处理一次（memory / file / SQL 三种仓储都验）', async () => {
  const entry: OutboxEntry = {
    seq: 1,
    type: 'ItemAdded',
    eventId: 'evt-1',
    deliveryId: 'evt-1',
    event: {},
  };

  // memory
  const memoryRepo = createMemoryRepository<Record<string, unknown>>();
  const memoryHandled: string[] = [];
  const memoryConsumer = createIdempotentConsumer({
    dedupe: createDedupeSet({ repository: memoryRepo }),
    handle: async (e) => void memoryHandled.push(e.deliveryId),
  });
  assert.deepStrictEqual(
    [await memoryConsumer(entry), await memoryConsumer(entry), await memoryConsumer(entry)],
    ['handled', 'duplicate', 'duplicate'],
  );
  assert.deepStrictEqual(memoryHandled, ['evt-1'], '至少一次投递下，业务只跑了一次');

  // file（跨实例仍然是同一份去重集合）
  const dir = tempDir();
  try {
    const fileDedupe = () =>
      createDedupeSet({ repository: createFileRepository<Record<string, unknown>>({ dir }) });
    const fileConsumer = createIdempotentConsumer({ dedupe: fileDedupe(), handle: async () => undefined });
    assert.strictEqual(await fileConsumer(entry), 'handled');
    assert.strictEqual(await fileConsumer(entry), 'duplicate');

    // 新实例（≈ 进程重启）也认得这条去重记录
    const reopened = createIdempotentConsumer({ dedupe: fileDedupe(), handle: async () => undefined });
    assert.strictEqual(await reopened(entry), 'duplicate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // SQL：去重由**主键约束**保证（真去重）
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE dedupe (id TEXT PRIMARY KEY, version INTEGER NOT NULL)');
    const runner: OutboxSqlRunner = {
      async all(sql, params) {
        return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
      },
      async run(sql, params) {
        return Number(db.prepare(sql).run(...(params as never[])).changes);
      },
    };
    const sqlRepo = createSqlRepository<Record<string, unknown>>({
      runner,
      table: 'dedupe',
      fields: ['id', 'version'],
      isUniqueViolation: (err) => /UNIQUE constraint failed/.test(String((err as Error)?.message)),
    });
    const sqlConsumer = createIdempotentConsumer({
      dedupe: createDedupeSet({ repository: sqlRepo }),
      handle: async () => undefined,
    });
    assert.strictEqual(await sqlConsumer(entry), 'handled');
    assert.strictEqual(await sqlConsumer(entry), 'duplicate');
  } finally {
    db.close();
  }
});

test('outbox: file / SQL 游标跨实例存在、原子写；SQL 会自动建表', async () => {
  const dir = tempDir();
  try {
    const writer = createFileOutboxCursor({ dir });
    await writer.write(7);
    assert.strictEqual(await createFileOutboxCursor({ dir }).read(), 7, '跨实例可读');

    fs.writeFileSync(path.join(dir, 'outbox-cursor.json'), '{ not json');
    await assert.rejects(() => createFileOutboxCursor({ dir }).read(), /内容损坏/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const db = new DatabaseSync(':memory:');
  try {
    const runner: OutboxSqlRunner = {
      async all(sql, params) {
        return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
      },
      async run(sql, params) {
        return Number(db.prepare(sql).run(...(params as never[])).changes);
      },
    };
    const cursor = createSqlOutboxCursor({ runner });
    await cursor.ensure(); // 建表（表还不存在时也应工作）
    assert.strictEqual(await cursor.read(), 0, '没有记录时是 0');
    await cursor.write(11);
    assert.strictEqual(await cursor.read(), 11);
  } finally {
    db.close();
  }

  assert.throws(() => createMemoryOutboxCursor(-1), OutboxError);
  assert.throws(() => createSqlOutboxCursor({ runner: undefined as never }), OutboxError);
});

test('outbox: 接成内核 Actor（asActor）——ask 触发一轮，postStop 停掉轮询', async () => {
  const log = makeLog();
  log.append({ type: 'ItemAdded', price: 1 });
  log.append({ type: 'ItemAdded', price: 2 });

  const delivered: string[] = [];
  const dispatcher = createOutboxDispatcher({
    reader: log.reader,
    cursor: createMemoryOutboxCursor(),
    publish: async (entry) => {
      delivered.push(entry.deliveryId);
    },
  });

  const system = createSystem({ logger: false });
  try {
    const ref = (await system.spawn(dispatcher.asActor({ intervalMs: 10 }), { id: 'outbox' })) as {
      ask(message: unknown): Promise<unknown>;
      stop(): Promise<void>;
    };

    // 轮询（setInterval）自己就会投递
    for (let i = 0; i < 50 && delivered.length < 2; i += 1) await sleep(10);
    assert.deepStrictEqual(delivered, ['evt-1', 'evt-2'], 'asActor 起来之后会自己轮询投递');

    const stats = (await ref.ask({ type: 'stats' })) as { cursor: number; backlog: number };
    assert.deepStrictEqual({ cursor: stats.cursor, backlog: stats.backlog }, { cursor: 2, backlog: 0 });

    const drained = (await ref.ask({ type: 'drain' })) as { published: number };
    assert.strictEqual(drained.published, 0, '已经投完，手动 drain 也是空转');

    await ref.stop(); // postStop → dispatcher.stop()
    log.append({ type: 'ItemAdded', price: 3 });
    await sleep(50);
    assert.deepStrictEqual(delivered, ['evt-1', 'evt-2'], '停掉之后不再轮询');
  } finally {
    await system.stop();
  }
});

test('outbox: 参数与配置校验都在构造期报错', () => {
  const log = makeLog();
  assert.throws(() => createOutboxDispatcher({ reader: undefined as never, cursor: createMemoryOutboxCursor(), publish: async () => undefined }), OutboxError);
  assert.throws(
    () => createOutboxDispatcher({ reader: log.reader, cursor: createMemoryOutboxCursor(), publish: undefined as never }),
    OutboxError,
  );
  assert.throws(
    () => createOutboxDispatcher({ reader: log.reader, cursor: createMemoryOutboxCursor(), publish: async () => undefined, maxAttempts: 0 }),
    /maxAttempts 必须是 >= 1/,
  );
  assert.throws(() => createOutboxLogReader({ loadRecords: undefined as never, registry: log.registry }), OutboxError);
  assert.throws(() => createDedupeSet({ repository: undefined as never }), OutboxError);
});
