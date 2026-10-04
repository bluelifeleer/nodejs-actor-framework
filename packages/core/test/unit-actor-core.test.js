'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, waitFor } = require('./helpers');

const tempDir = setupTempEnv('actor-framework');

const fw = require('../src/index.js');
const { Actor, createSystem, defineActor, MemoryPersistence, FilePersistence, RestartStrategy } = fw;
const {
  AskTimeoutError,
  MailboxFullError,
  ActorStoppedError,
  DefinitionError,
  ActorNotFoundError,
} = fw;

test.after(() => cleanup(tempDir));

const quiet = { logger: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A system that records its log events, for assertions. */
function trackedSystem(options = {}) {
  const events = [];
  const system = createSystem({ logger: (event, meta) => events.push({ event, ...meta }), ...options });
  return { system, events };
}

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

test('define: all supported definition styles produce a working actor', async () => {
  class Classic extends Actor {
    preStart() {
      this.state = { hits: 0 };
    }

    async receive(msg) {
      this.state.hits += 1;
      return `${msg}:${this.state.hits}`;
    }
  }

  const system = createSystem(quiet);
  try {
    const klass = await system.spawn(Classic, { id: 'classic' });
    assert.strictEqual(await klass.ask('a'), 'a:1');

    const bare = await system.spawn(async (msg) => `bare:${msg}`, { id: 'bare' });
    assert.strictEqual(await bare.ask('x'), 'bare:x');

    const bag = await system.spawn(
      {
        state: { n: 0 },
        onStart() {
          this.started = true;
        },
        onMessage(msg) {
          this.state.n += 1;
          return this.state.n;
        },
        onStop() {
          this.stopped = true;
        },
      },
      { id: 'bag' },
    );
    assert.strictEqual(await bag.ask('any'), 1);
    assert.strictEqual(await bag.ask('any'), 2);

    const obj = await system.spawn({ receive: (msg) => `obj:${msg}` }, { id: 'obj' });
    assert.strictEqual(await obj.ask('y'), 'obj:y');
  } finally {
    await system.stop();
  }
});

test('define: bad definitions fail loudly at definition time', () => {
  assert.throws(() => defineActor(null), DefinitionError);
  assert.throws(() => defineActor({ state: {} }), /needs a message handler/);
  assert.throws(() => defineActor(42), /unsupported definition/);
});

test('define: an actor without receive fails when spawned, not silently', async () => {
  class Broken extends Actor {}
  const system = createSystem(quiet);
  try {
    await assert.rejects(() => system.spawn(Broken, { id: 'broken' }), /does not implement receive/);
  } finally {
    await system.stop();
  }
});

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

test('tell is fire-and-forget and ask returns the handler result', async () => {
  const system = createSystem(quiet);
  try {
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { seen: [] };
        },
        onMessage(msg) {
          this.state.seen.push(msg);
          return msg * 2;
        },
      },
      { id: 'math' },
    );

    assert.strictEqual(ref.tell(1), true, 'tell reports acceptance');
    assert.strictEqual(await ref.ask(2), 4);
    await waitFor(() => system.inspect('math').counters.handled === 2, { message: 'both messages handled' });
    assert.deepStrictEqual(system.inspect('math').state.seen, [1, 2]);
  } finally {
    await system.stop();
  }
});

test('ask times out with AskTimeoutError and the actor keeps running', async () => {
  const system = createSystem(quiet);
  try {
    const ref = await system.spawn(async () => {
      await sleep(200);
      return 'late';
    }, { id: 'slow' });
    await assert.rejects(() => ref.ask('x', 30), AskTimeoutError);
    assert.strictEqual(await ref.ask('y', 1000), 'late');
    assert.ok(system.inspect('slow').started);
  } finally {
    await system.stop();
  }
});

test('an actor that throws surfaces the error to the caller (default crash semantics)', async () => {
  const { system, events } = trackedSystem();
  try {
    const ref = await system.spawn(async (msg) => {
      if (msg === 'boom') throw new Error('kaboom');
      return 'fine';
    }, { id: 'flaky' });
    await assert.rejects(() => ref.ask('boom'), /kaboom/);
    assert.ok(events.some((e) => e.event === 'actor_crash'));
    assert.strictEqual(await ref.ask('ok'), 'fine', 'the actor is back after the restart');
  } finally {
    await system.stop();
  }
});

