import { test, before, after } from 'node:test';
import assert from 'node:assert';
import _helpers from '../packages/core/test/helpers.js';
const { setupTempEnv, cleanup, waitFor } = _helpers;
import _actor_main from '../actor-main.js';
const { bootstrap, describe } = _actor_main;
import { AskTimeoutError, ActorStoppedError } from 'nodejs-actor-framework';

/**
 * Node-level integration: the demo node is now *composition* (system + plugins),
 * so these tests check the wiring, not the actor semantics (those live in
 * test/unit-actor-*.test.js).
 */





const tempDir = setupTempEnv('actor-node');




const WORKER_PLAYER = './packages/core/test/fixtures/actors/worker-player.js';

let ctx;

before(async () => {
  ctx = await bootstrap({
    nodeId: 'node-under-test',
    telnet: { enabled: false },
    gateway: { enabled: true, host: '127.0.0.1', port: 0 },
    gossip: { enabled: false },
    metrics: { exporter: { enabled: true, host: '127.0.0.1', port: 0 } },
    bootActors: ['player_001'],
  });
});

after(async () => {
  await ctx.close();
  cleanup(tempDir);
});

test('bootstrap brings up a node on the framework model', async () => {
  assert.ok(ctx.system, 'the node exposes an ActorSystem');
  assert.deepStrictEqual(ctx.system.listActors(), ['player_001']);
  assert.deepStrictEqual(ctx.booted, ['player_001']);

  // Plugins are installed; cluster is absent because gossip is disabled.
  const installed = [...ctx.system.installed.keys()];
  assert.ok(installed.includes('pubsub'));
  assert.ok(installed.includes('tracing'));
  assert.ok(installed.includes('deadLetters'));
  assert.ok(installed.includes('rateLimit'));
  assert.ok(installed.includes('metrics'));
  assert.strictEqual(ctx.system.cluster, null, 'gossip disabled means no cluster plugin');

  assert.ok(ctx.ports.gateway > 0, 'the gateway is serving actors');
  assert.ok(ctx.ports.metrics > 0, 'the metrics endpoint is up');
  assert.strictEqual(ctx.ports.console, null, 'the console is disabled here');
  assert.strictEqual(ctx.storeBackend, 'file');
  assert.match(describe(ctx), /node-under-test/);
});

test('messages reach actors and replies come back', async () => {
  const ref = ctx.system.ref('player_001');
  assert.strictEqual(await ref.ask({ type: 'hurt', damage: 10 }), 90);
  assert.strictEqual(await ref.ask({ type: 'hurt', damage: 5 }), 85);
  assert.strictEqual(ctx.system.inspect('player_001').state.hp, 85);
});

test('an unexpected crash is restarted by the supervisor', async () => {
  const ref = ctx.system.ref('player_001');
  await ref.ask({ type: 'hurt', damage: 20 });
  const before = ctx.system.inspect('player_001');
  assert.ok(before.state.hurtTotal >= 20, 'damage accumulated before the crash');

  await assert.rejects(() => ref.ask({ type: 'debug:crash' }), /crash requested via console/);
  await waitFor(() => ctx.system.inspect('player_001').restarts === before.restarts + 1, {
    message: 'the supervised restart',
  });

  assert.strictEqual(await ref.ask({ type: 'hurt', damage: 1 }), 99, 'the new incarnation is usable');
  assert.strictEqual(ctx.system.inspect('player_001').state.hurtTotal, 1, 'and started fresh');
});

