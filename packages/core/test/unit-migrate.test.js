'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { setupTempEnv, cleanup } = require('./helpers');

const tempDir = setupTempEnv('actor-migrate');

const { FileStore } = require('../src/store/backends/file-store');
const { LevelStore, isAvailable } = require('../src/store/backends/level-store');
const { migrate, parseArgs } = require('../../../tools/migrate-store');

const level = isAvailable();
const skipWithoutLevel = level.available ? false : 'classic-level unavailable';

test.after(() => cleanup(tempDir));

let seq = 0;
const uniqueDir = (prefix) => path.join(tempDir, `${prefix}-${++seq}`);
const TOOL = path.join(__dirname, '..', '..', '..', 'tools', 'migrate-store.js');

/** Create a file-backend data dir with the given seed data. */
async function seedDataDir(dataDir, seed) {
  const store = new FileStore({ baseDir: path.join(dataDir, 'msg_store') });
  try {
    for (const [actorId, messages] of Object.entries(seed)) {
      for (const message of messages) await store.append(actorId, message);
    }
  } finally {
    await store.close();
  }
  return store;
}

test('migrate: parseArgs handles the documented flags', () => {
  const options = parseArgs(['--data', '/tmp/d', '--actor', 'a1', '--actor', 'a2', '--purge', '--dry-run', '--json']);
  assert.strictEqual(options.dataDir, '/tmp/d');
  assert.deepStrictEqual(options.actors, ['a1', 'a2']);
  assert.strictEqual(options.purge, true);
  assert.strictEqual(options.dryRun, true);
  assert.strictEqual(options.json, true);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('migrate: a dry run writes nothing', { skip: skipWithoutLevel }, async () => {
  const dataDir = uniqueDir('dry');
  await seedDataDir(dataDir, { a1: [{ type: 'x', n: 1 }, { type: 'x', n: 2 }] });

  const summary = await migrate({ dataDir, dryRun: true });
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.totals.messages, 2);
  assert.strictEqual(summary.totals.migrated, 0);
  assert.strictEqual(fs.existsSync(path.join(dataDir, 'level')), false, 'no level data was created');

  // The source is untouched and still readable.
  const source = new FileStore({ baseDir: path.join(dataDir, 'msg_store') });
  assert.strictEqual((await source.load('a1')).length, 2);
  await source.close();
});

test('migrate: every message arrives in order and is verified', { skip: skipWithoutLevel }, async () => {
  const dataDir = uniqueDir('full');
  await seedDataDir(dataDir, {
    alpha: [{ type: 'x', n: 1 }, { type: 'x', n: 2 }, { type: 'x', n: 3 }],
    beta: [{ type: 'y', n: 9 }],
  });

  const summary = await migrate({ dataDir });
  assert.strictEqual(summary.totals.messages, 4);
  assert.strictEqual(summary.totals.migrated, 4);
  assert.ok(summary.actors.every((a) => a.verified), 'each actor was verified');

  const target = new LevelStore({ root: path.join(dataDir, 'level') });
  try {
    assert.deepStrictEqual((await target.load('alpha')).map((m) => m.n), [1, 2, 3], 'order is preserved');
    assert.deepStrictEqual((await target.load('beta')).map((m) => m.n), [9]);
  } finally {
    await target.close();
  }

  // Without --purge the source stays where it was.
  assert.ok(fs.existsSync(path.join(dataDir, 'msg_store')), 'source files remain');
  assert.ok(fs.readdirSync(path.join(dataDir, 'msg_store')).some((f) => f.endsWith('.log')));
});

test('migrate: re-running is idempotent (no duplicate messages)', { skip: skipWithoutLevel }, async () => {
  const dataDir = uniqueDir('rerun');
  await seedDataDir(dataDir, { a1: [{ type: 'x', n: 1 }, { type: 'x', n: 2 }] });

  await migrate({ dataDir });
  const second = await migrate({ dataDir });
  assert.strictEqual(second.totals.migrated, 0, 'nothing new was written');
  assert.strictEqual(second.totals.skipped, 2, 'both messages were recognised as already present');

  const target = new LevelStore({ root: path.join(dataDir, 'level') });
  try {
    assert.strictEqual((await target.load('a1')).length, 2, 'still exactly two messages');
  } finally {
    await target.close();
  }
});

test('migrate: --purge renames the source instead of deleting it', { skip: skipWithoutLevel }, async () => {
  const dataDir = uniqueDir('purge');
  await seedDataDir(dataDir, { a1: [{ type: 'x', n: 1 }] });

  const summary = await migrate({ dataDir, purge: true });
  assert.strictEqual(summary.totals.purged, 1);

  const files = fs.readdirSync(path.join(dataDir, 'msg_store'));
  assert.ok(files.some((f) => f.endsWith('.log.migrated')), `expected a renamed source, saw ${files.join(', ')}`);
  assert.ok(!files.some((f) => f.endsWith('.log')), 'the live source log is gone');

  const target = new LevelStore({ root: path.join(dataDir, 'level') });
  try {
    assert.strictEqual((await target.load('a1')).length, 1);
  } finally {
    await target.close();
  }
});

test('migrate: only the requested actors are moved', { skip: skipWithoutLevel }, async () => {
  const dataDir = uniqueDir('select');
  await seedDataDir(dataDir, { keep: [{ type: 'x', n: 1 }], move: [{ type: 'x', n: 2 }] });

  const summary = await migrate({ dataDir, actors: ['move'] });
  assert.strictEqual(summary.actors.length, 1);
  assert.strictEqual(summary.actors[0].actorId, 'move');

  const target = new LevelStore({ root: path.join(dataDir, 'level') });
  try {
    assert.strictEqual((await target.load('move')).length, 1);
    assert.strictEqual((await target.load('keep')).length, 0, 'the other actor was not copied');
  } finally {
    await target.close();
  }
});

test('migrate: a missing data directory fails with a clear message', async () => {
  await assert.rejects(() => migrate({ dataDir: path.join(tempDir, 'nope') }), /no file-backend data/);
});

test('migrate: CLI reports a summary and exits 0', { skip: skipWithoutLevel }, async () => {
  const dataDir = uniqueDir('cli');
  await seedDataDir(dataDir, { a1: [{ type: 'x', n: 1 }, { type: 'x', n: 2 }] });

  const out = execFileSync(process.execPath, [TOOL, '--data', dataDir, '--json'], { encoding: 'utf8' });
  const summary = JSON.parse(out);
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.totals.migrated, 2);

  const dryRun = execFileSync(process.execPath, [TOOL, '--data', dataDir, '--dry-run'], { encoding: 'utf8' });
  assert.match(dryRun, /\[dry-run\]/);
  assert.match(dryRun, /2 message\(s\)/);
});

