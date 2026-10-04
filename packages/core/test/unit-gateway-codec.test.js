'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup } = require('./helpers');

const tempDir = setupTempEnv('actor-codec');

const { Gateway, encodeFrame, FrameDecoder, CODEC, codecFromName } = require('../src/cluster/gateway');

test.after(() => cleanup(tempDir));

async function withGateways(specs, fn) {
  const gateways = specs.map(
    (spec, index) =>
      new Gateway({
        host: '127.0.0.1',
        port: 0,
        nodeId: spec.nodeId || `G${index}`,
        codec: spec.codec,
        onDeliver: spec.onDeliver || (async () => null),
      }),
  );
  try {
    for (const gw of gateways) await gw.listen();
    return await fn(gateways);
  } finally {
    for (const gw of gateways) {
      try {
        await gw.close();
      } catch {
        /* already closed */
      }
    }
  }
}

test('codecFromName defaults to protobuf and recognises json', () => {
  assert.strictEqual(codecFromName('json'), CODEC.JSON);
  assert.strictEqual(codecFromName('JSON'), CODEC.JSON);
  assert.strictEqual(codecFromName('proto'), CODEC.PROTOBUF);
  assert.strictEqual(codecFromName('anything-else'), CODEC.PROTOBUF);
});

test('the frame header carries the codec, and a decoder accepts both', () => {
  const jsonFrame = encodeFrame({ kind: 'ping', id: 'j' }, CODEC.JSON);
  const protoFrame = encodeFrame({ kind: 'ping', id: 'p' }, CODEC.PROTOBUF);
  assert.strictEqual(jsonFrame.readUInt8(4), CODEC.JSON);
  assert.strictEqual(protoFrame.readUInt8(4), CODEC.PROTOBUF);

  const decoder = new FrameDecoder(4096);
  const frames = decoder.push(Buffer.concat([jsonFrame, protoFrame]));
  assert.deepStrictEqual(frames, [{ kind: 'ping', id: 'j' }, { kind: 'ping', id: 'p' }]);
});

test('a decoder handles split frames of either codec', () => {
  const combined = Buffer.concat([
    encodeFrame({ kind: 'deliver', id: 'a', targetActorId: 'x', payload: { n: 1 } }, CODEC.PROTOBUF),
    encodeFrame({ kind: 'deliver', id: 'b', targetActorId: 'y', payload: { n: 2 } }, CODEC.JSON),
  ]);
  const decoder = new FrameDecoder(4096);
  const frames = [];
  for (let i = 0; i < combined.length; i += 3) {
    frames.push(...decoder.push(combined.subarray(i, i + 3)));
  }
  assert.strictEqual(frames.length, 2);
  assert.deepStrictEqual(frames[0].payload, { n: 1 });
  assert.deepStrictEqual(frames[1].payload, { n: 2 });
});

test('an unknown codec byte is rejected instead of misparsed', () => {
  const frame = encodeFrame({ kind: 'ping' }, CODEC.JSON);
  frame.writeUInt8(9, 4); // corrupt the codec
  const decoder = new FrameDecoder(4096);
  assert.throws(() => decoder.push(frame), /unknown frame codec/);
});

test('oversized frames are still rejected with the new header', () => {
  const decoder = new FrameDecoder(16);
  // JSON framing keeps unknown keys, so it is the easy way to build a big body.
  const big = encodeFrame({ kind: 'ping', padding: 'x'.repeat(64) }, CODEC.JSON);
  assert.ok(big.length > 16);
  assert.throws(() => decoder.push(big), /frame too large/);
});

test('protobuf peers interoperate with json peers (mixed codecs)', async () => {
  await withGateways(
    [
      { nodeId: 'A', codec: 'json', onDeliver: async (target, payload) => ({ target, payload, answeredBy: 'A' }) },
      { nodeId: 'B', codec: 'proto' },
    ],
    async ([a, b]) => {
      assert.strictEqual(a.codecName, 'json');
      assert.strictEqual(b.codecName, 'proto');

      // B speaks protobuf, A answers in JSON: both directions must decode.
      const result = await b.deliver('127.0.0.1', a.port, 'actor-1', { type: 'x', n: 7 });
      assert.deepStrictEqual(result, { target: 'actor-1', payload: { type: 'x', n: 7 }, answeredBy: 'A' });
      assert.strictEqual(await b.ping('127.0.0.1', a.port), true);
      assert.strictEqual(await a.ping('127.0.0.1', b.port), true);
    },
  );
});

test('two protobuf peers deliver and correlate concurrent requests', async () => {
  await withGateways(
    [
      {
        nodeId: 'A',
        codec: 'proto',
        onDeliver: async (target, payload) => {
          await new Promise((r) => setTimeout(r, payload.delay));
          return payload.n;
        },
      },
      { nodeId: 'B', codec: 'proto' },
    ],
    async ([a, b]) => {
      const results = await Promise.all([
        b.deliver('127.0.0.1', a.port, 'x', { n: 1, delay: 40 }),
        b.deliver('127.0.0.1', a.port, 'x', { n: 2, delay: 5 }),
        b.deliver('127.0.0.1', a.port, 'x', { n: 3, delay: 20 }),
      ]);
      assert.deepStrictEqual(results, [1, 2, 3]);
    },
  );
});

test('protobuf frames survive non-ASCII and nested payloads', async () => {
  await withGateways(
    [{ nodeId: 'A', codec: 'proto', onDeliver: async (target, payload) => payload }],
    async ([a]) => {
      const payload = {
        type: 'chat',
        text: '你好，世界 🎉 ünïcødé',
        nested: { list: [1, 'two', { three: true }], nil: null },
      };
      const echoed = await a.deliver('127.0.0.1', a.port, 'x', payload);
      assert.deepStrictEqual(echoed, payload);
    },
  );
});

test('the default gateway codec is protobuf', () => {
  const gw = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'default' });
  assert.strictEqual(gw.codec, CODEC.PROTOBUF);
  assert.strictEqual(gw.codecName, 'proto');
});
