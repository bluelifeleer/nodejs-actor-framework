import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSystem } from 'nodejs-actor-framework';

import {
  createEventEnvelope,
  createEventRegistry,
  createMemoryOutboxCursor,
  createMemoryRepository,
  createOutboxLogReader,
  createProjectionRunner,
  defineEventSchema,
  ProjectionError,
  ProjectionHandleError,
  type OutboxEntry,
  type ProjectionContext,
  type ProjectionSpec,
} from '../src/index.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假事件日志（真信封、真注册表）。 */
function makeLog() {
  const records: unknown[] = [];
  const registry = createEventRegistry(
    ['UserCreated', 'UserRenamed', 'ItemAdded'].map((type) => defineEventSchema({ type, version: 1 })),
  );
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
    reader: createOutboxLogReader({ loadRecords: async () => records, registry, actorPath: 'users' }),
  };
}

interface UserRow {
  id?: string;
  version?: number;
  name?: string;
  events: number;
}

/** 一个"用户列表"投影：把事件折成每个用户一行 + 处理过的事件数（用于验证"不重"）。 */
const userListProjection: ProjectionSpec = {
  name: 'user-list',
  subscriptions: ['UserCreated', 'UserRenamed'],
  async handle(entry: OutboxEntry, ctx: ProjectionContext) {
    const event = entry.event as { type: string; userId: string; name?: string };
    const existing = (await ctx.repository.findById(event.userId)) as unknown as UserRow | null;
    if (existing === null) {
      await ctx.repository.insert({ id: event.userId, name: event.name ?? null, events: 1 });
    } else {
      await ctx.repository.update(
        event.userId,
        { ...(event.name === undefined ? {} : { name: event.name }), events: existing.events + 1 },
        { expectedVersion: existing.version as number },
      );
    }
  },
};

function makeRunner(log: ReturnType<typeof makeLog>, overrides: Partial<Parameters<typeof createProjectionRunner>[0]> = {}) {
  const repository = createMemoryRepository<UserRow & Record<string, unknown>>();
  const runner = createProjectionRunner({
    projection: userListProjection,
    reader: log.reader,
    repository: repository as never,
    dedupeRepository: createMemoryRepository<Record<string, unknown>>() as never,
    cursor: createMemoryOutboxCursor(),
    batchSize: 2,
    ...overrides,
  });
  return { repository, runner };
}

test('projection: catchUp 处理订阅的事件、跳过未订阅的，并把游标推到最新', async () => {
  const log = makeLog();
  log.append({ type: 'UserCreated', userId: 'u1', name: 'ada' });
  log.append({ type: 'UserCreated', userId: 'u2', name: 'bob' });
  log.append({ type: 'ItemAdded', itemId: 'i1' }); // 未订阅
  log.append({ type: 'UserRenamed', userId: 'u1', name: 'ada-2' });
  log.append({ type: 'UserCreated', userId: 'u3', name: 'cy' });

  const { repository, runner } = makeRunner(log);
  const result = await runner.catchUp();

  assert.deepStrictEqual(result.run, { processed: 4, duplicates: 0, skipped: 1 });
  assert.strictEqual(result.cursor, 5);
  assert.strictEqual(result.backlog, 0);
  assert.strictEqual(result.caughtUp, true);

  assert.strictEqual((await repository.findById('u1'))?.events, 2, 'u1 有 Created + Renamed 两条');
  assert.strictEqual((await repository.findById('u1'))?.name, 'ada-2');
  assert.strictEqual((await repository.findById('u2'))?.events, 1);
  assert.strictEqual((await repository.findById('u3'))?.events, 1);
});

test('projection: **从 0 重建不丢不重**（doc 06 的验收项）', async () => {
  const log = makeLog();
  for (let i = 1; i <= 20; i += 1) log.append({ type: 'UserCreated', userId: `u${i}`, name: `user-${i}` });
  log.append({ type: 'UserRenamed', userId: 'u1', name: 'ada' });

  const { repository, runner } = makeRunner(log);
  await runner.catchUp();
  const before = (await repository.findMany({ orderBy: 'id', limit: 100 })).items;

  const rebuilt = await runner.rebuild();
  const after = (await repository.findMany({ orderBy: 'id', limit: 100 })).items;

  assert.deepStrictEqual(after, before, '重建后读模型与重建前逐行一致（不丢也不重）');
  assert.strictEqual(after.length, 20, '21 条事件折成 20 个用户');
  assert.strictEqual(
    after.find((row) => row.id === 'u1')?.events,
    2,
    'u1 的两条事件各计入一次（不是 4 次：重建没有把旧数据叠加进来）',
  );
  assert.deepStrictEqual(rebuilt.run, { processed: 21, duplicates: 0, skipped: 0 });
  assert.strictEqual(rebuilt.cursor, 21);
});

