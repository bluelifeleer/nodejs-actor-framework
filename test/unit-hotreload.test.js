'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupTempEnv, cleanup } = require('./helpers');

const tempDir = setupTempEnv('actor-hot');

const { compileHandler, loadHandlerFromModule } = require('../actor-worker');
const HotReloadManager = require('../hot-reload-manager');
const config = require('../config');

test.after(() => cleanup(tempDir));

test('hot reload: the documented arrow form gets `this` bound to the actor', async () => {
  // This is the regression: `fn.call(actor, msg)` cannot rebind an arrow
  // function, so the factory itself must be invoked with the actor as `this`.
  const actor = { state: { hp: 100 } };
  const fn = compileHandler('async (msg) => { this.state.hp -= msg.damage; return this.state.hp; }', actor);
  assert.strictEqual(typeof fn, 'function');
  assert.strictEqual(await fn({ damage: 10 }), 90);
  assert.strictEqual(actor.state.hp, 90);
});

test('hot reload: a plain function form also works', async () => {
  const actor = { state: { hp: 55 } };
  const fn = compileHandler('async function (msg) { return this.state.hp + msg.bonus; }', actor);
  assert.strictEqual(await fn.call(actor, { bonus: 5 }), 60);
});

test('hot reload: a bare statement body is accepted', async () => {
  const actor = { state: {} };
  const fn = compileHandler('this.state.hp = 7; return this.state.hp;', actor);
  assert.strictEqual(await fn.call(actor, {}), 7);
});

test('hot reload: a non-function expression is rejected instead of bricking the actor', () => {
  assert.throws(() => compileHandler('42', {}), /hot reload failed/);
  assert.throws(() => compileHandler('"async (msg)=>{ return 42; }"', {}), /hot reload failed/);
  assert.throws(() => compileHandler('async (msg) => {', {}), /hot reload failed/);
});

test('hot reload: modules are loaded from inside the project root only', () => {
  const dir = path.join(tempDir, 'handlers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'handlers.js'),
    'module.exports = { greet: function (msg) { return "hi:" + msg.n; }, default: function () { return "def"; } };\n',
  );

  const savedRoot = config.root;
  config.root = dir;
  try {
    const greet = loadHandlerFromModule({}, './handlers.js', 'greet');
    assert.strictEqual(greet({ n: 1 }), 'hi:1');
    const def = loadHandlerFromModule({}, path.join(dir, 'handlers.js'));
    assert.strictEqual(def(), 'def');
    assert.throws(() => loadHandlerFromModule({}, '../../etc/passwd'), /must live inside/);
    assert.throws(() => loadHandlerFromModule({}, '/etc/passwd'), /must live inside/);
    assert.throws(() => loadHandlerFromModule({}, './handlers.js', 'nope'), /not a function/);
  } finally {
    config.root = savedRoot;
  }
});

test('hot reload: disabled by default in the manager', async () => {
  const manager = new HotReloadManager({ control: async () => 'nope' }, { enabled: false });
  assert.strictEqual(manager.isEnabled, false);
  await assert.rejects(() => manager.hotUpdate('a1', 'async () => 1'), /disabled/);
  assert.ok(!manager.info().enabled);
});

test('hot reload: enabled manager validates size and returns the worker result', async () => {
  const calls = [];
  const control = async (actorId, message) => {
    calls.push({ actorId, message });
    return { installed: true };
  };

  const strict = new HotReloadManager({ control, requestTimeoutMs: 100 }, { enabled: true, maxCodeBytes: 8 });
  await assert.rejects(() => strict.hotUpdate('a1', 'x'.repeat(20)), /exceeds 8 bytes/);
  await assert.rejects(() => strict.hotUpdate('a1', '   '), TypeError);

  const manager = new HotReloadManager({ control, requestTimeoutMs: 100 }, { enabled: true, maxCodeBytes: 4096 });
  const res = await manager.hotUpdate('a1', 'async () => 1');
  assert.deepStrictEqual(res, { installed: true });
  assert.strictEqual(calls[0].message.type, 'hot_reload');
  assert.strictEqual(calls[0].actorId, 'a1');
});

test('hot reload: module path helper is reachable from the manager', async () => {
  const calls = [];
  const manager = new HotReloadManager(
    { control: async (actorId, message) => { calls.push(message); return { installed: true }; }, requestTimeoutMs: 100 },
    { enabled: true },
  );
  await manager.loadFromModule('a1', './handlers.js', 'greet');
  assert.deepStrictEqual(calls[0], { type: 'hot_reload_module', modulePath: './handlers.js', exportName: 'greet' });
  const bare = new HotReloadManager({ control: async () => ({}) }, { enabled: true });
  await assert.rejects(() => bare.loadFromModule('a1'), /no module path configured/);
});
