'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, waitFor, freePort, delay } = require('./helpers');

const tempDir = setupTempEnv('actor-gossip');

const Gossip = require('../src/cluster/gossip.ts');

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