test('projection: 去重——游标被回退（≈ 至少一次重放）时读模型不会被重复累加', async () => {
  const log = makeLog();
  log.append({ type: 'UserCreated', userId: 'u1', name: 'ada' });
  log.append({ type: 'UserRenamed', userId: 'u1', name: 'ada-2' });

  const cursor = createMemoryOutboxCursor();
  const { repository, runner } = makeRunner(log, { cursor });
  await runner.catchUp();
  assert.strictEqual((await repository.findById('u1'))?.events, 2);

  // 模拟"handler 成功、游标没落盘"后的重放：把游标退回去，去重集合**保留**
  await cursor.write(0);
  const replay = await runner.catchUp();
  assert.deepStrictEqual(replay.run, { processed: 0, duplicates: 2, skipped: 0 });
  assert.strictEqual(
    (await repository.findById('u1'))?.events,
    2,
    '重放被去重挡住：业务恰好一次（这正是 at-least-once 下要幂等的原因）',
  );
});

test('projection: 断点续跑——分批追赶，崩了从断点继续', async () => {
  const log = makeLog();
  for (let i = 1; i <= 5; i += 1) log.append({ type: 'UserCreated', userId: `u${i}`, name: `user-${i}` });

  const { repository, runner } = makeRunner(log);
  const first = await runner.catchUp({ maxBatches: 1 });
  assert.strictEqual(first.run.processed, 2, 'batchSize=2，只处理一批');
  assert.strictEqual(first.caughtUp, false);
  assert.strictEqual(first.backlog, 3);

  const second = await runner.catchUp();
  assert.strictEqual(second.run.processed, 3, '从断点继续（不会从头再来）');
  assert.strictEqual(second.caughtUp, true);
  assert.strictEqual((await repository.findMany({ limit: 100 })).items.length, 5);
});

test('projection: handler 失败 → 游标不推进、错误可诊断、下次重试仍会执行它', async () => {
  const log = makeLog();
  log.append({ type: 'UserCreated', userId: 'u1', name: 'ada' });
  log.append({ type: 'UserCreated', userId: 'u2', name: 'bob' });

  let failOnce = true;
  const failFirstTime: ProjectionSpec = {
    name: 'flaky',
    async handle(entry, ctx) {
      if (entry.deliveryId === 'evt-2' && failOnce) {
        failOnce = false;
        throw new Error('下游暂时不可用');
      }
      const event = entry.event as { userId: string };
      await ctx.repository.insert({ id: event.userId });
    },
  };

  const repository = createMemoryRepository<Record<string, unknown>>();
  const runner = createProjectionRunner({
    projection: failFirstTime,
    reader: log.reader,
    repository,
    dedupeRepository: createMemoryRepository<Record<string, unknown>>(),
    cursor: createMemoryOutboxCursor(),
  });

  await assert.rejects(
    () => runner.catchUp(),
    (err: unknown) => {
      assert.ok(err instanceof ProjectionHandleError);
      assert.strictEqual(err.seq, 2);
      assert.match(err.message, /下游暂时不可用/);
      assert.match(err.message, /游标未推进/);
      return true;
    },
  );
  const status = await runner.status();
  assert.strictEqual(status.cursor, 1, '只推进到成功的那一条');
  assert.strictEqual(await repository.findById('u1') !== null, true);

  // 重试：失败的那条**会再次执行**（去重记录在处理失败时被撤掉了），然后继续
  const retry = await runner.catchUp();
  assert.strictEqual(retry.run.processed, 1);
  assert.strictEqual(retry.cursor, 2);
  assert.strictEqual(await repository.findById('u2') !== null, true);
});

