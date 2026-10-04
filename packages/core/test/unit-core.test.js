'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { setupTempEnv, cleanup } = require('./helpers');

const tempDir = setupTempEnv('actor-core');

const config = require('../src/config');
const { loadConfig, ensureDirs } = require('../src/config');
const Trace = require('../src/obs/trace');
const { MessageStore } = require('../src/store/message-store');
const { DeadLetterQueue: DLQ } = require('../src/store/dead-letter-queue');
const TokenBucket = require('../src/actor/token-bucket');
const metrics = require('../src/obs/metrics');
const { Counters } = require('../src/obs/metrics');

test.after(() => cleanup(tempDir));

test('config: gossip default port avoids the macOS AirPlay port 7000', () => {
  assert.strictEqual(config.gossip.port, 7200);
  assert.ok(config.gossip.port !== 7000);
});

test('config: loadConfig deep-merges nested overrides', () => {
  const cfg = loadConfig({ telnet: { port: 0 }, actor: { maxRetry: 9 } });
  assert.strictEqual(cfg.telnet.port, 0);
  assert.strictEqual(cfg.telnet.host, '127.0.0.1'); // untouched default
  assert.strictEqual(cfg.actor.maxRetry, 9);
  assert.strictEqual(cfg.actor.maxMailboxSize, 1000); // untouched sibling default
});

test('config: ensureDirs creates the data and log directories', () => {
  const dir = path.join(tempDir, 'made', 'up');
  ensureDirs({ dataDir: dir, logDir: path.join(dir, 'logs') });
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(dir, 'logs')));
});

test('trace: root spans have no parent, children reuse the traceId', () => {
  const root = Trace.buildContext();
  assert.strictEqual(root.parentSpanId, null);
  assert.strictEqual(root.traceId.length, 32);

  const child = Trace.child(root);
  assert.strictEqual(child.traceId, root.traceId);
  assert.strictEqual(child.parentSpanId, root.spanId);
  assert.notStrictEqual(child.spanId, root.spanId);
});

test('trace: invalid parents start a new trace instead of throwing', () => {
  const ctx = Trace.buildContext({ bogus: true });
  assert.strictEqual(ctx.parentSpanId, null);
  assert.strictEqual(Trace.format(null), null);
  assert.match(Trace.format(ctx), /^[0-9a-f]{32}\/[0-9a-f]{16}$/);
});

test('trace: sampling decision is inherited by children', () => {
  const root = Trace.buildContext(null, { sampleRate: 0 });
  assert.strictEqual(root.sampled, false);
  assert.strictEqual(Trace.child(root).sampled, false);
});

test('message-store: append/ack/load round trip', async () => {
  const store = new MessageStore({ baseDir: path.join(tempDir, 'store-a') });
  await store.append('a1', { type: 'x', n: 1 });
  await store.append('a1', { type: 'x', n: 2 });
  assert.strictEqual(await store.pendingCount('a1'), 2);

  const loaded = await store.load('a1');
  assert.strictEqual(loaded.length, 2);
  assert.ok(loaded[0].__msgId, 'append assigns a message id');

  const removed = await store.ack('a1', loaded[0].__msgId);
  assert.strictEqual(removed, 1);
  const after = await store.load('a1');
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].n, 2);
});

test('message-store: actor ids cannot escape the data directory', async () => {
  const base = path.join(tempDir, 'store-b');
  const store = new MessageStore({ baseDir: base });
  await store.append('../../etc/passwd', { type: 'x' });
  const files = fs.readdirSync(base).filter((f) => f.endsWith('.log'));
  assert.strictEqual(files.length, 1, 'exactly one actor log, no stray paths');
  assert.ok(!files[0].includes('/'));
  assert.ok(!files[0].includes('..'));
});

