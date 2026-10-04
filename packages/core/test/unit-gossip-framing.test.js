'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { setupTempEnv, cleanup, waitFor } = require('./helpers');

const tempDir = setupTempEnv('actor-gossip-frame');

const Gossip = require('../src/cluster/gossip.ts');
const proto = require('../src/cluster/proto.ts');
const { createFraming, CODEC, codecFromName } = require('../src/cluster/framing.ts');

test.after(() => cleanup(tempDir));

const framing = createFraming({
  protoEncode: proto.encodeGossipEnvelope,
  protoDecode: proto.decodeGossipEnvelope,
});

function nodeOptions(extra = {}) {
  return {
    host: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    intervalMs: 80,
    peerTimeoutMs: 5000,
    ...extra,
  };
}

test('gossip envelopes round-trip through the protobuf codec', () => {
  const envelope = {
    type: 'gossip',
    sender: 'node-1',
    advertiseHost: '10.0.0.1',
    port: 7200,
    data: { 'actor-1': { key: 'actor-1', value: { type: 'actor' }, ts: 123, nodeId: 'node-1', deleted: false } },
  };
  assert.deepStrictEqual(proto.decodeGossipEnvelope(proto.encodeGossipEnvelope(envelope)), envelope);
});

test('gossip frames use the shared binary framing, not newline JSON', () => {
  const frame = framing.encode({ type: 'gossip', sender: 'n1', data: { a: 1 } });
  assert.strictEqual(frame.readUInt8(4), CODEC.PROTOBUF, 'the codec byte says protobuf');
  assert.notStrictEqual(frame[frame.length - 1], 0x0a, 'no trailing newline');

  const decoder = new framing.FrameDecoder(1024 * 1024);
  assert.deepStrictEqual(decoder.push(frame), [{ type: 'gossip', sender: 'n1', data: { a: 1 } }]);

  // The codec byte travels with the frame, so a json-encoded peer still decodes.
  const jsonFrame = framing.encode({ type: 'gossip', sender: 'n2', data: { b: 2 } }, CODEC.JSON);
  const mixed = new framing.FrameDecoder(1024 * 1024);
  assert.deepStrictEqual(mixed.push(Buffer.concat([jsonFrame, frame])), [
    { type: 'gossip', sender: 'n2', data: { b: 2 } },
    { type: 'gossip', sender: 'n1', data: { a: 1 } },
  ]);
});

test('gossip: mixed codec peers still converge', async () => {
  const g1 = new Gossip('node-1', 0, nodeOptions({ codec: codecFromName('proto') }));
  await g1.start();
  const g2 = new Gossip('node-2', 0, nodeOptions({
    codec: codecFromName('json'),
    seeds: [{ host: '127.0.0.1', port: g1.boundPort }],
  }));
  await g2.start();

  try {
    g1.setLocal('mixed-codec-actor', { type: 'actor', host: '127.0.0.1', gatewayPort: 1 });
    await waitFor(() => g2.localRegistry.has('mixed-codec-actor'), { message: 'json<->proto convergence' });
    g2.setLocal('back-the-other-way', { type: 'actor' });
    await waitFor(() => g1.localRegistry.has('back-the-other-way'), { message: 'reverse convergence' });
  } finally {
    await g1.stop();
    await g2.stop();
  }
});

test('gossip: a legacy newline-JSON peer is rejected without harming the node', async () => {
  const g = new Gossip('node-1', 0, nodeOptions());
  await g.start();
  const errors = [];
  g.on('protocol_error', (err) => errors.push(err.message));

  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: g.boundPort });
    await new Promise((resolve) => socket.on('connect', resolve));
    // What the pre-1.2 wire format looked like.
    socket.write(`${JSON.stringify({ type: 'gossip', sender: 'old-node', port: 1, data: {} })}\n`);
    await waitFor(() => errors.length > 0, { message: 'the legacy peer to be rejected', timeout: 3000 });
    assert.match(errors[0], /frame too large|unknown frame codec|truncated|must be/);
    socket.destroy();

    // The node is still healthy and still converges with a real peer.
    const peer = new Gossip('node-2', 0, nodeOptions({ seeds: [{ host: '127.0.0.1', port: g.boundPort }] }));
    await peer.start();
    try {
      g.setLocal('survivor', { type: 'actor' });
      await waitFor(() => peer.localRegistry.has('survivor'), { message: 'convergence after the bad peer' });
    } finally {
      await peer.stop();
    }
  } finally {
    await g.stop();
  }
});

test('gossip: an oversized frame is refused', async () => {
  const g = new Gossip('node-1', 0, nodeOptions({ maxPayloadBytes: 4096 }));
  await g.start();
  const errors = [];
  g.on('protocol_error', (err) => errors.push(err.message));

  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: g.boundPort });
    await new Promise((resolve) => socket.on('connect', resolve));
    const header = Buffer.alloc(5);
    header.writeUInt32BE(0xffffffff, 0); // absurd length
    header.writeUInt8(CODEC.PROTOBUF, 4);
    socket.write(header);
    await waitFor(() => errors.length > 0, { message: 'the oversized frame to be refused', timeout: 3000 });
    assert.match(errors[0], /frame too large/);
    socket.destroy();
  } finally {
    await g.stop();
  }
});

test('gossip: the default codec is protobuf and is configurable', async () => {
  const g = new Gossip('node-1', 0, nodeOptions());
  assert.strictEqual(g.codec, CODEC.PROTOBUF);
  const jsonNode = new Gossip('node-2', 0, nodeOptions({ codec: codecFromName('json') }));
  assert.strictEqual(jsonNode.codec, CODEC.JSON);
  await g.start();
  try {
    assert.ok(g.maxFrameBytes > g.maxPayloadBytes, 'framing overhead is accounted for');
  } finally {
    await g.stop();
  }
});
