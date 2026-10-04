'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupTempEnv, cleanup } = require('./helpers');

const tempDir = setupTempEnv('actor-stores');

const { FileStore } = require('../src/store/backends/file-store');
const { MemoryStore } = require('../src/store/backends/memory-store');
const { LevelStore, isAvailable: levelAvailable } = require('../src/store/backends/level-store');
const { createStore, validateStoreConfig, BACKENDS } = require('../src/store/backends');
const { MessageStore } = require('../src/store/message-store');
const { fileName } = require('../src/store/backends/naming');

test.after(() => cleanup(tempDir));

let dirSeq = 0;
const uniqueDir = (prefix) => path.join(tempDir, `${prefix}-${++dirSeq}`);

/**
 * Every backend must satisfy the same contract, because the framework talks
 * to whichever one is configured through the same five methods.
 */
function backendSuite(name, makeStore) {
  test(`${name}: append / load / ack / pendingCount / clear`, async () => {
    const store = await makeStore();
    try {
      await store.append('a1', { type: 'x', n: 1 });
      await store.append('a1', { type: 'x', n: 2 });
      assert.strictEqual(await store.pendingCount('a1'), 2);

      const loaded = await store.load('a1');
      assert.deepStrictEqual(loaded.map((m) => m.n), [1, 2]);
      assert.ok(loaded[0].__msgId, 'append assigns a message id');

      assert.strictEqual(await store.ack('a1', loaded[0].__msgId), 1);
      assert.strictEqual(await store.pendingCount('a1'), 1);
      assert.deepStrictEqual((await store.load('a1')).map((m) => m.n), [2]);

      await store.clear('a1');
      assert.strictEqual(await store.pendingCount('a1'), 0);
      assert.deepStrictEqual(await store.load('a1'), []);
    } finally {
      await store.close();
    }
  });

  test(`${name}: enqueue order is preserved`, async () => {
    const store = await makeStore();
    try {
      for (let n = 0; n < 6; n += 1) await store.append('order', { type: 'x', n });
      assert.deepStrictEqual((await store.load('order')).map((m) => m.n), [0, 1, 2, 3, 4, 5]);
    } finally {
      await store.close();
    }
  });

  test(`${name}: actors are isolated`, async () => {
    const store = await makeStore();
    try {
      await store.append('a1', { type: 'x', n: 1 });
      await store.append('a2', { type: 'x', n: 2 });
      assert.deepStrictEqual((await store.load('a1')).map((m) => m.n), [1]);
      assert.deepStrictEqual((await store.load('a2')).map((m) => m.n), [2]);
      await store.clear('a1');
      assert.strictEqual(await store.pendingCount('a2'), 1);
    } finally {
      await store.close();
    }
  });

  test(`${name}: acking an unknown id is a no-op`, async () => {
    const store = await makeStore();
    try {
      await store.append('a1', { type: 'x' });
      assert.strictEqual(await store.ack('a1', 'nope'), 0);
      assert.strictEqual(await store.ack('a1', []), 0);
      assert.strictEqual(await store.pendingCount('a1'), 1);
    } finally {
      await store.close();
    }
  });

  test(`${name}: a batch ack removes exactly the given ids`, async () => {
    const store = await makeStore();
    try {
      const ids = [];
      for (let n = 0; n < 5; n += 1) {
        const record = await store.append('a1', { type: 'x', n });
        ids.push(record.__msgId);
      }
      assert.strictEqual(await store.ack('a1', [ids[0], ids[2], ids[4]]), 3);
      assert.deepStrictEqual((await store.load('a1')).map((m) => m.n), [1, 3]);
    } finally {
      await store.close();
    }
  });

  test(`${name}: non-object payloads are wrapped instead of crashing`, async () => {
    const store = await makeStore();
    try {
      await store.append('a1', 'plain string');
      const loaded = await store.load('a1');
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0].type, 'raw');
      assert.strictEqual(loaded[0].value, 'plain string');
    } finally {
      await store.close();
    }
  });
}

backendSuite('file store', async () => new FileStore({ baseDir: uniqueDir('file') }));
backendSuite('memory store', async () => new MemoryStore());

const level = levelAvailable();
if (level.available) {
  backendSuite('level store', async () => new LevelStore({ root: uniqueDir('level') }));
} else {
  test('level store (skipped)', { skip: `classic-level unavailable: ${level.reason}` }, () => {});
}

// --- file backend specifics -------------------------------------------------

