'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { setupTempEnv, cleanup, waitFor } = require('./helpers');

const tempDir = setupTempEnv('actor-fw-persist');

const { createSystem, MemoryPersistence, FilePersistence, Actor } = require('../src/index.ts');
const { MessageStore } = require('../src/store/message-store.ts');

test.after(() => cleanup(tempDir));

const quiet = { logger: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let seq = 0;
const uniqueDir = (prefix) => path.join(tempDir, `${prefix}-${++seq}`);

// ---------------------------------------------------------------------------
// failure semantics: retry / dead letter (opt-in)
// ---------------------------------------------------------------------------

test('failure=retry keeps the actor alive and dead-letters after maxRetry', async () => {
  const system = createSystem({
    ...quiet,
    defaults: { failure: 'retry', maxRetry: 2, retryBackoffMs: 1 },
  });
  try {
    let attempts = 0;
    const ref = await system.spawn(async () => {
      attempts += 1;
      throw new Error('always fails');
    }, { id: 'flaky' });

    await assert.rejects(() => ref.ask('x'), /always fails/);
    await waitFor(() => system.inspect('flaky').counters.deadLettered === 1, { message: 'dead lettered' });

    const info = system.inspect('flaky');
    assert.strictEqual(attempts, 3, 'initial attempt plus two retries');
    assert.strictEqual(info.counters.retries, 2);
    assert.strictEqual(info.counters.crashed, 0, 'the actor never crashed');
    assert.strictEqual(info.started, true, 'the actor is still running');
    assert.strictEqual(system.deadLetters.length, 1);
    assert.strictEqual(system.deadLetters[0].path, 'flaky');
    assert.match(system.deadLetters[0].error, /always fails/);
  } finally {
    await system.stop();
  }
});

test('failure=retry recovers a transient failure without dead-lettering', async () => {
  const system = createSystem({ ...quiet, defaults: { failure: 'retry', maxRetry: 3, retryBackoffMs: 1 } });
  try {
    let attempts = 0;
    const ref = await system.spawn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return 'recovered';
    }, { id: 'transient' });

    assert.strictEqual(await ref.ask('go'), 'recovered', 'the ask resolves after the retry succeeds');
    assert.strictEqual(attempts, 2);
    assert.strictEqual(system.deadLetters.length, 0);
    assert.strictEqual(system.inspect('transient').counters.deadLettered, 0);
  } finally {
    await system.stop();
  }
});

test('failure=retry with maxRetry 0 dead-letters immediately', async () => {
  const system = createSystem({ ...quiet, defaults: { failure: 'retry', maxRetry: 0 } });
  try {
    const ref = await system.spawn(async () => {
      throw new Error('nope');
    }, { id: 'zero' });
    await assert.rejects(() => ref.ask('x'), /nope/);
    assert.strictEqual(system.inspect('zero').counters.retries, 0);
    assert.strictEqual(system.deadLetters.length, 1);
  } finally {
    await system.stop();
  }
});

test('the two failure modes are independent per actor', async () => {
  const system = createSystem({ ...quiet, defaults: { failure: 'crash' } });
  try {
    const crashy = await system.spawn(async () => {
      throw new Error('crash me');
    }, { id: 'crashy' });

    const retrying = await system.spawn(async () => {
      throw new Error('retry me');
    }, { id: 'retrying', failure: 'retry', maxRetry: 1, retryBackoffMs: 1 });

    await assert.rejects(() => retrying.ask('x'), /retry me/);
    assert.strictEqual(system.inspect('retrying').counters.crashed, 0);
    assert.strictEqual(system.deadLetters.filter((d) => d.path === 'retrying').length, 1);

    await assert.rejects(() => crashy.ask('x'), /crash me/);
    await waitFor(() => system.inspect('crashy').counters.crashed >= 1, { message: 'the crashing actor crashed' });
    assert.strictEqual(system.deadLetters.filter((d) => d.path === 'crashy').length, 0, 'crash mode does not dead-letter');
  } finally {
    await system.stop();
  }
});

// ---------------------------------------------------------------------------
// persistence strategies
// ---------------------------------------------------------------------------

