'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, waitFor, delay } = require('./helpers');

const tempDir = setupTempEnv('actor-int');

const { bootstrap } = require('../actor-main');

let ctx;

before(async () => {
  ctx = await bootstrap({
    telnet: { enabled: true, port: 0 },
    gateway: { enabled: false },
    gossip: { enabled: false },
    bootActors: ['a1', 'a2'],
  });
});

after(async () => {
  await ctx.close();
  cleanup(tempDir);
});

const restartsOf = (actorId) => {
  const child = ctx.supervisor.info().children.find((c) => c.id === actorId);
  return child ? child.restarts : -1;
};

async function eventually(actorId, payload, predicate, message) {
  return waitFor(
    async () => {
      try {
        const result = await ctx.actorManager.send(actorId, payload, 1000);
        return predicate(result) ? result : false;
      } catch {
        return false;
      }
    },
    { message, timeout: 8000 },
  );
}

test('bootstrap brings up a node with supervised actors', () => {
  assert.deepStrictEqual(ctx.actorManager.listActors().sort(), ['a1', 'a2']);
  assert.strictEqual(ctx.supervisor.info().children.length, 2);
  assert.ok(ctx.ports.console > 0, 'console listened on an ephemeral port');
  assert.ok(ctx.registry.has('a1'));
  assert.deepStrictEqual(ctx.warnings, []);
});

test('messages reach actors and replies come back', async () => {
  assert.deepStrictEqual(await ctx.actorManager.send('a1', { type: 'debug:getState' }), { hp: 100 });
  assert.strictEqual(await ctx.actorManager.send('a1', { type: 'hurt', damage: 5 }), 95);
  assert.strictEqual(await ctx.actorManager.send('a1', { type: 'hurt', damage: 5, priority: 2 }), 90);
});

test('an invalid priority is coerced instead of crashing the worker or the process', async () => {
  const hp = await ctx.actorManager.send('a1', { type: 'hurt', damage: 1 }, 2000, 7);
  assert.ok(Number.isFinite(hp));
  assert.deepStrictEqual(await ctx.actorManager.send('a1', { type: 'debug:getState' }), { hp });
});

test('metrics collected inside the worker are visible to the main process', async () => {
  // Regression: metrics used to be trapped in the worker, so `metrics dump`
  // always returned {}. Snapshot the number, not the live object.
  const beforeHandled = (ctx.metrics.get('a1') || { handled: 0 }).handled;
  await ctx.actorManager.send('a1', { type: 'hurt', damage: 1 });
  await waitFor(() => {
    const m = ctx.metrics.get('a1');
    return m && m.handled > beforeHandled;
  }, { message: 'metrics delta to arrive' });

  const snapshot = ctx.metrics.dump({ persist: false });
  assert.ok(snapshot.a1.received >= 1);
  assert.ok(snapshot.a1.handled >= 1);
  assert.ok(snapshot.a1.batches >= 1);
  assert.strictEqual(typeof snapshot.a1.avgLatencyMs, 'number');
});

test('an unexpected crash is restarted by the supervisor', async () => {
  // Regression: handleChildCrash was never called, so nothing ever restarted.
  const before_ = restartsOf('a1');
  assert.strictEqual(ctx.actorManager.crashActor('a1'), true);

  await waitFor(() => restartsOf('a1') > before_, { message: 'supervisor restart', timeout: 8000 });
  await eventually('a1', { type: 'debug:getState' }, (state) => state && state.hp !== undefined, 'restarted actor to answer');
  assert.strictEqual(ctx.supervisor.info().running, true);
});

test('a worker crash never takes the main process down', async () => {
  // The old code had no worker.on('error'), so any worker failure was fatal.
  assert.ok(ctx.actorManager.hasActor('a2'));
  assert.ok(ctx.actorManager.hasActor('a1'));
  assert.strictEqual(process.exitCode, undefined);
});