test('a message queued when the target stops rejects instead of hanging', async () => {
  const system = createSystem(quiet);
  try {
    const ref = await system.spawn(async () => {
      await sleep(80);
      return 'done';
    }, { id: 'stops' });
    const inflight = ref.ask('slow');
    const stopPromise = ref.stop();
    await assert.rejects(() => inflight, ActorStoppedError);
    await stopPromise;
    await assert.rejects(() => ref.ask('after'), ActorStoppedError);
  } finally {
    await system.stop();
  }
});

test('sending to an unknown actor fails clearly', () => {
  const system = createSystem(quiet);
  try {
    assert.strictEqual(system.resolve('nobody'), null);
    assert.throws(() => system.ref('nobody'), ActorNotFoundError);
    assert.throws(() => system.inspect('nobody'), ActorNotFoundError);
  } finally {
    system.stop();
  }
});

test('two actors cannot share an id', async () => {
  const system = createSystem(quiet);
  try {
    await system.spawn(async () => 1, { id: 'dup' });
    await assert.rejects(() => system.spawn(async () => 2, { id: 'dup' }), /already exists/);
  } finally {
    await system.stop();
  }
});

// ---------------------------------------------------------------------------
// backpressure
// ---------------------------------------------------------------------------

test('mailbox backpressure: reject, drop-oldest and drop-newest', async () => {
  const makeBlocked = async (overflow) => {
    const system = createSystem(quiet);
    const gate = { release: null };
    const ref = await system.spawn(async () => {
      await new Promise((resolve) => {
        gate.release = resolve;
      });
      return 'released';
    }, { id: `bp-${overflow}`, mailbox: { maxSize: 2, overflow } });
    ref.tell('occupies the actor');
    await waitFor(() => gate.release !== null, { message: 'the actor to be busy' });
    return { system, ref, gate };
  };

  // reject: the third message is refused
  {
    const { system, ref, gate } = await makeBlocked('reject');
    assert.strictEqual(ref.tell('a'), true);
    assert.strictEqual(ref.tell('b'), true);
    assert.strictEqual(ref.tell('c'), false, 'the mailbox refused the message');
    await assert.rejects(() => ref.ask('d', 50), MailboxFullError);
    assert.strictEqual(system.inspect(ref.id).mailbox.rejected >= 1, true);
    gate.release();
    await system.stop();
  }

  // drop-oldest: accepted, but something was evicted
  {
    const { system, ref, gate } = await makeBlocked('drop-oldest');
    ref.tell('a');
    ref.tell('b');
    assert.strictEqual(ref.tell('c'), true);
    assert.strictEqual(system.inspect(ref.id).mailbox.dropped, 1);
    gate.release();
    await system.stop();
  }

  // drop-newest: reported as not accepted
  {
    const { system, ref, gate } = await makeBlocked('drop-newest');
    ref.tell('a');
    ref.tell('b');
    assert.strictEqual(ref.tell('c'), false);
    assert.strictEqual(system.inspect(ref.id).mailbox.dropped, 1);
    gate.release();
    await system.stop();
  }
});

// ---------------------------------------------------------------------------
// lifecycle & context
// ---------------------------------------------------------------------------

test('lifecycle order is preStart -> receive* -> postStop', async () => {
  const order = [];
  const system = createSystem(quiet);
  try {
    const ref = await system.spawn(
      {
        preStart() {
          order.push('preStart');
        },
        onMessage(msg) {
          order.push(`receive:${msg}`);
          return msg;
        },
        postStop() {
          order.push('postStop');
        },
      },
      { id: 'lifecycle' },
    );
    await ref.ask('a');
    await ref.ask('b');
    await ref.stop();
    assert.deepStrictEqual(order, ['preStart', 'receive:a', 'receive:b', 'postStop']);
  } finally {
    await system.stop();
  }
});

test('a restart creates a fresh instance: preRestart, postStop, then preStart again', async () => {
  const phases = [];
  const { system } = trackedSystem();
  try {
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { hp: 100 };
          phases.push('preStart');
        },
        onMessage(msg) {
          if (msg === 'boom') throw new Error('boom');
          return this.state.hp;
        },
        preRestart(reason) {
          phases.push(`preRestart:${reason.message}`);
        },
        postStop() {
          phases.push('postStop');
        },
      },
      { id: 'restarter' },
    );

    await waitFor(() => system.inspect('restarter').state.hp === 100, { message: 'initial state' });
    await assert.rejects(() => ref.ask('boom'), /boom/);
    await waitFor(() => system.inspect('restarter').restarts === 1, { message: 'the restart to finish' });

    assert.deepStrictEqual(phases, ['preStart', 'preRestart:boom', 'postStop', 'preStart']);
    assert.strictEqual(system.inspect('restarter').state.hp, 100, 'state is fresh, not carried over');
  } finally {
    await system.stop();
  }
});