test('file store: actor ids cannot escape the data directory', async () => {
  const baseDir = uniqueDir('file-traversal');
  const store = new FileStore({ baseDir });
  try {
    await store.append('../../etc/passwd', { type: 'x' });
    const files = fs.readdirSync(baseDir).filter((f) => f.endsWith('.log'));
    assert.strictEqual(files.length, 1);
    assert.ok(!files[0].includes('/'));
    assert.ok(!files[0].includes('..'));
    assert.ok(store.pathFor('../../etc/passwd').startsWith(baseDir));
    assert.strictEqual(path.basename(fileName('../evil')).includes('..'), false);
  } finally {
    await store.close();
  }
});

test('file store: data survives a reopen', async () => {
  const baseDir = uniqueDir('file-reopen');
  const first = new FileStore({ baseDir });
  await first.append('a1', { type: 'x', n: 1 });
  await first.append('a1', { type: 'x', n: 2 });
  await first.close();

  const second = new FileStore({ baseDir });
  try {
    assert.deepStrictEqual((await second.load('a1')).map((m) => m.n), [1, 2]);
  } finally {
    await second.close();
  }
});

test('file store: a corrupted record is skipped, the rest survive', async () => {
  const baseDir = uniqueDir('file-corrupt');
  const store = new FileStore({ baseDir });
  for (let n = 0; n < 3; n += 1) await store.append('a1', { type: 'x', n, filler: 'z'.repeat(20) });
  const file = store.pathFor('a1');

  // Corrupt a byte inside the body of the *middle* record.
  const buf = fs.readFileSync(file);
  const firstLen = buf.readUInt32BE(0);
  const secondBodyStart = 8 + firstLen + 8;
  buf[secondBodyStart + 2] ^= 0xff;
  fs.writeFileSync(file, buf);

  const reopened = new FileStore({ baseDir });
  try {
    const loaded = await reopened.load('a1');
    assert.deepStrictEqual(loaded.map((m) => m.n), [0, 2], 'only the damaged record is lost');
  } finally {
    await reopened.close();
  }
});

test('file store: a torn tail (crash mid-append) keeps earlier records', async () => {
  const baseDir = uniqueDir('file-torn');
  const store = new FileStore({ baseDir });
  for (let n = 0; n < 3; n += 1) await store.append('a1', { type: 'x', n, filler: 'z'.repeat(20) });
  const file = store.pathFor('a1');
  fs.truncateSync(file, fs.statSync(file).size - 7); // cut into the last record

  const reopened = new FileStore({ baseDir });
  try {
    assert.deepStrictEqual((await reopened.load('a1')).map((m) => m.n), [0, 1]);
  } finally {
    await reopened.close();
  }
});

test('file store: acknowledgements are durable across a reopen', async () => {
  // Regression: acks used to live only in memory until compaction, so a
  // restart resurrected acknowledged messages (duplicate delivery).
  const baseDir = uniqueDir('file-durable-ack');
  const huge = { baseDir, compactionThresholdBytes: 100 * 1024 * 1024 };
  const first = new FileStore(huge);
  const acked = await first.append('a1', { type: 'x', n: 1 });
  await first.append('a1', { type: 'x', n: 2 });
  await first.ack('a1', acked.__msgId);
  await first.close(); // no compaction happened

  const second = new FileStore(huge);
  try {
    assert.deepStrictEqual((await second.load('a1')).map((m) => m.n), [2], 'the acked message must stay gone');
  } finally {
    await second.close();
  }
});

test('file store: legacy .jsonl files are migrated, not discarded', async () => {
  const baseDir = uniqueDir('file-legacy');
  fs.mkdirSync(baseDir, { recursive: true });
  const { legacyFileName } = require('../src/store/backends/naming');
  const legacy = path.join(baseDir, legacyFileName('legacy_actor'));
  fs.writeFileSync(
    legacy,
    `${JSON.stringify({ type: 'x', n: 1, __msgId: 'legacy-1' })}\n${JSON.stringify({ type: 'x', n: 2, __msgId: 'legacy-2' })}\n`,
  );

  const store = new FileStore({ baseDir });
  try {
    const loaded = await store.load('legacy_actor');
    assert.deepStrictEqual(loaded.map((m) => m.n), [1, 2], 'legacy messages are readable');
    assert.ok(fs.existsSync(`${legacy}.migrated`), 'the legacy file is preserved');
    assert.ok(fs.existsSync(store.pathFor('legacy_actor')), 'a framed log now exists');
    assert.strictEqual(store.migrated, 1);
  } finally {
    await store.close();
  }
});

