'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupTempEnv, cleanup, waitFor } = require('./helpers');

const tempDir = setupTempEnv('actor-isolation');

const { createSystem } = require('../src/index.js');

test.after(() => cleanup(tempDir));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PLAYER = './packages/core/test/fixtures/actors/worker-player.js';
const CHILD = './packages/core/test/fixtures/actors/worker-child.js';
let seq = 0;
const uniqueDir = (prefix) => path.join(tempDir, `${prefix}-${++seq}`);

test('worker isolation: the actor runs in its own thread', async () => {
  const system = createSystem({ logger: false });
  try {
    const ref = await system.spawn(PLAYER, { id: 'w1', isolation: 'worker' });
    const info = system.inspect('w1');

    assert.strictEqual(info.isolation, 'worker');
    assert.ok(info.worker && info.worker.pid > 0, 'the worker is reported');
    assert.strictEqual(info.stateLocation, 'worker', 'state lives in the worker');

    // Proof of real thread isolation: the worker reports a different threadId.
    const state = await ref.state();
    assert.notStrictEqual(state.threadId, require('worker_threads').threadId);
    assert.notStrictEqual(state.threadId, 0, 'thread 0 is the main thread');

    assert.strictEqual(await ref.ask({ type: 'hurt', damage: 5 }), 95);
    assert.strictEqual(await ref.ask({ type: 'hurt', damage: 5 }), 90);
    assert.strictEqual(ref.tell({ type: 'poke' }), true);
    await waitFor(async () => (await ref.state()).calls >= 3, { message: 'the tell to be handled' });
  } finally {
    await system.stop();
  }
});

test('worker isolation: a CPU-bound actor does not block the main thread', async () => {
  const system = createSystem({ logger: false });
  try {
    const burner = await system.spawn(PLAYER, { id: 'burner', isolation: 'worker' });
    const inline = await system.spawn(async () => 'quick', { id: 'inline' });

    // Occupy the worker thread with a synchronous spin.
    burner.tell({ type: 'burn', ms: 400 });
    await sleep(30);

    const startedAt = Date.now();
    assert.strictEqual(await inline.ask('ping', 2000), 'quick');
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 200, `the main thread was blocked for ${elapsed}ms by a worker-isolated actor`);
    assert.strictEqual(await burner.ask({ type: 'state' }).then((s) => s.calls >= 1), true);
  } finally {
    await system.stop();
  }
});

test('worker isolation: a crash inside the worker restarts the actor with fresh state', async () => {
  const system = createSystem({ logger: false, defaults: { supervision: { maxRestarts: 5 } } });
  try {
    const ref = await system.spawn(PLAYER, { id: 'crashy', isolation: 'worker' });
    await ref.ask({ type: 'hurt', damage: 30 });
    assert.strictEqual((await ref.state()).hp, 70);

    await assert.rejects(() => ref.ask({ type: 'boom' }), /worker boom/);
    await waitFor(() => system.inspect('crashy').restarts === 1, { message: 'the actor to restart' });

    assert.strictEqual((await ref.state()).hp, 100, 'the new incarnation starts fresh');
    assert.strictEqual(await ref.ask({ type: 'hurt', damage: 1 }), 99, 'and it works');
  } finally {
    await system.stop();
  }
});

test('worker isolation: a non-cloneable reply is reported, not silently lost', async () => {
  const system = createSystem({ logger: false, defaults: { supervision: { maxRestarts: 5 } } });
  try {
    const ref = await system.spawn(PLAYER, { id: 'clone', isolation: 'worker' });
    await assert.rejects(() => ref.ask({ type: 'uncloneable' }), /cannot be cloned/);
    // The message failed, so crash semantics applied and the actor came back.
    await waitFor(() => system.inspect('clone').restarts >= 1, { message: 'the actor to restart' });
    assert.strictEqual(await ref.ask({ type: 'hurt', damage: 0 }), 100);
  } finally {
    await system.stop();
  }
});

test('worker isolation: ctx.spawn and ctx.ask work from inside the worker', async () => {
  const system = createSystem({ logger: false });
  try {
    const parent = await system.spawn(PLAYER, { id: 'parent', isolation: 'worker' });

    const childPath = await parent.ask({ type: 'spawnChild', id: 'kid' });
    assert.strictEqual(childPath, 'parent/kid');
    assert.strictEqual(system.inspect('parent/kid').isolation, 'worker', 'the child is isolated too');
    assert.deepStrictEqual(system.inspect('parent').children, ['kid']);

    assert.strictEqual(await parent.ask({ type: 'askChild', target: 'parent/kid' }), 'child:ping');

    // Stopping the parent stops the worker-isolated child as well.
    await parent.stop();
    await waitFor(() => system.resolve('parent/kid') === null, { message: 'the child to stop' });
  } finally {
    await system.stop();
  }
});