test('persistence=none: a restart starts from a clean state', async () => {
  const system = createSystem(quiet);
  try {
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { n: 0 };
        },
        onMessage(msg) {
          if (msg === 'boom') throw new Error('boom');
          this.state.n += 1;
          return this.state.n;
        },
      },
      { id: 'plain' },
    );
    assert.strictEqual(await ref.ask('inc'), 1);
    assert.strictEqual(await ref.ask('inc'), 2);
    await assert.rejects(() => ref.ask('boom'), /boom/);
    await waitFor(() => system.inspect('plain').restarts === 1, { message: 'restarted' });
    assert.strictEqual(await ref.ask('inc'), 1, 'state was reset, not restored');
  } finally {
    await system.stop();
  }
});

test('persistence=snapshot: state survives restarts and a brand new system', async () => {
  const dir = uniqueDir('snapshots');

  const definition = () => ({
    preStart() {
      this.state = { n: 0 };
    },
    async onMessage(msg, ctx) {
      if (msg === 'boom') throw new Error('boom');
      this.state.n += 1;
      await ctx.saveSnapshot();
      return this.state.n;
    },
  });

  const first = createSystem({ ...quiet, persistenceDir: dir });
  try {
    const ref = await first.spawn(definition(), { id: 'counter', persistence: { mode: 'snapshot' } });
    assert.strictEqual(await ref.ask('inc'), 1);
    assert.strictEqual(await ref.ask('inc'), 2);
    await assert.rejects(() => ref.ask('boom'), /boom/);
    await waitFor(() => first.inspect('counter').restarts === 1, { message: 'restarted' });
    assert.strictEqual(await ref.ask('inc'), 3, 'the snapshot was restored after the restart');
  } finally {
    await first.stop();
  }

  // A completely fresh system, same directory: the state is still there.
  const second = createSystem({ ...quiet, persistenceDir: dir });
  try {
    const ref = await second.spawn(definition(), { id: 'counter', persistence: { mode: 'snapshot' } });
    assert.strictEqual(second.inspect('counter').persistence.restored, true, 'state was restored from disk');
    assert.strictEqual(await ref.ask('inc'), 4);
  } finally {
    await second.stop();
  }

  assert.ok(fs.existsSync(path.join(dir, 'snapshots')), 'snapshots are on disk');
});

test('persistence=snapshot: state is saved on graceful stop', async () => {
  const dir = uniqueDir('snapshot-on-stop');
  const system = createSystem({ ...quiet, persistenceDir: dir });
  const ref = await system.spawn(
    {
      preStart() {
        this.state = { visits: 0 };
      },
      onMessage() {
        this.state.visits += 1;
        return this.state.visits;
      },
    },
    { id: 'visits', persistence: { mode: 'snapshot' } },
  );
  await ref.ask('a');
  await ref.ask('b');
  await system.stop();

  const reopened = createSystem({ ...quiet, persistenceDir: dir });
  try {
    const again = await reopened.spawn(
      {
        preStart() {
          this.state = { visits: 0 };
        },
        onMessage() {
          this.state.visits += 1;
          return this.state.visits;
        },
      },
      { id: 'visits', persistence: { mode: 'snapshot' } },
    );
    assert.strictEqual(await again.ask('c'), 3, 'two previous visits were persisted on stop');
  } finally {
    await reopened.stop();
  }
});