test('message-store: a crash-truncated tail line is skipped, not fatal', async () => {
  const base = path.join(tempDir, 'store-c');
  const store = new MessageStore({ baseDir: base });
  await store.append('a1', { type: 'x', n: 1 });
  fs.appendFileSync(store.pathFor('a1'), '{"type":"x","n":2'); // partial write
  const loaded = await store.load('a1');
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].n, 1);
});

test('message-store: actors are isolated from each other', async () => {
  const store = new MessageStore({ baseDir: path.join(tempDir, 'store-d') });
  await store.append('a1', { type: 'x', n: 1 });
  await store.append('a2', { type: 'x', n: 2 });
  assert.strictEqual((await store.load('a1')).length, 1);
  assert.strictEqual((await store.load('a2'))[0].n, 2);
});

test('dlq: corrupt lines do not break listing', async () => {
  const dlq = new DLQ({ baseDir: path.join(tempDir, 'dlq-a'), filePath: path.join(tempDir, 'dlq-a', 'dlq.jsonl') });
  await dlq.init();
  await dlq.enqueue({ actorId: 'a1', msg: { n: 1 }, reason: 'boom' });
  fs.appendFileSync(dlq.filePath, 'not json at all\n');
  const all = await dlq.readAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].msg.n, 1);
  assert.strictEqual(await dlq.size(), 1);
  await dlq.clear();
  assert.strictEqual(await dlq.size(), 0);
});

test('dlq: growth is bounded by maxEntries', async () => {
  const dir = path.join(tempDir, 'dlq-b');
  const dlq = new DLQ({ baseDir: dir, filePath: path.join(dir, 'dlq.jsonl'), maxEntries: 3 });
  await dlq.init();
  for (let i = 1; i <= 8; i += 1) await dlq.enqueue({ actorId: 'a', msg: { n: i }, reason: 'x' });
  const all = await dlq.readAll();
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[2].msg.n, 8); // newest kept
});


test('token-bucket: capacity, refill over time and msUntil', async () => {
  const bucket = new TokenBucket(2, 100); // 100 tokens/s
  assert.strictEqual(bucket.available(), 2);
  assert.ok(bucket.tryConsume());
  assert.ok(bucket.tryConsume());
  assert.strictEqual(bucket.tryConsume(), false);
  assert.ok(bucket.msUntil(1) > 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(bucket.available() > 0, 'refills after waiting');
  assert.strictEqual(bucket.msUntil(1), 0);
});

test('token-bucket: never exceeds capacity after a long idle period', async () => {
  const bucket = new TokenBucket(5, 1000);
  bucket.tokens = 0;
  bucket.lastRefillTs = Date.now() - 60000;
  assert.strictEqual(bucket.refill(), 5);
});

test('metrics: worker deltas are merged and averages derived', () => {
  const Metrics = require('../src/obs/metrics').Metrics;
  const m = new Metrics({ logDir: path.join(tempDir, 'metrics') });
  m.observe('a1', { received: 10, handled: 8, failed: 2, totalLatencyMs: 80, maxLatencyMs: 30 });
  m.observe('a1', { received: 5, handled: 2, totalLatencyMs: 20, maxLatencyMs: 12 });
  const snap = m.dump({ persist: false });
  assert.strictEqual(snap.a1.received, 15);
  assert.strictEqual(snap.a1.handled, 10);
  assert.strictEqual(snap.a1.totalLatencyMs, 100);
  assert.strictEqual(snap.a1.maxLatencyMs, 30);
  assert.strictEqual(snap.a1.avgLatencyMs, 10);
});

test('metrics: Counters accumulate then reset on take()', () => {
  const c = new Counters();
  c.inc('received');
  c.inc('received');
  c.addLatency(5);
  c.addLatency(15);
  const delta = c.take();
  assert.strictEqual(delta.received, 2);
  assert.strictEqual(delta.totalLatencyMs, 20);
  assert.strictEqual(delta.maxLatencyMs, 15);
  assert.ok(c.isEmpty);
  assert.deepStrictEqual(c.take(), {});
});


