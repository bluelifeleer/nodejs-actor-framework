'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, waitFor, freePort, delay } = require('./helpers');

const tempDir = setupTempEnv('actor-gossip');

const Gossip = require('../gossip');
const PubSub = require('../pubsub');

test.after(() => cleanup(tempDir));

function nodeOptions(extra = {}) {
  return {
    host: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    intervalMs: 80,
    peerTimeoutMs: 5000,
    ...extra,
  };
}

test('gossip: two nodes converge and actually keep peers', async () => {
  const g1 = new Gossip('node-1', 0, nodeOptions());
  await g1.start();
  const g2 = new Gossip('node-2', 0, nodeOptions({ seeds: [{ host: '127.0.0.1', port: g1.boundPort }] }));
  await g2.start();

  try {
    assert.ok(g2.peers.size > 0, 'seeds populate the peer set (the old code never did)');

    const updates = [];
    g2.on('registry_update', (key, value) => updates.push({ key, value }));
    g1.setLocal('actor-1', { type: 'actor', nodeId: 'node-1', host: '127.0.0.1', gatewayPort: 1234 });

    await waitFor(() => g2.localRegistry.has('actor-1'), { message: 'gossip convergence' });
    assert.strictEqual(g2.localRegistry.get('actor-1').value.gatewayPort, 1234);
    assert.ok(updates.some((u) => u.key === 'actor-1'));
  } finally {
    await g1.stop();
    await g2.stop();
  }
});

test('gossip: deletions propagate as tombstones', async () => {
  const g1 = new Gossip('node-1', 0, nodeOptions());
  await g1.start();
  const g2 = new Gossip('node-2', 0, nodeOptions({ seeds: [{ host: '127.0.0.1', port: g1.boundPort }] }));
  await g2.start();

  try {
    const deletes = [];
    g2.on('registry_delete', (key) => deletes.push(key));

    g1.setLocal('actor-2', { type: 'actor' });
    await waitFor(() => g2.localRegistry.has('actor-2'), { message: 'initial replication' });

    g1.delLocal('actor-2');
    await waitFor(() => {
      const entry = g2.localRegistry.get('actor-2');
      return entry && entry.deleted === true;
    }, { message: 'tombstone propagation' });
    assert.ok(deletes.includes('actor-2'));
  } finally {
    await g1.stop();
    await g2.stop();
  }
});

test('gossip: merge is last-write-wins with a deterministic tie-break', () => {
  const g = new Gossip('n', 0, nodeOptions());
  g.setLocal('k', { v: 1 });

  g.mergeState({ k: { key: 'k', value: { v: 0 }, ts: Date.now() - 10000, nodeId: 'other', deleted: false } }, 'other');
  assert.strictEqual(g.localRegistry.get('k').value.v, 1, 'an older write must not win');

  g.mergeState({ k: { key: 'k', value: { v: 2 }, ts: Date.now() + 10000, nodeId: 'other', deleted: false } }, 'other');
  assert.strictEqual(g.localRegistry.get('k').value.v, 2, 'a newer write wins');

  const sameTs = Date.now() + 20000;
  g.mergeState({ k: { key: 'k', value: { v: 3 }, ts: sameTs, nodeId: 'aaa' } }, 'aaa');
  g.mergeState({ k: { key: 'k', value: { v: 4 }, ts: sameTs, nodeId: 'zzz' } }, 'zzz');
  assert.strictEqual(g.localRegistry.get('k').value.v, 4, 'higher nodeId breaks the tie');
});

test('gossip: malformed input is ignored rather than crashing', () => {
  const g = new Gossip('n', 0, nodeOptions());
  assert.deepStrictEqual(g.mergeState(null, 'x'), []);
  assert.deepStrictEqual(g.mergeState({ bad: { nope: true } }, 'x'), []);
  assert.deepStrictEqual(g.mergeState('not an object', 'x'), []);
});

test('gossip: an unreachable peer reports failure without an unhandled error', async () => {
  const closedPort = await freePort();
  const g = new Gossip('node-x', 0, nodeOptions());
  const ok = await g.pushTo({ host: '127.0.0.1', port: closedPort, lastSeen: 0, failures: 0 });
  assert.strictEqual(ok, false);
  await delay(20);
});