test('messages queued behind a failing message still run after the restart', async () => {
  const system = createSystem(quiet);
  try {
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { handled: [] };
        },
        async onMessage(msg) {
          if (msg === 'boom') throw new Error('boom');
          await sleep(0);
          this.state.handled.push(msg);
          return msg;
        },
      },
      { id: 'queue' },
    );

    ref.ask('boom').catch(() => {});
    const second = ref.ask('after-1');
    const third = ref.ask('after-2');

    assert.strictEqual(await second, 'after-1');
    assert.strictEqual(await third, 'after-2');
    assert.deepStrictEqual(system.inspect('queue').state.handled, ['after-1', 'after-2']);
  } finally {
    await system.stop();
  }
});

test('ctx exposes self, sender, path, children and restored', async () => {
  const system = createSystem(quiet);
  try {
    const seen = [];
    const parent = await system.spawn(
      {
        preStart() {
          seen.push(`restored:${this.ctxFlag}`);
        },
        async onMessage(msg, ctx) {
          seen.push({ self: ctx.self.path, sender: ctx.sender ? ctx.sender.path : null, restored: ctx.restored });
          if (msg === 'spawn') {
            const child = await ctx.spawn({ receive: async () => 'child-ok' }, { id: 'kid' });
            return child.path;
          }
          if (msg === 'viaPath') return ctx.ask('parent/kid', 'ping');
          return 'ok';
        },
      },
      { id: 'parent' },
    );

    assert.strictEqual(await parent.ask('spawn'), 'parent/kid');
    assert.deepStrictEqual(system.inspect('parent').children, ['kid']);
    assert.strictEqual(await parent.ask('viaPath'), 'child-ok');

    const external = seen.find((s) => typeof s === 'object');
    assert.strictEqual(external.self, 'parent');
    assert.strictEqual(external.sender, null, 'an external ask has no actor sender');
    assert.strictEqual(external.restored, false);

    // Actor-to-actor: the callee sees the caller as sender.
    const child = await system.spawn(async (msg, ctx) => (ctx.sender ? ctx.sender.path : null), { id: 'echo' });
    const relay = await system.spawn(async (msg, ctx) => ctx.ask('echo', 'hi'), { id: 'relay' });
    assert.strictEqual(await relay.ask('go'), 'relay');
    assert.strictEqual(await child.ask('direct'), null, 'an external ask has no actor sender');
  } finally {
    await system.stop();
  }
});

test('ctx.log records through the system logger with the actor path', async () => {
  const { system, events } = trackedSystem();
  try {
    const ref = await system.spawn(async (msg, ctx) => {
      ctx.log('received', { msg });
      return 'ok';
    }, { id: 'logger' });
    await ref.ask('hello');
    const line = events.find((e) => e.event === 'actor' && e.message === 'received');
    assert.ok(line, 'the log line was emitted');
    assert.strictEqual(line.path, 'logger');
    assert.strictEqual(line.msg, 'hello');
  } finally {
    await system.stop();
  }
});

// ---------------------------------------------------------------------------
// supervision
// ---------------------------------------------------------------------------

test('a parent restarts a crashed child (one_for_one)', async () => {
  const system = createSystem(quiet);
  try {
    const parent = await system.spawn(
      {
        async onMessage(msg, ctx) {
          if (msg === 'spawn') {
            const child = await ctx.spawn(
              {
                preStart() {
                  this.state = { lives: 0 };
                },
                onMessage(m) {
                  this.state.lives += 1;
                  if (m === 'boom') throw new Error('child boom');
                  return this.state.lives;
                },
              },
              { id: 'c1', supervision: { strategy: RestartStrategy.ONE_FOR_ONE, maxRestarts: 5 } },
            );
            return child.path;
          }
          return 'ok';
        },
      },
      { id: 'sup', supervision: { maxRestarts: 5 } },
    );

    await parent.ask('spawn');
    await assert.rejects(() => system.ref('sup/c1').ask('boom'), /child boom/);
    await waitFor(() => system.inspect('sup/c1').restarts === 1, { message: 'child restarted' });
    assert.strictEqual(await system.ref('sup/c1').ask('ping'), 1, 'fresh child instance');
  } finally {
    await system.stop();
  }
});