test('persistence=snapshot: stopping a parent persists its children too', async () => {
  const dir = path.join(tempDir, 'parent-child-snapshot');

  const first = createSystem({ logger: false, persistenceDir: dir });
  try {
    const parent = await first.spawn(async (msg, ctx) => {
      if (msg === 'spawn') {
        const child = await ctx.spawn(
          {
            preStart() {
              this.state = { hp: 100 };
            },
            onMessage(m) {
              if (m.type === 'hurt') {
                this.state.hp -= m.damage;
                return this.state.hp;
              }
              return this.state.hp;
            },
          },
          { id: 'kid', persistence: { mode: 'snapshot' } },
        );
        return child.path;
      }
      return 'parent';
    }, { id: 'boss', persistence: { mode: 'snapshot' } });

    assert.strictEqual(await parent.ask('spawn'), 'boss/kid');
    // Damage the child but do NOT ask it to save: the parent's stop must do it.
    assert.strictEqual(await first.ref('boss/kid').ask({ type: 'hurt', damage: 40 }), 60);
  } finally {
    await first.stop();
  }

  const second = createSystem({ logger: false, persistenceDir: dir });
  try {
    await second.spawn(async () => 'parent', { id: 'boss', persistence: { mode: 'snapshot' } });
    const child = await second.spawn(
      {
        preStart() {
          this.state = { hp: 100 };
        },
        onMessage(m) {
          if (m.type === 'hurt') {
            this.state.hp -= m.damage;
            return this.state.hp;
          }
          return this.state.hp;
        },
      },
      { id: 'boss/kid', persistence: { mode: 'snapshot' } },
    );
    assert.strictEqual(second.inspect('boss/kid').persistence.restored, true, 'child snapshot was written by the parent stop');
    assert.strictEqual(await child.ask({ type: 'hurt', damage: 0 }), 60);
  } finally {
    await second.stop();
  }
});

test('persistence=events: state is rebuilt by replaying events', async () => {
  const dir = uniqueDir('events');
  class Bank extends Actor {
    preStart() {
      this.state = { balance: 0, applied: 0 };
    }

    async receive(msg, ctx) {
      if (msg.type === 'boom') throw new Error('boom');
      if (msg.type === 'deposit') {
        await ctx.persist({ kind: 'deposit', amount: msg.amount });
        return this.state.balance;
      }
      return this.state.balance;
    }

    applyEvent(event) {
      if (event.kind === 'deposit') {
        this.state.balance += event.amount;
        this.state.applied += 1;
      }
    }
  }

  const opts = { id: 'bank', persistence: { mode: 'events' } };
  const first = createSystem({ ...quiet, persistenceDir: dir });
  try {
    const ref = await first.spawn(Bank, opts);
    assert.strictEqual(await ref.ask({ type: 'deposit', amount: 10 }), 10);
    assert.strictEqual(await ref.ask({ type: 'deposit', amount: 5 }), 15);
    await assert.rejects(() => ref.ask({ type: 'boom' }), /boom/);
    await waitFor(() => first.inspect('bank').restarts === 1, { message: 'restarted' });
    assert.strictEqual(await ref.ask({ type: 'balance' }), 15, 'events were replayed after the restart');
  } finally {
    await first.stop();
  }

  const second = createSystem({ ...quiet, persistenceDir: dir });
  try {
    const ref = await second.spawn(Bank, opts);
    assert.strictEqual(second.inspect('bank').persistence.restored, true);
    assert.strictEqual(await ref.ask({ type: 'balance' }), 15, 'and after a full process restart');
    assert.strictEqual(second.inspect('bank').counters.recovered, 2, 'two events were replayed');
  } finally {
    await second.stop();
  }
});

test('persistence=mailbox: unacknowledged messages are replayed, in order, to a new system', async () => {
  const baseDir = uniqueDir('mailbox');
  const mailboxStore = new MessageStore({ baseDir });

  const first = createSystem({ ...quiet, mailboxStore });
  const ref = await first.spawn(async () => 'handled', {
    id: 'durable',
    persistence: { mode: 'mailbox' },
    mailbox: { maxSize: 100 },
  });

  // Enqueue and stop in the same tick: the stop message uses the system lane,
  // so these messages are dropped before being processed and never acked.
  ref.tell('m1');
  ref.tell('m2');
  ref.tell('m3');
  await first.stop();
  await sleep(50); // let the enqueue-time writes land

  assert.strictEqual(await mailboxStore.pendingCount('durable'), 3, 'unacknowledged messages are durable');

  const seen = [];
  const second = createSystem({ ...quiet, mailboxStore });
  try {
    await second.spawn(async (msg) => {
      seen.push(msg);
      return 'ok';
    }, { id: 'durable', persistence: { mode: 'mailbox' } });

    await waitFor(() => seen.length === 3, { message: 'the queued messages to be replayed', timeout: 3000 });
    assert.deepStrictEqual(seen, ['m1', 'm2', 'm3'], 'replay preserves enqueue order');
    assert.strictEqual(second.inspect('durable').counters.recovered, 3);
    await waitFor(() => second.inspect('durable').counters.handled === 3, { message: 'replayed messages handled' });
    await waitFor(async () => (await mailboxStore.pendingCount('durable')) === 0, { message: 'acks cleared the mailbox' });
  } finally {
    await second.stop();
  }
});