test('worker isolation: snapshots are saved and restored across systems', async () => {
  const dir = uniqueDir('worker-snapshot');

  const first = createSystem({ logger: false, persistenceDir: dir });
  try {
    const ref = await first.spawn(PLAYER, {
      id: 'keeper',
      isolation: 'worker',
      persistence: { mode: 'snapshot' },
    });
    await ref.ask({ type: 'hurt', damage: 25 });
    assert.strictEqual(await ref.ask({ type: 'save' }), 'saved');
  } finally {
    await first.stop();
  }

  const second = createSystem({ logger: false, persistenceDir: dir });
  try {
    const ref = await second.spawn(PLAYER, {
      id: 'keeper',
      isolation: 'worker',
      persistence: { mode: 'snapshot' },
    });
    assert.strictEqual(second.inspect('keeper').persistence.restored, true, 'the snapshot was restored');
    assert.strictEqual((await ref.state()).hp, 75, 'the worker started from the snapshot');
  } finally {
    await second.stop();
  }
});

test('worker isolation: a snapshot is written on graceful stop without an explicit save', async () => {
  const dir = uniqueDir('worker-stop-snapshot');

  const first = createSystem({ logger: false, persistenceDir: dir });
  try {
    const ref = await first.spawn(PLAYER, {
      id: 'keeper',
      isolation: 'worker',
      persistence: { mode: 'snapshot' },
    });
    await ref.ask({ type: 'hurt', damage: 40 });
    assert.strictEqual((await ref.state()).hp, 60);
    // No explicit save: stopping must persist, exactly like inline actors.
  } finally {
    await first.stop();
  }

  const second = createSystem({ logger: false, persistenceDir: dir });
  try {
    const ref = await second.spawn(PLAYER, {
      id: 'keeper',
      isolation: 'worker',
      persistence: { mode: 'snapshot' },
    });
    assert.strictEqual(second.inspect('keeper').persistence.restored, true);
    assert.strictEqual((await ref.state()).hp, 60, 'state survived because stop() snapshotted it');
  } finally {
    await second.stop();
  }
});

test('worker isolation: invalid combinations fail loudly', async () => {
  const system = createSystem({ logger: false, persistenceDir: uniqueDir('invalid') });
  try {
    // Inline definition + worker isolation cannot work (no code to ship).
    await assert.rejects(
      () => system.spawn(async () => 1, { id: 'inline-as-worker', isolation: 'worker' }),
      /module path string/,
    );

    // Unsupported persistence strategy.
    await assert.rejects(
      () => system.spawn(PLAYER, { id: 'events', isolation: 'worker', persistence: { mode: 'events' } }),
      /supports persistence 'none' or 'snapshot'/,
    );

    // Modules outside the project root are refused.
    await assert.rejects(
      () => system.spawn('/etc/passwd', { id: 'outside', isolation: 'worker' }),
      /must live inside/,
    );

    // Unknown isolation value.
    await assert.rejects(
      () => system.spawn(async () => 1, { id: 'bogus', isolation: 'thread' }),
      /unknown isolation/,
    );

    // A module that does not exist fails at start, not silently.
    await assert.rejects(
      () => system.spawn('./packages/core/test/fixtures/actors/nope.js', { id: 'missing', isolation: 'worker' }),
      /Cannot find module|no actor/i,
    );
  } finally {
    await system.stop();
  }
});

test('worker isolation: stop() runs postStop inside the worker and frees the thread', async () => {
  const marker = path.join(os.tmpdir(), 'worker-player-stops.log');
  if (fs.existsSync(marker)) fs.unlinkSync(marker);

  const system = createSystem({ logger: false });
  const ref = await system.spawn(PLAYER, { id: 'stopper', isolation: 'worker' });
  assert.strictEqual(await ref.ask({ type: 'hurt', damage: 1 }), 99);

  await system.stop();
  assert.ok(fs.existsSync(marker), 'postStop ran inside the worker');
  assert.match(fs.readFileSync(marker, 'utf8'), /stopped/);
  fs.unlinkSync(marker);

  assert.strictEqual(system.size, 0);
  assert.strictEqual(system.stopped, true);
});

test('worker isolation: inline and worker actors share one supervision model', async () => {
  const system = createSystem({ logger: false, defaults: { supervision: { maxRestarts: 5 } } });
  try {
    const inline = await system.spawn(async (msg, ctx) => {
      if (msg === 'spawn') {
        return (await ctx.spawn(PLAYER, { id: 'isolated-kid', isolation: 'worker' })).path;
      }
      return 'inline';
    }, { id: 'mixed' });

    assert.strictEqual(await inline.ask('spawn'), 'mixed/isolated-kid');
    assert.strictEqual(await inline.ask('local'), 'inline');
    assert.strictEqual(await system.ref('mixed/isolated-kid').ask({ type: 'hurt', damage: 5 }), 95);

    // A worker child crashing is handled by its inline parent's supervisor.
    await system.ref('mixed/isolated-kid').ask({ type: 'boom' }).catch(() => {});
    await waitFor(
      () => system.inspect('mixed/isolated-kid').restarts === 1,
      { message: 'the inline parent restarted its isolated child' },
    );
    assert.strictEqual(await system.ref('mixed/isolated-kid').ask({ type: 'hurt', damage: 0 }), 100);
    assert.ok(CHILD.includes('worker-child'), 'fixture path sanity');
  } finally {
    await system.stop();
  }
});