test('one_for_all restarts every sibling when one crashes', async () => {
  const system = createSystem(quiet);
  try {
    const parent = await system.spawn(
      {
        async onMessage(msg, ctx) {
          if (msg === 'spawn') {
            for (const id of ['a', 'b']) {
              await ctx.spawn(
                {
                  async onMessage(m) {
                    if (m === 'boom') throw new Error('boom');
                    return `${id}-ok`;
                  },
                },
                { id },
              );
            }
            return 'spawned';
          }
          return 'ok';
        },
      },
      { id: 'group', supervision: { strategy: RestartStrategy.ONE_FOR_ALL, maxRestarts: 5 } },
    );

    await parent.ask('spawn');
    await assert.rejects(() => system.ref('group/a').ask('boom'), /boom/);
    await waitFor(
      () => system.inspect('group/a').restarts >= 1 && system.inspect('group/b').restarts >= 1,
      { message: 'both siblings restarted' },
    );
    assert.strictEqual(await system.ref('group/a').ask('x'), 'a-ok');
    assert.strictEqual(await system.ref('group/b').ask('x'), 'b-ok');
  } finally {
    await system.stop();
  }
});

test('rest_for_one restarts the crashed child and the ones started after it', async () => {
  const system = createSystem(quiet);
  try {
    const parent = await system.spawn(
      {
        async onMessage(msg, ctx) {
          if (msg === 'spawn') {
            for (const id of ['first', 'second', 'third']) {
              await ctx.spawn({ async onMessage(m) { if (m === 'boom') throw new Error('boom'); return id; } }, { id });
            }
            return 'spawned';
          }
          return 'ok';
        },
      },
      { id: 'rest', supervision: { strategy: RestartStrategy.REST_FOR_ONE, maxRestarts: 5 } },
    );

    await parent.ask('spawn');
    await assert.rejects(() => system.ref('rest/second').ask('boom'), /boom/);
    await waitFor(() => system.inspect('rest/third').restarts >= 1, { message: 'third restarted too' });
    assert.strictEqual(system.inspect('rest/first').restarts, 0, 'the earlier child is untouched');
    assert.strictEqual(system.inspect('rest/second').restarts, 1);
    assert.strictEqual(system.inspect('rest/third').restarts, 1);
  } finally {
    await system.stop();
  }
});

test('exceeding restart intensity escalates and stops the system without deadlocking', async () => {
  const { system } = trackedSystem({ defaults: { supervision: { maxRestarts: 2, withinSeconds: 60 } } });
  const failures = [];
  system.on('system_failure', (err) => failures.push(err));

  const ref = await system.spawn(async () => {
    throw new Error('always fails');
  }, { id: 'hopeless' });

  for (let i = 0; i < 3; i += 1) {
    await ref.ask('x').catch(() => {});
  }

  await waitFor(() => failures.length > 0, { message: 'the escalation to be reported', timeout: 3000 });
  assert.match(failures[0].message, /could not be restarted|exceeded its restart intensity/);
  await waitFor(() => system.stopped === true, { message: 'the system to stop itself', timeout: 3000 });
});

test('a child that never starts successfully does not block spawn forever', async () => {
  const { system } = trackedSystem();
  try {
    const parent = await system.spawn(async (msg, ctx) => {
      if (msg === 'spawn') {
        return ctx.spawn(
          class Bad extends Actor {
            async receive() {
              return 'never reached';
            }

            preStart() {
              throw new Error('cannot start');
            }
          },
          { id: 'bad' },
        );
      }
      return 'ok';
    }, { id: 'starter', supervision: { maxRestarts: 1, withinSeconds: 60 } });

    await assert.rejects(() => parent.ask('spawn'), /cannot start/);
  } finally {
    await system.stop();
  }
});

test('stopping a parent stops its children', async () => {
  const system = createSystem(quiet);
  try {
    const parent = await system.spawn(async (msg, ctx) => {
      if (msg === 'spawn') {
        const child = await ctx.spawn({ async onMessage() { return 'child'; } }, { id: 'leaf' });
        return child.path;
      }
      return 'ok';
    }, { id: 'tree' });

    await parent.ask('spawn');
    assert.ok(system.resolve('tree/leaf'));
    await parent.stop();
    await waitFor(() => system.resolve('tree/leaf') === null, { message: 'the child was stopped too' });
  } finally {
    await system.stop();
  }
});

