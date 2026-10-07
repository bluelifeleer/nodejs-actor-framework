import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSystem, FilePersistence } from 'nodejs-actor-framework'; // FilePersistence 本来就在公开面
import { createApp, defineApp, defineModule } from '@actor/app';

import { createEventEnvelope, defineAggregate, defineEventSchema, type AggregateEvent } from '../src/index.ts';

/**
 * 聚合的端到端验证：真实内核 + 真实文件 + 真实重启。
 *
 * 覆盖两条 spawn 路径（内核直连 / 应用层装配），因为它们的定义转发方式不同——
 * 这也是"聚合返回 handler bag 而不是 class"的原因（见 docs/design/m3-data-evolution.md §5）。
 */

interface OrderState {
  status: string;
  totalCents: number;
  items: number;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-data-agg-'));
}

function orderAggregate(version = 2) {
  return defineAggregate<OrderState>({
    name: 'Order',
    initialState: () => ({ status: 'created', totalCents: 0, items: 0 }),
    events: [
      defineEventSchema({
        type: 'ItemAdded',
        version,
        upcasts: version >= 2 ? [{ from: 1, to: 2, up: (e) => ({ ...e, price: (e.price as number) * 100 }) }] : [],
      }),
      defineEventSchema({ type: 'Confirmed', version: 1 }),
    ],
    applyEvent: (state, event) => {
      if (event.type === 'ItemAdded') {
        return { ...state, totalCents: state.totalCents + (event.price as number), items: state.items + 1 };
      }
      if (event.type === 'Confirmed') return { ...state, status: 'confirmed' };
      return state;
    },
    commands: {
      addItem: (cmd, state) => {
        if (state.status !== 'created') throw new Error('order already confirmed');
        const price = (cmd as { price: number }).price;
        if (price <= 0) throw new Error('price must be positive');
        return { type: 'ItemAdded', price };
      },
      confirm: (_cmd, state) => (state.status === 'created' ? { type: 'Confirmed' } : undefined),
    },
  });
}

const persistenceFor = (aggregate: ReturnType<typeof orderAggregate>) => ({
  mode: 'events' as const,
  evolution: aggregate.evolution ?? undefined,
});

test('aggregate: 内核直连——命令落盘为信封，重启后状态由事件重建', async () => {
  const dir = tempDir();
  const store = new FilePersistence({ baseDir: dir });
  const Order = orderAggregate();

  const system1 = createSystem({ logger: false, persistence: { dir } });
  const ref1 = await system1.spawn(Order, { id: 'order-1', persistence: persistenceFor(Order) });

  assert.deepStrictEqual(await ref1.ask({ type: 'addItem', price: 100 }), {
    status: 'created',
    totalCents: 100,
    items: 1,
  });
  await ref1.ask({ type: 'addItem', price: 50 });

  // 业务校验失败：命令抛错 → ask 收到真实错误 → 不产生事件、状态不变
  await assert.rejects(() => ref1.ask({ type: 'addItem', price: -1 }), /price must be positive/);
  assert.deepStrictEqual(await ref1.state(), { status: 'created', totalCents: 150, items: 2 });

  assert.deepStrictEqual(await ref1.ask({ type: 'confirm' }), { status: 'confirmed', totalCents: 150, items: 2 });
  await assert.rejects(() => ref1.ask({ type: 'addItem', price: 1 }), /order already confirmed/);
  assert.deepStrictEqual(await ref1.state(), { status: 'confirmed', totalCents: 150, items: 2 });
  await system1.stop();

  const raw = await store.loadEvents('order-1');
  assert.strictEqual(raw.length, 3, '两条 ItemAdded + 一条 Confirmed');
  assert.deepStrictEqual(
    (raw as { type: string; version: number; seq: number; payload: unknown }[]).map((e) => [
      e.type,
      e.version,
      e.seq,
      e.payload,
    ]),
    [
      ['ItemAdded', 2, 1, { type: 'ItemAdded', price: 100 }],
      ['ItemAdded', 2, 2, { type: 'ItemAdded', price: 50 }],
      ['Confirmed', 1, 3, { type: 'Confirmed' }],
    ],
    '每条事件都带连续的 seq',
  );

  // 重启：状态必须由事件重建，与写入期完全一致
  const system2 = createSystem({ logger: false, persistence: { dir } });
  const ref2 = await system2.spawn(Order, { id: 'order-1', persistence: persistenceFor(Order) });
  assert.deepStrictEqual(await ref2.state(), { status: 'confirmed', totalCents: 150, items: 2 });
  await system2.stop();
});

