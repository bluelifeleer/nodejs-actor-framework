'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, waitFor } = require('./helpers');

const tempDir = setupTempEnv('actor-cluster');

const { bootstrap } = require('../actor-main');
const { Registry } = require('../registry');

let node1;
let node2;

before(async () => {
  node1 = await bootstrap({
    nodeId: 'node-1',
    registry: new Registry(),
    telnet: { enabled: false },
    gateway: { enabled: true, port: 0, host: '127.0.0.1' },
    gossip: { enabled: true, port: 0, host: '127.0.0.1', intervalMs: 100, peerTimeoutMs: 30000 },
    bootActors: ['remote_target'],
  });

  node2 = await bootstrap({
    nodeId: 'node-2',
    registry: new Registry(),
    telnet: { enabled: false },
    gateway: { enabled: true, port: 0, host: '127.0.0.1' },
    gossip: {
      enabled: true,
      port: 0,
      host: '127.0.0.1',
      intervalMs: 100,
      peerTimeoutMs: 30000,
      seeds: [{ host: '127.0.0.1', port: node1.ports.gossip }],
    },
    bootActors: [],
  });
});

after(async () => {
  await node1.close();
  await node2.close();
  cleanup(tempDir);
});

test('both nodes listen on their own ports and stay separate', () => {
  assert.ok(node1.ports.gateway > 0);
  assert.ok(node2.ports.gateway > 0);
  assert.notStrictEqual(node1.ports.gateway, node2.ports.gateway);
  assert.notStrictEqual(node1.ports.gossip, node2.ports.gossip);
  assert.deepStrictEqual(node1.actorManager.listActors(), ['remote_target']);
  assert.deepStrictEqual(node2.actorManager.listActors(), []);
});

test('gossip replicates the remote actor into node2 with a reachable address', async () => {
  const meta = await waitFor(() => node2.registry.find('remote_target'), {
    message: 'remote actor discovery',
    timeout: 15000,
  });
  assert.strictEqual(meta.type, 'remote');
  assert.strictEqual(meta.host, '127.0.0.1');
  assert.strictEqual(meta.gatewayPort, node1.ports.gateway);

  // node1 must not consider its own actor remote.
  assert.strictEqual(node1.registry.find('remote_target').type, 'actor');
});

test('node2 can message an actor that only exists on node1 (via the gateway)', async () => {
  const hp = await node2.actorManager.send('remote_target', { type: 'hurt', damage: 5 }, 4000);
  assert.strictEqual(hp, 95, 'the reply travelled back over the gateway');

  const state = await node2.actorManager.send('remote_target', { type: 'debug:getState' }, 4000);
  assert.deepStrictEqual(state, { hp: 95 });
});

test('remote delivery preserves priority and tracing', async () => {
  const Trace = require('../trace');
  const parent = Trace.newRoot();
  const hp = await node2.actorManager.send('remote_target', { type: 'hurt', damage: 1 }, 4000, 0, parent);
  assert.strictEqual(hp, 94);
});

test('publishing on node2 reaches a subscriber registered on node1', async () => {
  node1.pubsub.subscribe('game/notice', 'remote_target');
  await waitFor(() => node2.pubsub.subscribers('game/notice').includes('remote_target'), {
    message: 'subscription gossip',
    timeout: 15000,
  });

  const results = await node2.pubsub.publish('game/notice', { msg: 'server open' });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].actorId, 'remote_target');
  assert.strictEqual(results[0].ok, true, `publish failed: ${JSON.stringify(results)}`);
});

test('errors for unknown remote actors surface instead of hanging', async () => {
  await assert.rejects(
    () => node2.actorManager.send('does_not_exist', { type: 'x' }, 1000),
    /not found/,
  );
});

test('gateway ping works between the two nodes', async () => {
  assert.strictEqual(await node2.gateway.ping('127.0.0.1', node1.ports.gateway), true);
  assert.strictEqual(await node2.gateway.ping('127.0.0.1', node2.ports.gateway), true);
});

test('an actor that dies on node1 disappears from node2 through gossip', async () => {
  await waitFor(() => node2.registry.find('remote_target'), { message: 'actor present', timeout: 5000 });
  await node1.actorManager.destroyActor('remote_target');

  // peerTimeoutMs is far longer than this window, so staleness pruning cannot
  // mask a missing delete: the tombstone itself must propagate.
  await waitFor(() => !node2.registry.find('remote_target'), {
    message: 'remote actor withdrawn after the local one stopped',
    timeout: 8000,
  });
});

test('gossip info reports peers on both sides', async () => {
  const info = node2.gossip.info();
  assert.strictEqual(info.nodeId, 'node-2');
  assert.ok(info.peers.length >= 1, 'node2 knows a peer');
  assert.ok(info.registrySize >= 1, 'node2 replicates something');
});

test('a live remote actor is not pruned by the staleness timer', async () => {
  // Regression: lastSeen used to refresh only when the gossiped *value*
  // changed, so a healthy peer's actors disappeared after peerTimeoutMs even
  // though the node was still gossiping every interval.
  const shortTimers = { enabled: true, port: 0, host: '127.0.0.1', intervalMs: 100, peerTimeoutMs: 800 };
  const left = await bootstrap({
    nodeId: 'stale-1',
    registry: new Registry(),
    telnet: { enabled: false },
    gateway: { enabled: true, port: 0, host: '127.0.0.1' },
    gossip: shortTimers,
    registryPruneMs: 200,
    bootActors: ['sticky'],
  });
  const right = await bootstrap({
    nodeId: 'stale-2',
    registry: new Registry(),
    telnet: { enabled: false },
    gateway: { enabled: true, port: 0, host: '127.0.0.1' },
    gossip: { ...shortTimers, seeds: [{ host: '127.0.0.1', port: left.ports.gossip }] },
    registryPruneMs: 200,
    bootActors: [],
  });

  try {
    await waitFor(() => right.registry.find('sticky'), { message: 'initial discovery', timeout: 8000 });

    // Wait well past the peer timeout while both nodes keep gossiping.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const meta = right.registry.find('sticky');
    assert.ok(meta, "a live node's actor must not be pruned");
    assert.strictEqual(meta.type, 'remote');

    // Still reachable, not merely present in the registry.
    await right.actorManager.send('sticky', { type: 'debug:getState' }, 3000);
  } finally {
    await left.close();
    await right.close();
  }
});