test('persistence=mailbox without a store fails loudly instead of silently dropping durability', async () => {
  const system = createSystem(quiet);
  try {
    await assert.rejects(
      () => system.spawn(async () => 1, { id: 'nostore', persistence: { mode: 'mailbox' } }),
      /no mailboxStore was configured/,
    );
    await assert.rejects(
      () => system.spawn(async () => 1, { id: 'nosnap', persistence: { mode: 'snapshot' } }),
      /no store was configured/,
    );
  } finally {
    await system.stop();
  }
});

test('a custom persistence adapter can be plugged in', async () => {
  const adapter = new MemoryPersistence();
  const system = createSystem({ ...quiet, persistence: adapter });
  try {
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { n: 0 };
        },
        async onMessage(msg, ctx) {
          if (msg === 'boom') throw new Error('boom');
          this.state.n += 1;
          await ctx.persist({ delta: 1 });
          return this.state.n;
        },
        applyEvent(event) {
          if (event && event.delta) this.state.n += 0; // state already initialised by preStart
        },
      },
      { id: 'memo', persistence: { mode: 'events' } },
    );
    assert.strictEqual(await ref.ask('a'), 1);
    assert.deepStrictEqual(await adapter.loadEvents('memo'), [{ delta: 1 }]);
    await adapter.saveSnapshot('memo', { n: 7 });
    assert.deepStrictEqual(await adapter.loadSnapshot('memo'), { n: 7 });
  } finally {
    await system.stop();
  }
});

test('FilePersistence tolerates a torn event tail', async () => {
  const dir = uniqueDir('torn');
  const store = new FilePersistence({ baseDir: dir });
  await store.appendEvent('a', { n: 1 });
  await store.appendEvent('a', { n: 2 });
  const file = path.join(dir, 'events');
  const [name] = fs.readdirSync(file);
  fs.appendFileSync(path.join(file, name), '{"n":3');
  assert.deepStrictEqual((await store.loadEvents('a')).map((e) => e.n), [1, 2]);

  const memory = new MemoryPersistence();
  await memory.saveSnapshot('b', { ok: true });
  assert.deepStrictEqual(await memory.loadSnapshot('b'), { ok: true });
  assert.strictEqual(await memory.loadSnapshot('missing'), undefined);
});

// ---------------------------------------------------------------------------
// 条件写（乐观并发）与后端能力
// ---------------------------------------------------------------------------

test('persistence: 条件写——版本对不上就抛冲突且不写入（memory 与 file 都要）', async () => {
  const adopters = [
    ['memory', () => new MemoryPersistence()],
    ['file', () => new FilePersistence({ baseDir: uniqueDir('cond') })],
  ];
  for (const [name, make] of adopters) {
    const store = make();
    assert.deepStrictEqual(
      store.capabilities(),
      { conditionalAppend: 'in-process' },
      `${name}: 能力要如实报（file 没有跨进程原子性，不能报 atomic）`,
    );

    await store.appendEvent('agg', { n: 1 }, { expectedVersion: 0 });
    await assert.rejects(
      () => store.appendEvent('agg', { n: 2 }, { expectedVersion: 0 }),
      (err) => {
        assert.strictEqual(err.name, 'PersistenceConflictError');
        assert.strictEqual(err.actorId, 'agg');
        assert.strictEqual(err.expectedVersion, 0);
        assert.strictEqual(err.actualVersion, 1);
        return true;
      },
      `${name}: 冲突要抛 PersistenceConflictError`,
    );
    assert.strictEqual((await store.loadEvents('agg')).length, 1, `${name}: 失败的写入不得落盘`);

    await store.appendEvent('agg', { n: 2 }, { expectedVersion: 1 });
    assert.deepStrictEqual(await store.loadEvents('agg'), [{ n: 1 }, { n: 2 }]);

    // 不传 expectedVersion 时行为与以前一致（纯追加）
    await store.appendEvent('agg', { n: 3 });
    assert.strictEqual((await store.loadEvents('agg')).length, 3);

    // 非法 expectedVersion 明确报错，而不是被当成"期望 0"
    await assert.rejects(() => store.appendEvent('agg', { n: 4 }, { expectedVersion: 1.5 }), /expectedVersion 必须是/);
  }
});