test('aggregate: 应用层装配路径同样可用（actor 定义就是聚合对象）', async () => {
  const dir = tempDir();
  const Order = orderAggregate();

  const build = () =>
    createApp(
      defineApp({
        modules: [
          defineModule({
            name: 'orders',
            actors: { Order: { definition: Order, options: { persistence: persistenceFor(Order) } } },
          }),
        ],
      }),
      {
        configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'actor-data-agg-cfg-')),
        env: {},
        kernel: { logger: false, persistence: { dir } },
      },
    );

  const app1 = build();
  await app1.start();
  assert.deepStrictEqual(await app1.actor('Order').ask({ type: 'addItem', price: 30 }), {
    status: 'created',
    totalCents: 30,
    items: 1,
  });
  await app1.stop();

  const app2 = build();
  await app2.start();
  assert.deepStrictEqual(await app2.actor('Order').state(), { status: 'created', totalCents: 30, items: 1 });
  await app2.stop();
});

test('aggregate: 旧原始 JSON（v1）在 v2 聚合代码下可读（升级链 + 事件日志不改写）', async () => {
  const dir = tempDir();

  // --- 阶段 1：M3 之前的代码，直接写原始 JSON（元为单位的 price） ---
  const legacy = {
    preStart(this: { state: { totalCents: number } }) {
      this.state = { totalCents: 0 };
    },
    async receive(this: { state: { totalCents: number } }, msg: { price?: number }, ctx: { persist(e: unknown): Promise<unknown> }) {
      await ctx.persist({ type: 'ItemAdded', price: msg.price });
      return this.state;
    },
    applyEvent(this: { state: { totalCents: number } }, event: AggregateEvent) {
      if (event.type === 'ItemAdded') this.state.totalCents += event.price as number; // v1：元
    },
  };
  const system1 = createSystem({ logger: false, persistence: { dir } });
  const ref1 = await system1.spawn(legacy, { id: 'order-9', persistence: { mode: 'events' } });
  await ref1.ask({ price: 7 });
  await system1.stop();

  // --- 阶段 2：v2 聚合（分为单位）+ 升级链 ---
  const Order = orderAggregate(2);
  const system2 = createSystem({ logger: false, persistence: { dir } });
  const ref2 = await system2.spawn(Order, { id: 'order-9', persistence: persistenceFor(Order) });
  assert.deepStrictEqual(await ref2.state(), { status: 'created', totalCents: 700, items: 1 }, '7 元 → 700 分');
  await system2.stop();

  // 盘上的旧数据没有被改写
  const store = new FilePersistence({ baseDir: dir });
  assert.deepStrictEqual(await store.loadEvents('order-9'), [{ type: 'ItemAdded', price: 7 }]);
});

test('aggregate: 未知命令走内核错误通道（ask 拿到真实错误，Actor 照常服务）', async () => {
  const dir = tempDir();
  const Order = orderAggregate();
  const system = createSystem({ logger: false, persistence: { dir } });
  const ref = await system.spawn(Order, { id: 'order-2', persistence: persistenceFor(Order) });

  const rejects = assert.rejects(() => ref.ask({ type: 'nope' }), /没有命令 'nope'/);
  const afterRestart = rejects.then(() => ref.ask({ type: 'addItem', price: 1 }));
  await rejects;
  assert.deepStrictEqual(await afterRestart, { status: 'created', totalCents: 1, items: 1 });
  await system.stop();
});

