'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, delay } = require('./helpers');

const tempDir = setupTempEnv('actor-sup');

const Supervisor = require('../supervisor');
const { RestartStrategy } = require('../supervisor');

test.after(() => cleanup(tempDir));

function harness(options = {}) {
  const log = [];
  const sup = new Supervisor('test-sup', {
    maxRestarts: 99,
    withinSeconds: 60,
    autoRecover: false,
    ...options,
  });
  sup.start();
  const spawn = (id) =>
    sup.spawnChild(
      () => {
        log.push(id);
        return { id, terminate() {} };
      },
      id,
    );
  return { sup, log, spawn };
}

test('supervisor: exports both the class and the strategies', () => {
  assert.strictEqual(typeof Supervisor, 'function');
  assert.strictEqual(RestartStrategy.ONE_FOR_ONE, 'one_for_one');
  assert.strictEqual(RestartStrategy.REST_FOR_ONE, 'rest_for_one');
  assert.strictEqual(RestartStrategy.ONE_FOR_ALL, 'one_for_all');
});

test('supervisor: accepts (id, opts) and a single options object', () => {
  const a = new Supervisor('a', { strategy: 'one_for_all', maxRestarts: 7 });
  assert.strictEqual(a.id, 'a');
  assert.strictEqual(a.strategy, 'one_for_all');
  assert.strictEqual(a.maxRestarts, 7);
  const b = new Supervisor({ id: 'b', strategy: 'nonsense' });
  assert.strictEqual(b.id, 'b');
  assert.strictEqual(b.strategy, 'one_for_one', 'unknown strategies fall back safely');
});

test('supervisor: spawnChild validates its arguments', () => {
  const sup = new Supervisor('v');
  assert.throws(() => sup.spawnChild(() => ({}), 'x'), /not running/);
  sup.start();
  assert.throws(() => sup.spawnChild('not a function', 'x'), TypeError);
  assert.throws(() => sup.spawnChild(() => ({}), ''), TypeError);
  sup.spawnChild(() => ({}), 'x');
  assert.throws(() => sup.spawnChild(() => ({}), 'x'), /already supervised/);
});

test('supervisor: one_for_one restarts only the crashed child', () => {
  const { sup, log, spawn } = harness({ strategy: RestartStrategy.ONE_FOR_ONE });
  ['a', 'b', 'c'].forEach(spawn);
  assert.deepStrictEqual(log, ['a', 'b', 'c']);
  const result = sup.handleChildCrash('b');
  assert.deepStrictEqual(result.restartedChildren, ['b']);
  assert.deepStrictEqual(log, ['a', 'b', 'c', 'b']);
});

test('supervisor: rest_for_one restarts the crashed child and everything after it', () => {
  const { sup, log, spawn } = harness({ strategy: RestartStrategy.REST_FOR_ONE });
  ['a', 'b', 'c'].forEach(spawn);
  const result = sup.handleChildCrash('b');
  assert.deepStrictEqual(result.restartedChildren, ['b', 'c']);
  assert.deepStrictEqual(log, ['a', 'b', 'c', 'b', 'c']);
});

test('supervisor: one_for_all restarts the whole group', () => {
  const { sup, log, spawn } = harness({ strategy: RestartStrategy.ONE_FOR_ALL });
  ['a', 'b', 'c'].forEach(spawn);
  const result = sup.handleChildCrash('c');
  assert.deepStrictEqual(result.restartedChildren, ['a', 'b', 'c']);
  assert.deepStrictEqual(log, ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('supervisor: an intentionally killed child is never restarted', () => {
  const { sup, log, spawn } = harness();
  spawn('a');
  assert.strictEqual(sup.killChild('a'), true);
  assert.strictEqual(sup.killChild('missing'), false);
  const result = sup.handleChildCrash('a');
  assert.deepStrictEqual(result, { restarted: false, reason: 'stopped' });
  assert.deepStrictEqual(log, ['a'], 'no restart happened');
});

test('supervisor: unknown children are ignored', () => {
  const { sup } = harness();
  assert.deepStrictEqual(sup.handleChildCrash('ghost'), { restarted: false, reason: 'unknown_child' });
});

test('supervisor: restart intensity opens the circuit breaker and stops children', () => {
  const events = [];
  const { sup, log, spawn } = harness({ maxRestarts: 2, withinSeconds: 60 });
  sup.on('supervisor_circuit_open', () => events.push('open'));
  ['a', 'b'].forEach(spawn);
  sup.handleChildCrash('a');
  sup.handleChildCrash('a');
  assert.strictEqual(sup.circuitOpen, false, 'still below the limit');
  const result = sup.handleChildCrash('a');
  assert.deepStrictEqual(result, { restarted: false, reason: 'restart_intensity_exceeded' });
  assert.strictEqual(sup.circuitOpen, true);
  assert.strictEqual(sup.running, false);
  assert.deepStrictEqual(events, ['open']);
  for (const child of sup.children.values()) assert.strictEqual(child.stopped, true, `${child.id} stopped`);
  assert.deepStrictEqual(log, ['a', 'b', 'a', 'a'], 'the third crash did not restart anything');
});

test('supervisor: the circuit breaker recovers after its cooldown', async () => {
  const events = [];
  const { sup, log } = harness({ maxRestarts: 1, withinSeconds: 60, autoRecover: true, cooldownMs: 40 });
  sup.on('supervisor_circuit_open', () => events.push('open'));
  sup.on('supervisor_circuit_close', () => events.push('close'));
  sup.spawnChild(() => {
    log.push('a');
    return { terminate() {} };
  }, 'a');
  sup.handleChildCrash('a');
  sup.handleChildCrash('a');
  assert.strictEqual(sup.circuitOpen, true);
  await delay(120);
  assert.deepStrictEqual(events, ['open', 'close']);
  assert.strictEqual(sup.circuitOpen, false);
  assert.strictEqual(sup.running, true);
  assert.ok(log.length >= 3, 'the child was restarted after recovery');
});

test('supervisor: removeChild stops and forgets a child', () => {
  const { sup, spawn } = harness();
  spawn('a');
  assert.strictEqual(sup.removeChild('a'), true);
  assert.strictEqual(sup.hasChild('a'), false);
  assert.strictEqual(sup.removeChild('a'), false);
});

test('supervisor: info() reports the real state', () => {
  const { sup, spawn } = harness({ strategy: RestartStrategy.REST_FOR_ONE });
  spawn('a');
  sup.handleChildCrash('a');
  const info = sup.info();
  assert.strictEqual(info.strategy, 'rest_for_one');
  assert.strictEqual(info.running, true);
  assert.strictEqual(info.children[0].restarts, 1);
  assert.strictEqual(info.restartsInWindow, 1);
});

test('supervisor: stop() halts restarts', () => {
  const { sup, spawn } = harness();
  spawn('a');
  sup.stop();
  assert.strictEqual(sup.running, false);
  const result = sup.handleChildCrash('a');
  assert.strictEqual(result.restarted, false);
  assert.ok(['not_running', 'stopped'].includes(result.reason));
});
