'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, waitFor } = require('./helpers');

const tempDir = setupTempEnv('actor-scale');

const { createSystem } = require('../src/index.ts');

test.after(() => cleanup(tempDir));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('scheduler: a busy actor does not starve an idle one', async () => {
  const system = createSystem({ logger: false, messagesPerTurn: 8 });
  try {
    const busy = await system.spawn(async () => {
      await sleep(1);
      return 'busy';
    }, { id: 'busy', mailbox: { maxSize: 5000 } });
    const idle = await system.spawn(async () => 'quick', { id: 'idle' });

    for (let i = 0; i < 400; i += 1) busy.tell(i);
    await sleep(5); // let the busy actor get going

    const startedAt = Date.now();
    assert.strictEqual(await idle.ask('ping', 3000), 'quick');
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 1000, `the idle actor replied in ${elapsed}ms while the busy one drained`);
    assert.ok(
      system.inspect('busy').counters.handled < 400,
      'the busy actor was still working, so the reply really did interleave',
    );
  } finally {
    await system.stop();
  }
});

test('scheduler: work is shared fairly across many busy actors', async () => {
  const system = createSystem({ logger: false, messagesPerTurn: 4 });
  try {
    const N = 20;
    const refs = [];
    for (let i = 0; i < N; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      refs.push(await system.spawn(async () => {
        await sleep(1);
        return 'done';
      }, { id: `worker-${i}`, mailbox: { maxSize: 200 } }));
    }
    for (const ref of refs) for (let i = 0; i < 20; i += 1) ref.tell(i);

    await waitFor(
      () => refs.every((ref) => system.inspect(ref.id).counters.handled === 20),
      { message: 'every actor to finish its 20 messages', timeout: 10000 },
    );
    const handled = refs.map((ref) => system.inspect(ref.id).counters.handled);
    assert.ok(handled.every((n) => n === 20), `uneven progress: ${handled.join(',')}`);
  } finally {
    await system.stop();
  }
});

test('scale: 10k in-process actors are cheap and all reachable', async () => {
  const system = createSystem({ logger: false, messagesPerTurn: 64 });
  const N = 10000;
  const before = process.memoryUsage().rss;

  try {
    const definition = {
      state: { n: 0 },
      onMessage() {
        this.state.n += 1;
        return this.state.n;
      },
    };

    const startedAt = Date.now();
    for (let i = 0; i < N; i += 1) {
      // Sequential on purpose: this measures spawn cost, not scheduling.
      // eslint-disable-next-line no-await-in-loop
      await system.spawn(definition, { id: `a${i}` });
    }
    const spawnMs = Date.now() - startedAt;
    const after = process.memoryUsage().rss;
    // rss is in bytes: convert to KiB before dividing by the actor count.
    const perActorKb = (after - before) / 1024 / N;

    assert.strictEqual(system.size, N);

    // A worker thread per actor costs ~4MB (measured), i.e. ~40GB for 10k;
    // in-process actors must be orders of magnitude cheaper.
    assert.ok(
      perActorKb < 40,
      `expected well under 40KB per actor, measured ${perActorKb.toFixed(1)}KB (spawn took ${spawnMs}ms)`,
    );

    // Every actor is reachable and answers.
    const answers = await Promise.all(Array.from({ length: N }, (_, i) => system.ref(`a${i}`).ask('ping')));
    assert.ok(answers.every((n) => n === 1), 'all 10k actors answered');

    // Shutdown is complete: no actor is left behind.
    await system.stop();
    assert.strictEqual(system.size, 0);
    assert.strictEqual(system.stats().actors, 0);
  } finally {
    await system.stop();
  }
});

test('stats() reports the live picture', async () => {
  const system = createSystem({ logger: false });
  try {
    const ref = await system.spawn(async () => {
      await sleep(5);
      return 'ok';
    }, { id: 'one' });
    for (let i = 0; i < 5; i += 1) ref.tell(i);

    const stats = system.stats();
    assert.strictEqual(stats.actors, 1);
    assert.ok(stats.mailboxDepth >= 1, `expected queued messages, saw ${stats.mailboxDepth}`);
    assert.strictEqual(stats.rootSupervisor.children.includes('one'), true);
    assert.ok(stats.uptimeMs >= 0);

    await waitFor(() => system.inspect('one').counters.handled === 5, { message: 'queue drained' });
    assert.strictEqual(system.stats().mailboxDepth, 0);
  } finally {
    await system.stop();
  }
});

test('system shutdown is idempotent and refuses new actors afterwards', async () => {
  const system = createSystem({ logger: false });
  const ref = await system.spawn(async () => 'ok', { id: 'a' });
  assert.strictEqual(await ref.ask('x'), 'ok');

  await system.stop();
  await system.stop(); // must not throw
  assert.strictEqual(system.stopped, true);
  await assert.rejects(() => system.spawn(async () => 'ok', { id: 'b' }), /system is stopped/);
  assert.strictEqual(system.size, 0);
});