test('aggregate: 重启后 seq 从重放位置继续；日志断号 → 拒绝启动（而不是静默少放一条）', async () => {
  const dir = tempDir();
  const store = new FilePersistence({ baseDir: dir });
  const Order = orderAggregate();

  const system1 = createSystem({ logger: false, persistence: { dir } });
  const ref1 = await system1.spawn(Order, { id: 'order-5', persistence: persistenceFor(Order) });
  await ref1.ask({ type: 'addItem', price: 1 });
  await ref1.ask({ type: 'addItem', price: 2 });
  await system1.stop();

  // 重启：重放把序号计数器推到 2，所以下一条必须是 3（而不是又从 1 开始）
  const system2 = createSystem({ logger: false, persistence: { dir } });
  const ref2 = await system2.spawn(Order, { id: 'order-5', persistence: persistenceFor(Order) });
  await ref2.ask({ type: 'addItem', price: 3 });
  await system2.stop();
  assert.deepStrictEqual(
    ((await store.loadEvents('order-5')) as { seq: number }[]).map((e) => e.seq),
    [1, 2, 3],
  );

  // 制造断号（模拟"事件丢了"或有人手工动了日志）
  await store.appendEvent(
    'order-5',
    createEventEnvelope({ type: 'ItemAdded', version: 2, payload: { type: 'ItemAdded', price: 9 }, seq: 5 }),
  );
  const system3 = createSystem({ logger: false, persistence: { dir } });
  await assert.rejects(
    () => system3.spawn(Order, { id: 'order-5', persistence: persistenceFor(Order) }),
    /序号不连续：第 4 条的 seq=5，期望 4/,
    '序号不连续必须当场报错——静默读下去会得到错的状态',
  );
  await system3.stop();
});

test('aggregate: 两个拥有者抢同一个聚合 → 后来者的命令被拒（乐观并发），日志里没有重复事件', async () => {
  const dir = tempDir();
  const store = new FilePersistence({ baseDir: dir });
  const Order = orderAggregate();
  const options = { id: 'order-7', persistence: persistenceFor(Order) };

  // 两个 system 指向同一个目录 ≈ 两个节点共用一个存储（doc 04 §3 想防的正是这个）
  const a = createSystem({ logger: false, persistence: { dir } });
  const b = createSystem({ logger: false, persistence: { dir } });
  const refA = await a.spawn(Order, options);
  const refB = await b.spawn(Order, options);

  assert.deepStrictEqual(await refA.ask({ type: 'addItem', price: 100 }), {
    status: 'created',
    totalCents: 100,
    items: 1,
  });

  await assert.rejects(
    () => refB.ask({ type: 'addItem', price: 200 }),
    (err: unknown) => {
      assert.strictEqual((err as Error).name, 'PersistenceConflictError');
      return true;
    },
    '第二个拥有者的写入必须被拦住（它是按"日志版本 0"在写，而日志已经到 1）',
  );

  const raw = (await store.loadEvents('order-7')) as { seq: number; payload: { price: number } }[];
  assert.deepStrictEqual(raw.map((e) => e.seq), [1], '冲突的写入不得落盘');
  assert.deepStrictEqual(raw.map((e) => e.payload.price), [100]);

  // 能力如实上报：file 后端只保证同进程
  assert.strictEqual(a.persistenceCapabilities().conditionalAppend, 'in-process');
  await b.stop();
  await a.stop();
});