test('projection: waitFor 给"读己之写"用——追不上就超时报错，而不是无限等', async () => {
  const log = makeLog();
  log.append({ type: 'UserCreated', userId: 'u1', name: 'ada' });
  const { runner } = makeRunner(log);

  await runner.catchUp();
  const status = await runner.waitFor(1, { timeoutMs: 50 });
  assert.strictEqual(status.cursor, 1);

  await assert.rejects(
    () => runner.waitFor(10, { timeoutMs: 30, pollMs: 5 }),
    (err: unknown) => err instanceof ProjectionError && /在 30ms 内没有追到 offset=10/.test(err.message),
  );
});

test('projection: 影子重建——先灌影子读模型，线上那份不受影响（再切换指针）', async () => {
  const log = makeLog();
  for (let i = 1; i <= 3; i += 1) log.append({ type: 'UserCreated', userId: `u${i}`, name: `user-${i}` });

  const { repository, runner } = makeRunner(log);
  await runner.catchUp();

  const shadow = createMemoryRepository<Record<string, unknown>>();
  const rebuilt = await runner.rebuild({ repository: shadow as never });
  assert.deepStrictEqual(rebuilt.run, { processed: 3, duplicates: 0, skipped: 0 });
  assert.strictEqual((await shadow.findMany({ limit: 10 })).items.length, 3, '影子读模型被灌满');
  assert.strictEqual(
    (await repository.findMany({ limit: 10 })).items.length,
    3,
    '在线读模型在切换之前仍然可用（内容不变）',
  );
});

test('projection: 接成内核 Actor —— 轮询追赶、ask status、stop 后不再跑', async () => {
  const log = makeLog();
  log.append({ type: 'UserCreated', userId: 'u1', name: 'ada' });
  log.append({ type: 'UserCreated', userId: 'u2', name: 'bob' });

  const { repository, runner } = makeRunner(log, { batchSize: 10 });
  const system = createSystem({ logger: false });
  try {
    const ref = (await system.spawn(runner.asActor({ intervalMs: 10 }), { id: 'user-list' })) as {
      ask(message: unknown): Promise<unknown>;
      stop(): Promise<void>;
    };
    for (let i = 0; i < 50 && (await runner.status()).backlog > 0; i += 1) await sleep(10);
    assert.strictEqual((await repository.findMany({ limit: 10 })).items.length, 2, '轮询把读模型追上来了');

    const status = (await ref.ask({ type: 'status' })) as { cursor: number; backlog: number };
    assert.deepStrictEqual({ cursor: status.cursor, backlog: status.backlog }, { cursor: 2, backlog: 0 });

    await ref.stop();
    log.append({ type: 'UserCreated', userId: 'u3', name: 'cy' });
    await sleep(50);
    assert.strictEqual((await repository.findMany({ limit: 10 })).items.length, 2, '停掉之后不再追赶');
  } finally {
    await system.stop();
  }
});

test('projection: 配置校验在构造期报错', () => {
  const log = makeLog();
  const base = {
    reader: log.reader,
    repository: createMemoryRepository<Record<string, unknown>>(),
    dedupeRepository: createMemoryRepository<Record<string, unknown>>(),
    cursor: createMemoryOutboxCursor(),
  };
  assert.throws(() => createProjectionRunner({ ...base, projection: undefined as never }), ProjectionError);
  assert.throws(
    () => createProjectionRunner({ ...base, projection: { name: 'x', handle: undefined as never } }),
    /需要 projection\.handle/,
  );
  assert.throws(
    () => createProjectionRunner({ ...base, projection: { name: 'x', handle: () => undefined }, reader: undefined as never }),
    /需要 reader/,
  );
  assert.throws(
    () =>
      createProjectionRunner({
        ...base,
        projection: { name: 'x', handle: () => undefined },
        repository: undefined as never,
      }),
    /需要 repository/,
  );
  assert.throws(
    () =>
      createProjectionRunner({
        ...base,
        projection: { name: 'x', handle: () => undefined },
        batchSize: 0,
      }),
    /batchSize 必须是 >= 1/,
  );
});

test('projection: 空日志 / 没有订阅事件时也能跑（游标不动、不报错）', async () => {
  const log = makeLog();
  const { runner } = makeRunner(log);
  const empty = await runner.catchUp();
  assert.deepStrictEqual(empty.run, { processed: 0, duplicates: 0, skipped: 0 });
  assert.strictEqual(empty.cursor, 0);
  assert.strictEqual(empty.caughtUp, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-projection-'));
  fs.rmSync(dir, { recursive: true, force: true });
});