test('kill is intentional: no restart, and it is deregistered', async () => {
  const ref = ctx.system.ref('player_001');
  await ref.stop();
  await waitFor(() => ctx.system.resolve('player_001') === null, { message: 'the actor to be deregistered' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(ctx.system.listActors().includes('player_001'), false);
  assert.strictEqual(ctx.system.resolve('player_001'), null);
});

test('sending to a stopped actor fails clearly instead of hanging', async () => {
  const orphan = ctx.system.cells.get('player_001');
  assert.strictEqual(orphan, undefined, 'the cell is gone, so resolve() cannot hand out a stale ref');

  const other = await ctx.system.spawn(async () => 'ok', { id: 'ephemeral' });
  await other.stop();
  await assert.rejects(() => other.ask('x', 200), (err) => err instanceof ActorStoppedError);
});

test('control calls time out instead of hanging forever', async () => {
  await ctx.system.spawn(() => new Promise(() => {}), { id: 'never-answers' });
  await assert.rejects(
    () => ctx.system.ref('never-answers').ask('x', 120),
    (err) => err instanceof AskTimeoutError,
  );
  await ctx.system.ref('never-answers').stop();
});

test('metrics collected from actors are visible to the main process', async () => {
  const ref = await ctx.system.spawn(async () => 'ok', { id: 'measured' });
  await ref.ask('a');
  await ref.ask('b');
  await waitFor(() => {
    ctx.system.collectMetrics();
    return (ctx.metrics.get('measured') || {}).handled === 2;
  }, { message: 'counters to be collected' });
  assert.strictEqual(ctx.metrics.get('measured').received, 2);
});

test('worker isolation is per actor and an isolated crash does not take the node down', async () => {
  const isolated = await ctx.system.spawn(WORKER_PLAYER, { id: 'isolated', isolation: 'worker' });
  assert.strictEqual(ctx.system.inspect('isolated').isolation, 'worker');

  await isolated.ask({ type: 'hurt', damage: 5 });
  await assert.rejects(() => isolated.ask({ type: 'boom' }), /worker boom/);
  await waitFor(() => ctx.system.inspect('isolated').restarts === 1, { message: 'the isolated restart' });

  // The process is still alive and the inline node keeps serving.
  assert.strictEqual(await isolated.ask({ type: 'hurt', damage: 0 }), 100);
  assert.strictEqual(await ctx.system.ref('measured').ask('c'), 'ok');
  await isolated.stop();
});

test('dead letters are readable through the node', async () => {
  const flaky = await ctx.system.spawn(async () => {
    throw new Error('node-level failure');
  }, { id: 'flaky-node', failure: 'retry', maxRetry: 0 });

  await assert.rejects(() => flaky.ask('doomed'), /node-level failure/);
  await waitFor(async () => (await ctx.system.readDeadLetters()).some((e) => e.actorId === 'flaky-node'), {
    message: 'the dead letter to be recorded',
  });

  const letters = await ctx.system.readDeadLetters();
  const entry = letters.find((e) => e.actorId === 'flaky-node');
  assert.match(entry.reason, /node-level failure/);
  await ctx.system.clearDeadLetters();
  assert.deepStrictEqual(await ctx.system.readDeadLetters(), []);
});

test('hot reload is refused with an explanation instead of being silently ignored', async () => {
  const legacy = await bootstrap({
    nodeId: 'hotreload-node',
    telnet: { enabled: false },
    gateway: { enabled: false },
    gossip: { enabled: false },
    metrics: { exporter: { enabled: false } },
    hotReload: { enabled: true },
    bootActors: [],
  });
  try {
    assert.ok(
      legacy.warnings.some((w) => /no runtime code eval/.test(w)),
      `expected a warning about hot reload, got: ${JSON.stringify(legacy.warnings)}`,
    );
    assert.deepStrictEqual(legacy.system.listActors(), []);
  } finally {
    await legacy.close();
  }
});

test('graceful shutdown stops actors, closes the gateway and is idempotent', async () => {
  const node = await bootstrap({
    nodeId: 'shutdown-node',
    telnet: { enabled: false },
    gateway: { enabled: true, host: '127.0.0.1', port: 0 },
    gossip: { enabled: false },
    metrics: { exporter: { enabled: false } },
    bootActors: ['victim'],
  });
  assert.ok(node.ports.gateway > 0);

  await node.close();
  assert.strictEqual(node.system.stopped, true);
  assert.deepStrictEqual(node.system.listActors(), []);
  assert.strictEqual(node.system.server, null, 'the gateway socket is closed');
  await node.close(); // must not throw
});

test('a disabled gateway still runs the node', async () => {
  const node = await bootstrap({
    nodeId: 'no-gateway',
    telnet: { enabled: false },
    gateway: { enabled: false },
    gossip: { enabled: false },
    metrics: { exporter: { enabled: false } },
    bootActors: ['solo'],
  });
  try {
    assert.strictEqual(node.ports.gateway, null);
    assert.strictEqual(node.system.server, null);
    assert.deepStrictEqual(node.system.listActors(), ['solo']);
    assert.strictEqual(await node.system.ref('solo').ask({ type: 'hurt', damage: 3 }), 97);
  } finally {
    await node.close();
  }
});
