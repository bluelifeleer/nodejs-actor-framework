'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup, freePort } = require('./helpers');

const tempDir = setupTempEnv('actor-gw');

const { Gateway, encodeFrame, FrameDecoder, CODEC } = require('../gateway');

test.after(() => cleanup(tempDir));

/**
 * Build gateways and guarantee they are closed, so a failing assertion cannot
 * leak listening sockets and stall the test runner.
 */
async function withGateways(specs, fn) {
  const gateways = specs.map(
    (spec, index) =>
      new Gateway({
        host: '127.0.0.1',
        port: 0,
        nodeId: spec.nodeId || `G${index}`,
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

test('gateway: frames round-trip, including split and coalesced chunks', () => {
  // The JSON codec carries arbitrary objects; the protobuf codec has a fixed
  // schema (see unit-gateway-codec.test.js).
  const frames = [
    encodeFrame({ a: 1 }, CODEC.JSON),
    encodeFrame({ b: 'two' }, CODEC.JSON),
    encodeFrame({ c: [1, 2, 3] }, CODEC.JSON),
  ];
  const combined = Buffer.concat(frames);

  const atOnce = new FrameDecoder(4096);
  assert.deepStrictEqual(atOnce.push(combined), [{ a: 1 }, { b: 'two' }, { c: [1, 2, 3] }]);

  const byteByByte = new FrameDecoder(4096);
  const reassembled = [];
  for (const byte of combined) reassembled.push(...byteByByte.push(Buffer.from([byte])));
  assert.deepStrictEqual(reassembled, [{ a: 1 }, { b: 'two' }, { c: [1, 2, 3] }]);
});

test('gateway: oversized frames are rejected', () => {
  const decoder = new FrameDecoder(4);
  assert.throws(() => decoder.push(encodeFrame({ too: 'big' }, CODEC.JSON)), /frame too large/);
});

test('gateway: end-to-end delivery, error propagation and ping', async () => {
  await withGateways(
    [
      { nodeId: 'A', onDeliver: async (targetActorId, payload) => ({ targetActorId, payload, handledBy: 'A' }) },
      {
        nodeId: 'B',
        onDeliver: async () => {
          throw new Error('no such actor');
        },
      },
    ],
    async ([a, b]) => {
      assert.strictEqual(await b.ping('127.0.0.1', a.port), true);

      const result = await b.deliver('127.0.0.1', a.port, 'actor-1', { type: 'x', n: 1 });
      assert.deepStrictEqual(result, { targetActorId: 'actor-1', payload: { type: 'x', n: 1 }, handledBy: 'A' });

      await assert.rejects(() => b.deliver('127.0.0.1', b.port, 'ghost', {}), /no such actor/);
    },
  );
});

test('gateway: an unreachable peer rejects instead of crashing the process', async () => {
  const closedPort = await freePort();
  await withGateways([{ nodeId: 'C' }], async ([gw]) => {
    await assert.rejects(
      () => gw.request('127.0.0.1', closedPort, { kind: 'ping' }, 400),
      /timed out|ECONNREFUSED|connection closed/,
    );
  });
});

test('gateway: multiple requests on one pooled connection are correlated by id', async () => {
  await withGateways(
    [
      {
        nodeId: 'A',
        onDeliver: async (target, payload) => {
          await new Promise((r) => setTimeout(r, payload.delay));
          return payload.n;
        },
      },
      { nodeId: 'B' },
    ],
    async ([a, b]) => {
      const results = await Promise.all([
        b.deliver('127.0.0.1', a.port, 'x', { n: 1, delay: 60 }),
        b.deliver('127.0.0.1', a.port, 'x', { n: 2, delay: 10 }),
        b.deliver('127.0.0.1', a.port, 'x', { n: 3, delay: 30 }),
      ]);
      assert.deepStrictEqual(results, [1, 2, 3]);
      assert.strictEqual(b.pool.size, 1, 'the connection is pooled, not re-dialled per request');
    },
  );
});

test('gateway: closing rejects in-flight requests', async () => {
  const a = new Gateway({
    host: '127.0.0.1',
    port: 0,
    nodeId: 'A',
    onDeliver: async () => {
      await new Promise((r) => setTimeout(r, 500));
      return 'slow';
    },
  });
  const b = new Gateway({ host: '127.0.0.1', port: 0, nodeId: 'B', onDeliver: async () => null });
  try {
    await a.listen();
    await b.listen();
    const pending = b.deliver('127.0.0.1', a.port, 'x', {}, 2000);
    await new Promise((r) => setTimeout(r, 50));
    await b.close();
    await assert.rejects(() => pending, /gateway closing|connection closed/);
  } finally {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }
});

test('gateway: unknown frame kinds get an error response, not silence', async () => {
  await withGateways([{ nodeId: 'A' }], async ([a]) => {
    const res = await a.request('127.0.0.1', a.port, { kind: 'nonsense' }, 1000);
    assert.strictEqual(res.kind, 'error');
    assert.match(res.error, /unknown frame kind/);
  });
});