test('aggregate: 快照结构对不上但日志在 → 丢弃快照、从事件重建（doc 04 §4.2 规则 2）', async () => {
  const dir = tempDir();
  const store = new FilePersistence({ baseDir: dir });

  // 阶段 1：v1 代码 + 手动声明快照结构版本 1（每写一条事件存一次缓存）
  const V1 = defineAggregate<{ totalCents: number }>({
    name: 'Order',
    initialState: () => ({ totalCents: 0 }),
    events: [defineEventSchema({ type: 'ItemAdded', version: 1 })],
    snapshot: { version: 1 },
    applyEvent: (state, event) =>
      event.type === 'ItemAdded' ? { ...state, totalCents: state.totalCents + (event.price as number) } : state,
    commands: { addItem: (cmd) => ({ type: 'ItemAdded', price: (cmd as { price: number }).price }) },
  });
  const system1 = createSystem({ logger: false, persistence: { dir } });
  const ref1 = await system1.spawn(V1, {
    id: 'order-9',
    persistence: { mode: 'events', evolution: V1.evolution ?? undefined, snapshot: { every: 1 } },
  });
  await ref1.ask({ type: 'addItem', price: 7 });
  await system1.stop();

  const cached = (await store.loadSnapshot('order-9')) as {
    __snapshotAtSeq: number;
    snapshot: { stateVersion: number; state: unknown };
  };
  assert.strictEqual(cached.__snapshotAtSeq, 1, '缓存记着重放到第 1 条');
  assert.strictEqual(cached.snapshot.stateVersion, 1);
  assert.deepStrictEqual(cached.snapshot.state, { totalCents: 7 });

  // 阶段 2：状态结构变成 v2（多一个 items 字段）且**没有** migrate。
  // 旧快照会被拒绝，但日志在 → 必须丢弃快照、从事件重建，而不是拒绝启动。
  const V2 = defineAggregate<{ totalCents: number; items: number }>({
    name: 'Order',
    initialState: () => ({ totalCents: 0, items: 0 }),
    events: [defineEventSchema({ type: 'ItemAdded', version: 1 })],
    snapshot: { version: 2 },
    applyEvent: (state, event) =>
      event.type === 'ItemAdded'
        ? { ...state, totalCents: state.totalCents + (event.price as number), items: state.items + 1 }
        : state,
    commands: { addItem: (cmd) => ({ type: 'ItemAdded', price: (cmd as { price: number }).price }) },
  });
  const system2 = createSystem({ logger: false, persistence: { dir } });
  const ref2 = await system2.spawn(V2, {
    id: 'order-9',
    persistence: { mode: 'events', evolution: V2.evolution ?? undefined, snapshot: { every: 1 } },
  });
  assert.deepStrictEqual(
    await ref2.state(),
    { totalCents: 7, items: 1 },
    'items=1 只可能来自事件重放（旧快照里没有这个字段）',
  );
  await system2.stop();

  // 日志本身没有被改写（重建只是"再读一遍"，不写盘）
  const log = (await store.loadEvents('order-9')) as { seq: number; payload: unknown }[];
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].seq, 1);
  assert.deepStrictEqual(log[0].payload, { type: 'ItemAdded', price: 7 });
});

test('aggregate: 快照结构对不上且**没有日志可重建** → 拒绝启动（doc 04 §4.2 规则 3）', async () => {
  const dir = tempDir();
  const store = new FilePersistence({ baseDir: dir });
  // 手工造出"有快照缓存、没有事件日志"的状态（例如有人删了日志）
  await store.saveSnapshot('order-x', {
    __snapshotAtSeq: 5,
    snapshot: { snapshotVersion: 1, stateVersion: 1, takenAt: 0, state: { totalCents: 1, items: 0 } },
  });

  const Order = defineAggregate<{ totalCents: number; items: number }>({
    name: 'Order',
    initialState: () => ({ totalCents: 0, items: 0 }),
    events: [defineEventSchema({ type: 'ItemAdded', version: 1 })],
    snapshot: { version: 2 }, // 没有 migrate
    applyEvent: (state) => state,
    commands: { addItem: () => ({ type: 'ItemAdded', price: 1 }) },
  });

  const system = createSystem({ logger: false, persistence: { dir } });
  await assert.rejects(
    () =>
      system.spawn(Order, {
        id: 'order-x',
        persistence: { mode: 'events', evolution: Order.evolution ?? undefined, snapshot: { every: 0 } },
      }),
    (err: unknown) => {
      assert.strictEqual((err as Error).name, 'StateEvolutionError');
      assert.match((err as Error).message, /v1/);
      return true;
    },
    '没有日志可重建时必须拒绝启动，而不是拿错结构凑合',
  );
  await system.stop();
});