test('migrate: CLI --help exits 0 and unknown flags exit 1', async () => {
  const help = execFileSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage: node tools\/migrate-store\.js/);

  let code = 0;
  try {
    execFileSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    code = err.status;
  }
  assert.strictEqual(code, 1, 'an unknown flag must fail');
});

test('manifest: actor ids are recoverable for tooling', async () => {
  const baseDir = uniqueDir('manifest');
  const store = new FileStore({ baseDir });
  try {
    await store.append('player_001', { type: 'x' });
    await store.append('player_002', { type: 'x' });
    const actors = await store.listActors();
    assert.deepStrictEqual(actors.map((a) => a.actorId), ['player_001', 'player_002']);
    assert.ok(actors.every((a) => a.file.endsWith('.log')));
  } finally {
    await store.close();
  }

  // A fresh store reads the same manifest back from disk.
  const reopened = new FileStore({ baseDir });
  try {
    assert.strictEqual((await reopened.listActors()).length, 2);
  } finally {
    await reopened.close();
  }
});

test('manifest: a corrupt manifest degrades to empty instead of failing', async () => {
  const baseDir = uniqueDir('manifest-corrupt');
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'manifest.json'), '{not json');
  const store = new FileStore({ baseDir });
  try {
    assert.deepStrictEqual(await store.listActors(), []);
    await store.append('a1', { type: 'x' });
    assert.deepStrictEqual((await store.listActors()).map((a) => a.actorId), ['a1']);
  } finally {
    await store.close();
  }
});