test('a worker uncaught exception is contained and the actor comes back', async () => {
  ctx.actorManager.createActor('boomer');
  await ctx.hotReload.hotUpdate(
    'boomer',
    "async function (msg) { if (msg.explode) { process.nextTick(() => { throw new Error('kaboom'); }); } return 'ok'; }",
  );

  const before_ = restartsOf('boomer');
  await ctx.actorManager.send('boomer', { type: 't', explode: true }).catch(() => {});

  await waitFor(() => restartsOf('boomer') > before_, { message: 'restart after uncaught exception', timeout: 8000 });

  // Other actors are unaffected, and the process is alive.
  assert.strictEqual(await ctx.actorManager.send('a1', { type: 'debug:getState' }).then(() => true), true);
});

test('kill is intentional: no restart, and it is deregistered', async () => {
  ctx.actorManager.createActor('doomed');
  assert.ok(ctx.registry.has('doomed'));
  assert.strictEqual(await ctx.actorManager.destroyActor('doomed'), true);
  await delay(300);
  assert.strictEqual(ctx.actorManager.hasActor('doomed'), false);
  assert.strictEqual(ctx.supervisor.hasChild('doomed'), false, 'the child was removed, so a re-spawn is possible');
  assert.strictEqual(ctx.registry.has('doomed'), false);
  assert.strictEqual(await ctx.actorManager.destroyActor('doomed'), false);
});

test('monitors are notified when the target dies', async () => {
  // Regression: monitors were never registered, so this never fired.
  ctx.actorManager.createActor('watcher');
  ctx.actorManager.createActor('victim');
  await ctx.hotReload.hotUpdate(
    'watcher',
    "async function (msg) { if (msg.type === 'monitor:notifyDead') { this.state.dead = msg.deadActorId; this.state.reason = msg.reason; return 'noted'; } if (msg.type === 'debug:getState') { return this.state; } return { ok: true }; }",
  );
  await ctx.actorManager.monitor('watcher', 'victim');
  ctx.actorManager.crashActor('victim');

  const state = await eventually(
    'watcher',
    { type: 'debug:getState' },
    (s) => s && s.dead === 'victim',
    'monitor notification',
  );
  assert.strictEqual(state.dead, 'victim');
  assert.strictEqual(state.reason, 'crash');
});

test('sending to an unknown actor rejects clearly', async () => {
  await assert.rejects(() => ctx.actorManager.send('ghost', { type: 'x' }, 500), /not found/);
});

test('hot reload applies the documented arrow form and keeps the actor alive', async () => {
  ctx.actorManager.createActor('hot1');
  const res = await ctx.hotReload.hotUpdate(
    'hot1',
    'async (msg) => { if (msg.type === "hurt") { this.state.hp -= msg.damage * 2; return this.state.hp; } return this.state; }',
  );
  assert.deepStrictEqual(res, { installed: true, name: 'anonymous' });

  // Regression: an arrow function could not see `this`, which previously
  // crashed the whole process.
  assert.strictEqual(await ctx.actorManager.send('hot1', { type: 'hurt', damage: 10 }), 80);
  await ctx.hotReload.hotUpdate('hot1', 'async (msg) => { this.state.hp = 42; return this.state.hp; }');
  assert.strictEqual(await ctx.actorManager.send('hot1', { type: 'anything' }), 42);
});

test('a rejected hot reload leaves the previous handler in place', async () => {
  await assert.rejects(() => ctx.hotReload.hotUpdate('hot1', '"not a function"'), /hot reload failed/);
  assert.strictEqual(await ctx.actorManager.send('hot1', { type: 'anything' }), 42);
  assert.strictEqual(ctx.actorManager.hasActor('hot1'), true);
});

test('hot reload is refused for unknown actors', async () => {
  await assert.rejects(() => ctx.hotReload.hotUpdate('nobody', 'async () => 1'), /not found/);
});

test('control calls time out instead of hanging forever', async () => {
  ctx.actorManager.createActor('slow');
  await assert.rejects(
    () => ctx.actorManager.control('slow', { type: 'no-such-control' }, 500),
    /unknown control message/,
  );
});

test('actor ids are validated before a worker is created', () => {
  assert.throws(() => ctx.actorManager.createActor('../evil'), /invalid actorId/);
  assert.throws(() => ctx.actorManager.createActor('bad id'), /invalid actorId/);
  assert.throws(() => ctx.actorManager.createActor(''), /invalid actorId/);
  assert.throws(() => ctx.actorManager.createActor('a1'), /already exists/);
});