test('persistence: file 后端的条件写在"另一个实例"（冷缓存）下也会先数日志再判断', async () => {
  const dir = uniqueDir('cond-cold');
  const writer = new FilePersistence({ baseDir: dir });
  await writer.appendEvent('agg', { n: 1 }, { expectedVersion: 0 });

  // 模拟另一个进程/另一个实例：本地缓存是空的，必须自己去读文件数条数
  const other = new FilePersistence({ baseDir: dir });
  await assert.rejects(
    () => other.appendEvent('agg', { n: 2 }, { expectedVersion: 0 }),
    (err) => err.name === 'PersistenceConflictError' && err.actualVersion === 1,
  );
  await other.appendEvent('agg', { n: 2 }, { expectedVersion: 1 });
  assert.strictEqual((await new FilePersistence({ baseDir: dir }).loadEvents('agg')).length, 2);
});

test('persistence: 内核把日志版本带上做条件写；两个实例抢同一个聚合时后来者被拒', async () => {
  const dir = uniqueDir('cond-actor');
  const definition = {
    preStart() {
      this.state = { n: 0 };
    },
    async receive(msg, ctx) {
      await ctx.persist({ type: 'Bump', n: 1 });
      return this.state.n;
    },
    applyEvent(event) {
      if (event.type === 'Bump') this.state.n += event.n;
    },
  };

  // 两个系统各自持有一个指向**同一个目录**的 FilePersistence 实例 ≈ 两个节点共用一个存储
  const a = createSystem({ ...quiet, persistence: { dir } });
  const b = createSystem({ ...quiet, persistence: { dir } });
  try {
    const options = { id: 'shared', persistence: { mode: 'events' } };
    const refA = await a.spawn(definition, options);
    const refB = await b.spawn(definition, options);

    // B 在 A 写入之前就读完了日志（版本 0），此后再写就会撞上 A 的写入
    assert.strictEqual(await refA.ask({ type: 'bump' }), 1);
    await assert.rejects(
      () => refB.ask({ type: 'bump' }),
      (err) => {
        assert.strictEqual(err.name, 'PersistenceConflictError');
        assert.match(err.message, /期望日志版本 0，实际 1/);
        return true;
      },
      '第二个拥有者必须被拦住，而不是把重复的事件写进同一个日志',
    );

    // 日志里只有 A 写的那一条（B 没有落盘）
    const store = new FilePersistence({ baseDir: dir });
    assert.deepStrictEqual(await store.loadEvents('shared'), [{ type: 'Bump', n: 1 }]);
    assert.strictEqual(a.persistenceCapabilities().conditionalAppend, 'in-process');
  } finally {
    await b.stop();
    await a.stop();
  }
});

test('persistence: 没有 capabilities() 的自定义适配器 → 能力为 false，且不传条件（不误报有保护）', async () => {
  const events = [];
  const plainAdapter = {
    async loadSnapshot() {
      return undefined;
    },
    async saveSnapshot() {},
    async appendEvent(id, event) {
      events.push(event);
    },
    async loadEvents() {
      return [...events];
    },
    async deleteEvents() {
      events.length = 0;
    },
  };
  const system = createSystem({ ...quiet, persistence: plainAdapter });
  try {
    assert.deepStrictEqual(system.persistenceCapabilities(), { conditionalAppend: false });
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { n: 0 };
        },
        async receive(msg, ctx) {
          await ctx.persist({ type: 'Bump', n: 1 });
          return this.state.n;
        },
        applyEvent(event) {
          if (event.type === 'Bump') this.state.n += event.n;
        },
      },
      { id: 'plain', persistence: { mode: 'events' } },
    );
    assert.strictEqual(await ref.ask({}), 1, '不支持条件写也要能正常写（只是没有并发保护）');
    assert.strictEqual(events.length, 1);
  } finally {
    await system.stop();
  }
});