test('gossip: silent nodes are pruned after the peer timeout', () => {
  const g = new Gossip('me', 0, nodeOptions({ peerTimeoutMs: 10 }));
  g.nodeLastSeen.set('ghost', Date.now() - 1000);
  g.localRegistry.set('actor-ghost', { key: 'actor-ghost', value: {}, ts: Date.now(), nodeId: 'ghost', deleted: false });
  const removed = g.pruneStaleNodes();
  assert.ok(removed.includes('actor-ghost'));
  assert.strictEqual(g.localRegistry.has('actor-ghost'), false);
  assert.strictEqual(g.nodeLastSeen.has('ghost'), false);
});

test('pubsub: fan-out is parallel, tagged with the topic and traced as children', async () => {
  const calls = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const fakeAm = {
    send: async (actorId, payload, timeoutMs, priority, trace) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(40);
      concurrent -= 1;
      calls.push({ actorId, payload, trace });
      return `ok:${actorId}`;
    },
  };

  const ps = new PubSub({ actorManager: fakeAm, nodeId: 'n1' });
  ps.subscribe('game/notice', 'a1');
  ps.subscribe('game/notice', 'a2');
  ps.subscribe('game/notice', 'a3');

  const results = await ps.publish('game/notice', { msg: 'server open' });
  assert.strictEqual(results.length, 3);
  assert.ok(results.every((r) => r.ok));
  assert.strictEqual(maxConcurrent, 3, 'deliveries happen concurrently');
  assert.ok(calls.every((c) => c.payload.topic === 'game/notice'), 'the topic is delivered');
  assert.strictEqual(new Set(calls.map((c) => c.trace.traceId)).size, 1, 'one trace per publish');
  assert.strictEqual(new Set(calls.map((c) => c.trace.spanId)).size, 3, 'one child span per delivery');
  assert.strictEqual(new Set(calls.map((c) => c.trace.parentSpanId)).size, 1, 'shared parent span');
});

test('pubsub: failures are reported per subscriber without aborting the fan-out', async () => {
  const fakeAm = {
    send: async (actorId) => {
      if (actorId === 'bad') throw new Error('actor not found');
      return 'fine';
    },
  };
  const ps = new PubSub({ actorManager: fakeAm, nodeId: 'n1' });
  ps.subscribe('t', 'good');
  ps.subscribe('t', 'bad');
  const results = await ps.publish('t', {});
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results.find((r) => r.actorId === 'good').ok, true);
  assert.strictEqual(results.find((r) => r.actorId === 'bad').ok, false);
});

test('pubsub: unsubscribe, topic listing and empty topics', async () => {
  const ps = new PubSub({ actorManager: { send: async () => 1 }, nodeId: 'n1' });
  ps.subscribe('a', 'x');
  ps.subscribe('b', 'y');
  assert.deepStrictEqual(ps.listTopics().sort(), ['a', 'b']);
  assert.strictEqual(ps.unsubscribe('a', 'x'), true);
  assert.strictEqual(ps.unsubscribe('a', 'x'), false);
  assert.deepStrictEqual(ps.listTopics(), ['b']);
  assert.deepStrictEqual(await ps.publish('missing', {}), []);
  assert.throws(() => ps.subscribe('', 'x'), TypeError);
});

test('pubsub: subscriptions replicate across nodes through gossip', async () => {
  const g1 = new Gossip('node-1', 0, nodeOptions());
  await g1.start();
  const g2 = new Gossip('node-2', 0, nodeOptions({ seeds: [{ host: '127.0.0.1', port: g1.boundPort }] }));
  await g2.start();

  try {
    const ps1 = new PubSub({ actorManager: { send: async () => 1 }, gossip: g1, nodeId: 'node-1' });
    const ps2 = new PubSub({ actorManager: { send: async () => 1 }, gossip: g2, nodeId: 'node-2' });

    ps2.subscribe('news', 'remote-actor');
    await waitFor(() => ps1.subscribers('news').includes('remote-actor'), {
      message: 'subscription replication',
      timeout: 6000,
    });
    assert.deepStrictEqual(ps1.listTopics(), ['news']);

    ps2.unsubscribe('news', 'remote-actor');
    await waitFor(() => !ps1.subscribers('news').includes('remote-actor'), {
      message: 'unsubscribe replication',
      timeout: 6000,
    });
  } finally {
    await g1.stop();
    await g2.stop();
  }
});