test('file store: compaction reclaims space from acknowledged messages', async () => {
  const baseDir = uniqueDir('file-compact');
  const store = new FileStore({ baseDir, compactionThresholdBytes: 200 });
  try {
    for (let n = 0; n < 30; n += 1) await store.append('a1', { type: 'x', n, filler: 'y'.repeat(50) });
    const file = store.pathFor('a1');
    const before = fs.statSync(file).size;

    const loaded = await store.load('a1');
    await store.ack('a1', loaded.slice(0, 29).map((m) => m.__msgId));

    const after = fs.statSync(file).size;
    assert.ok(after < before / 2, `expected compaction to shrink ${before} bytes, got ${after}`);
    assert.deepStrictEqual((await store.load('a1')).map((m) => m.n), [29]);
  } finally {
    await store.close();
  }
});

test('file store: an explicit compact() reports the reclaimed size', async () => {
  const baseDir = uniqueDir('file-compact-explicit');
  const store = new FileStore({ baseDir, compactionThresholdBytes: 10 * 1024 * 1024 });
  try {
    const ids = [];
    for (let n = 0; n < 10; n += 1) {
      const record = await store.append('a1', { type: 'x', n, filler: 'q'.repeat(40) });
      ids.push(record.__msgId);
    }
    await store.ack('a1', ids.slice(0, 9));
    const result = await store.compact('a1');
    assert.ok(result.before > result.after);
    assert.strictEqual(result.records, 1);
    assert.deepStrictEqual((await store.load('a1')).map((m) => m.n), [9]);
  } finally {
    await store.close();
  }
});

// --- level backend specifics ------------------------------------------------

test('level store: data survives a reopen', { skip: level.available ? false : `classic-level unavailable` }, async () => {
  const root = uniqueDir('level-reopen');
  const first = new LevelStore({ root });
  await first.append('a1', { type: 'x', n: 1 });
  await first.append('a1', { type: 'x', n: 2 });
  await first.close();

  const second = new LevelStore({ root });
  try {
    assert.deepStrictEqual((await second.load('a1')).map((m) => m.n), [1, 2]);
  } finally {
    await second.close();
  }
});

test('level store: order is by enqueue sequence, not by message id', { skip: level.available ? false : 'classic-level unavailable' }, async () => {
  const store = new LevelStore({ root: uniqueDir('level-order') });
  try {
    // Forced ids that would sort backwards lexicographically.
    for (const id of ['zzz', 'aaa', 'mmm']) await store.append('a1', { type: 'x', __msgId: id, id });
    assert.deepStrictEqual((await store.load('a1')).map((m) => m.id), ['zzz', 'aaa', 'mmm']);
  } finally {
    await store.close();
  }
});

// --- factory and facade -----------------------------------------------------

test('factory: the three documented backends are constructible', () => {
  assert.deepStrictEqual(BACKENDS, ['file', 'memory', 'level']);
  assert.strictEqual(createStore({ backend: 'file', baseDir: uniqueDir('f') }).backendName, 'file');
  assert.strictEqual(createStore({ backend: 'memory' }).backendName, 'memory');
  if (level.available) {
    assert.strictEqual(createStore({ backend: 'level', levelPath: uniqueDir('l') }).backendName, 'level');
  }
});

test('factory: an unknown backend fails loudly', () => {
  assert.throws(() => createStore({ backend: 'sqlite' }), /unknown store backend/);
  const check = validateStoreConfig({ backend: 'sqlite' });
  assert.strictEqual(check.ok, false);
  assert.match(check.reason, /unknown store backend/);
});

test('factory: validateStoreConfig reports the level dependency honestly', () => {
  assert.deepStrictEqual(validateStoreConfig({ backend: 'file' }), { ok: true, backend: 'file' });
  const levelCheck = validateStoreConfig({ backend: 'level' });
  assert.strictEqual(levelCheck.ok, level.available);
  if (!level.available) assert.match(levelCheck.reason, /classic-level/);
});

test('facade: delegates to an injected backend and reports its name', async () => {
  const backend = new MemoryStore();
  const store = new MessageStore({ backend });
  assert.strictEqual(store.backendName, 'memory');
  await store.append('a1', { type: 'x', n: 1 });
  assert.strictEqual(await store.pendingCount('a1'), 1);
  assert.ok(store.pathFor('a1').includes('msg_store'));
  await store.clear('a1');
  assert.strictEqual(await store.pendingCount('a1'), 0);
  await store.close();
});

test('facade: the default singleton uses the configured backend', () => {
  const store = require('../src/store/message-store');
  assert.ok(BACKENDS.includes(store.backendName));
  assert.ok(store.pathFor('x').startsWith(require('../src/config').dataDir));
});