test('aggregate: 批量写——一条命令的多条事件**一次调用**写入（成功全写、失败一条不写）', async () => {
  const calls: unknown[][] = [];
  const written: unknown[] = [];
  const batchStore = {
    capabilities: () => ({ conditionalAppend: 'in-process', batchAppend: 'in-process' }),
    async loadSnapshot() {
      return undefined;
    },
    async saveSnapshot() {},
    async appendEvent(id: string, event: unknown) {
      written.push(event);
    },
    async appendEvents(id: string, list: unknown[], options?: { expectedVersion?: number }) {
      calls.push([...list]);
      if (options?.expectedVersion !== undefined && options.expectedVersion !== written.length) {
        const err = new Error(`期望日志版本 ${options.expectedVersion}，实际 ${written.length}`);
        err.name = 'PersistenceConflictError';
        throw err;
      }
      written.push(...list);
      return list.length;
    },
    async loadEvents() {
      return [...written];
    },
  };

  const Order = defineAggregate<{ totalCents: number; items: number }>({
    name: 'Order',
    initialState: () => ({ totalCents: 0, items: 0 }),
    events: [defineEventSchema({ type: 'ItemAdded', version: 1 })],
    applyEvent: (state, event) =>
      event.type === 'ItemAdded'
        ? { ...state, totalCents: state.totalCents + (event.price as number), items: state.items + 1 }
        : state,
    commands: {
      addTwo: () => [
        { type: 'ItemAdded', price: 100 },
        { type: 'ItemAdded', price: 200 },
      ],
    },
  });

  const persistence = { mode: 'events' as const, store: batchStore, evolution: Order.evolution ?? undefined };
  const a = createSystem({ logger: false });
  const b = createSystem({ logger: false });
  try {
    const refA = await a.spawn(Order, { id: 'order-batch', persistence });
    const refB = await b.spawn(Order, { id: 'order-batch', persistence });

    assert.deepStrictEqual(await refA.ask({ type: 'addTwo' }), { totalCents: 300, items: 2 });
    assert.strictEqual(calls.length, 1, '整批只调用一次 appendEvents（不是两次 appendEvent）');
    assert.strictEqual((calls[0] as unknown[]).length, 2);
    assert.deepStrictEqual(
      (written as { seq: number }[]).map((e) => e.seq),
      [1, 2],
      '两条事件拿到连续的 seq',
    );

    // 第二个拥有者：整批撞车 → 一条都不写
    await assert.rejects(
      () => refB.ask({ type: 'addTwo' }),
      (err: unknown) => (err as Error).name === 'PersistenceConflictError',
    );
    assert.strictEqual(written.length, 2, '冲突的整批没有落盘（不是"写进去一半"）');
  } finally {
    await b.stop();
    await a.stop();
  }
});

test('aggregate: 对照——只实现 appendEvent 的后端上，一条命令可能只写进去一半', async () => {
  let calls = 0;
  const written: unknown[] = [];
  const partialStore = {
    async loadSnapshot() {
      return undefined;
    },
    async saveSnapshot() {},
    async appendEvent(id: string, event: unknown) {
      calls += 1;
      if (calls === 2) throw new Error('模拟：第二条写入时后端出问题');
      written.push(event);
    },
    async loadEvents() {
      return [...written];
    },
  };

  const Order = defineAggregate<{ items: number }>({
    name: 'Order',
    initialState: () => ({ items: 0 }),
    events: [defineEventSchema({ type: 'ItemAdded', version: 1 })],
    applyEvent: (state, event) => (event.type === 'ItemAdded' ? { ...state, items: state.items + 1 } : state),
    commands: { addTwo: () => [{ type: 'ItemAdded' }, { type: 'ItemAdded' }] },
  });

  const system = createSystem({ logger: false });
  try {
    const ref = await system.spawn(Order, {
      id: 'order-partial',
      persistence: { mode: 'events', store: partialStore, evolution: Order.evolution ?? undefined },
    });
    await assert.rejects(() => ref.ask({ type: 'addTwo' }), /模拟：第二条写入时后端出问题/);
    assert.strictEqual(written.length, 1, '第一条已经落盘了——逐条写的代价就是"命令只写了一半"');
  } finally {
    await system.stop();
  }
});