test('an actor never processes two messages concurrently (regression)', async () => {
  // Without the turn guard, a message arriving while receive() was awaiting
  // started a second turn and re-entered receive() concurrently.
  const system = createSystem({ logger: false, messagesPerTurn: 8 });
  try {
    let concurrent = 0;
    let maxConcurrent = 0;
    const order = [];
    const ref = await system.spawn(async (msg) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(`start:${msg}`);
      await sleep(5);
      order.push(`end:${msg}`);
      concurrent -= 1;
      return msg;
    }, { id: 'serial', mailbox: { maxSize: 100 } });

    for (let i = 0; i < 20; i += 1) ref.tell(i);
    await waitFor(() => system.inspect('serial').counters.handled === 20, { message: 'all messages handled' });

    assert.strictEqual(maxConcurrent, 1, 'receive() was re-entered concurrently');
    for (let i = 0; i < order.length; i += 2) {
      assert.match(order[i], /^start:/, `expected a start marker at ${i}`);
      assert.match(order[i + 1], /^end:/, `expected an end marker at ${i + 1}`);
    }
    assert.strictEqual(order.length, 40);
  } finally {
    await system.stop();
  }
});

test('a nested await inside receive does not lose queued messages', async () => {
  const system = createSystem({ logger: false });
  try {
    const seen = [];
    const ref = await system.spawn(async (msg, ctx) => {
      if (msg === 'fetch') {
        const other = await ctx.ask('helper', 'compute');
        seen.push(other);
        return 'fetched';
      }
      return 'ok';
    }, { id: 'caller' });
    await system.spawn(async () => 'from-helper', { id: 'helper' });

    const results = await Promise.all([ref.ask('fetch'), ref.ask('x'), ref.ask('y')]);
    assert.deepStrictEqual(results, ['fetched', 'ok', 'ok']);
    assert.deepStrictEqual(seen, ['from-helper']);
  } finally {
    await system.stop();
  }
});

test('addresses: paths are unique, bare ids work only when unambiguous', async () => {
  const system = createSystem({ logger: false });
  try {
    const top = await system.spawn(async (msg, ctx) => {
      if (msg.spawn) {
        const child = await ctx.spawn({ async onMessage() { return 'child'; } }, { id: 'shared' });
        return child.path;
      }
      return 'top';
    }, { id: 'p1' });
    await system.spawn(async (msg, ctx) => {
      if (msg.spawn) {
        const child = await ctx.spawn({ async onMessage() { return 'child'; } }, { id: 'shared' });
        return child.path;
      }
      return 'top';
    }, { id: 'p2' });

    assert.strictEqual(await top.ask({ spawn: true }), 'p1/shared');
    assert.strictEqual(await system.ref('p2').ask({ spawn: true }), 'p2/shared');

    // Exact paths always resolve.
    assert.strictEqual(system.resolve('p1/shared').path, 'p1/shared');
    assert.strictEqual(system.resolve('p2/shared').path, 'p2/shared');
    // A top-level id is its own path.
    assert.strictEqual(system.resolve('p1').path, 'p1');
    // A duplicated child id must not be guessed.
    assert.strictEqual(system.resolve('shared'), null, 'an ambiguous id must not resolve');
    await assert.rejects(async () => {
      const resolved = system.resolve('shared');
      if (!resolved) throw new Error('ambiguous');
    }, /ambiguous/);
  } finally {
    await system.stop();
  }
});

test('a handler bag with stray keys warns instead of silently dropping methods', async () => {
  const logs = [];
  const system = createSystem({ logger: (event, meta) => logs.push({ event, meta }) });
  try {
    const ref = await system.spawn({ onMessage: () => 'ok', _helper: () => 'never forwarded' }, { id: 'bag' });
    const warning = logs.find((entry) => entry.event === 'actor_definition_unknown_keys');
    assert.ok(warning, 'the stray key must be reported');
    assert.deepStrictEqual(warning.meta.keys, ['_helper']);
    assert.match(warning.meta.hint, /only receive\/onMessage/);
    assert.strictEqual(await ref.ask('x'), 'ok', 'the actor still works');
  } finally {
    await system.stop();
  }
});

test('stop() is bounded even when an actor is stuck in a handler that never resolves', async () => {
  const logs = [];
  const system = createSystem({
    logger: (event, meta) => logs.push({ event, meta }),
    shutdownTimeoutMs: 300,
  });
  await system.spawn(() => new Promise(() => {}), { id: 'stuck' });
  // `tell` (not `ask`): ask timeouts are unref'd on purpose, so in a bare
  // process they may not fire before the loop empties.
  system.ref('stuck').tell('x');
  await new Promise((resolve) => setImmediate(resolve)); // let the stuck turn start

  const startedAt = Date.now();
  await system.stop();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 2000, `system.stop() must be bounded, took ${elapsed}ms`);
  assert.strictEqual(system.stopped, true);
  const warning = logs.find((entry) => entry.event === 'system_stop_timeout');
  assert.ok(warning, 'the stuck actor is reported instead of hanging silently');
  assert.ok(warning.meta.busyActors.includes('stuck'));
});
