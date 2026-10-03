'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { setupTempEnv, cleanup, waitFor } = require('./helpers');

const tempDir = setupTempEnv('actor-resilience');

const { Actor } = require('../actor-worker');
const config = require('../config');
const msgStore = require('../message-store');
const DLQ = require('../dead-letter-queue');

test.after(() => cleanup(tempDir));

let seq = 0;
function makeActor(handler, overrides = {}) {
  const port = {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
  const actorId = overrides.actorId || `res-${++seq}`;
  const actor = new Actor({
    ...config.actor,
    port,
    actorId,
    batchTimeoutMs: 10,
    retryBackoffMs: 1,
    metricsFlushMs: 0,
    ...overrides,
  });
  actor.actorId = actorId;
  actor.onMessage = handler;
  return { actor, port, actorId };
}

const replies = (port) => port.messages.filter((m) => m.type === 'reply').map((m) => m.replyId).sort();
const errors = (port) => port.messages.filter((m) => m.type === 'error').map((m) => m.replyId);

test('regression: one failing message in a batch loses nothing and is attributed correctly', async () => {
  await DLQ.clear();
  const { actor, port, actorId } = makeActor(
    async function handler(msg) {
      if (msg.n === 2) throw new Error('boom');
      return `ok:${msg.n}`;
    },
    { batchMaxSize: 5 },
  );

  for (let n = 1; n <= 5; n += 1) await actor.send({ type: 't', n, __replyId: `r${n}` });
  await waitFor(() => errors(port).length > 0, { message: 'the failing message to reach the DLQ' });
  await waitFor(async () => (await msgStore.pendingCount(actorId)) === 0, { message: 'all messages acked' });

  // Previously 4 of these 5 messages vanished silently.
  assert.deepStrictEqual(replies(port), ['r1', 'r3', 'r4', 'r5'], 'every healthy message got its reply');
  assert.deepStrictEqual(errors(port), ['r2'], 'only the failing message is reported');

  const dlq = await DLQ.readAll();
  assert.strictEqual(dlq.length, 1, 'exactly one dead letter');
  assert.strictEqual(dlq[0].msg.n, 2, 'the dead letter names the message that actually failed');
  assert.strictEqual(dlq[0].actorId, actorId);
  assert.strictEqual(dlq[0].retryCount, config.actor.maxRetry);
});

test('regression: a single failing message retries then dead-letters without crashing', async () => {
  await DLQ.clear();
  let attempts = 0;
  const { actor, port, actorId } = makeActor(async function handler(msg) {
    if (msg.fail) {
      attempts += 1;
      throw new Error('always fails');
    }
    return 'fine';
  });

  await actor.send({ type: 't', fail: true, __replyId: 'bad' });
  await actor.send({ type: 't', fail: false, __replyId: 'good' });

  await waitFor(() => replies(port).length === 1 && errors(port).length === 1, { message: 'both outcomes' });
  assert.deepStrictEqual(replies(port), ['good'], 'the healthy message still succeeded (no process death)');
  assert.deepStrictEqual(errors(port), ['bad']);
  assert.strictEqual(attempts, config.actor.maxRetry + 1, 'initial attempt plus retries');
  assert.strictEqual((await DLQ.readAll()).length, 1);
  assert.strictEqual(await msgStore.pendingCount(actorId), 0);
});

test('retry recovers a transient failure without dead-lettering', async () => {
  await DLQ.clear();
  let calls = 0;
  const { actor, port, actorId } = makeActor(async function handler() {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return 'recovered';
  });

  await actor.send({ type: 't', __replyId: 'r1' });
  await waitFor(() => replies(port).length === 1, { message: 'reply after retry' });
  assert.strictEqual(calls, 2);
  assert.strictEqual((await DLQ.readAll()).length, 0, 'no dead letter for a transient failure');
  assert.strictEqual(await msgStore.pendingCount(actorId), 0);
});

test('mailbox backpressure rejects instead of growing, and never persists the dropped message', async () => {
  const { actor, port, actorId } = makeActor(async function handler() {
    return 1;
  }, { maxMailboxSize: 2 });

  actor.processing = true; // freeze the drain loop so the mailbox stays full
  assert.strictEqual(await actor.send({ type: 't', __replyId: 'a' }), true);
  assert.strictEqual(await actor.send({ type: 't', __replyId: 'b' }), true);
  assert.strictEqual(await actor.send({ type: 't', __replyId: 'c' }), false);

  const full = port.messages.find((m) => m.type === 'mailbox_full');
  assert.ok(full, 'the caller is told the mailbox is full');
  assert.strictEqual(full.replyId, 'c');
  assert.match(full.error, /mailbox full/);
  assert.strictEqual(await msgStore.pendingCount(actorId), 2, 'the dropped message was not written to disk');
  actor.processing = false;
});

test('persistence: only unacknowledged messages are replayed after a restart', async () => {
  const actorId = 'res-recover';
  await msgStore.clear(actorId);

  const first = makeActor(async function handler() {
    return 'x';
  }, { actorId, maxMailboxSize: 10 });
  first.actor.processing = true; // nothing is consumed, everything stays durable

  for (let n = 0; n < 3; n += 1) await first.actor.send({ type: 't', n });
  assert.strictEqual(await msgStore.pendingCount(actorId), 3);

  const persisted = await msgStore.load(actorId);
  await msgStore.ack(actorId, persisted[0].__msgId);
  assert.strictEqual(await msgStore.pendingCount(actorId), 2);

  // "Restart": a brand new actor instance with the same id.
  const second = makeActor(async function handler() {
    return 'y';
  }, { actorId, maxMailboxSize: 10 });
  const recovered = await second.actor.loadPersistMessages();
  assert.strictEqual(recovered, 2, 'only the two unacked messages came back');

  await waitFor(async () => (await msgStore.pendingCount(actorId)) === 0, { message: 'recovered work is acked' });
  assert.strictEqual(second.port.messages.filter((m) => m.type === 'reply').length, 0, 'recovered messages have no live caller');
});

test('an actor with no persisted state starts empty', async () => {
  const actorId = 'res-empty';
  await msgStore.clear(actorId);
  const { actor } = makeActor(async function handler() {
    return 1;
  }, { actorId });
  assert.strictEqual(await actor.loadPersistMessages(), 0);
});

test('invalid damage is rejected instead of poisoning state with NaN', async () => {
  await DLQ.clear();
  const { actor, port, actorId } = makeActor(undefined, {});
  actor.onMessage = new Actor({ port: { postMessage() {} } }).onMessage; // framework default handler
  await actor.send({ type: 'hurt', damage: 'abc', __replyId: 'bad' });
  await waitFor(() => errors(port).length === 1, { message: 'the bad damage is refused' });
  await actor.send({ type: 'hurt', damage: 10, __replyId: 'good' });
  await waitFor(() => replies(port).length === 1, { message: 'valid damage works' });
  assert.strictEqual(actor.state.hp, 90, 'state stayed a real number');
  assert.ok(Number.isFinite(actor.state.hp));
  assert.strictEqual(await msgStore.pendingCount(actorId), 0);
});

test('a handler that throws synchronously is still isolated and retried', async () => {
  await DLQ.clear();
  const { actor, port } = makeActor(function handler(msg) {
    if (msg.n === 1) throw new Error('sync boom');
    return 'ok';
  });
  await actor.send({ type: 't', n: 1, __replyId: 'sync' });
  await actor.send({ type: 't', n: 2, __replyId: 'fine' });
  await waitFor(() => replies(port).length === 1 && errors(port).length === 1, { message: 'both settle' });
  assert.deepStrictEqual(replies(port), ['fine']);
  assert.deepStrictEqual(errors(port), ['sync']);
  assert.strictEqual((await DLQ.readAll()).length, 1);
});

test('batched delivery via onBatch still isolates failures', async () => {
  await DLQ.clear();
  const seen = [];
  const { actor, port } = makeActor(undefined, { batchMaxSize: 3 });
  actor.onBatch = async function onBatch(batch) {
    for (const msg of batch) seen.push(msg.n);
    throw new Error('whole batch failed');
  };
  for (let n = 1; n <= 3; n += 1) await actor.send({ type: 't', n, __replyId: `b${n}` });
  await waitFor(() => errors(port).length === 3, { message: 'every message in the batch is individually retried and dead-lettered' });
  assert.strictEqual(seen.length >= 3, true);
  assert.strictEqual((await DLQ.readAll()).length, 3, 'a failing batch dead-letters each message, losing none');
});

test('persistence files live under the configured data dir', () => {
  assert.ok(msgStore.pathFor('x').startsWith(config.dataDir));
  assert.ok(msgStore.pathFor('x').startsWith(path.join(config.dataDir, 'msg_store')));
});
