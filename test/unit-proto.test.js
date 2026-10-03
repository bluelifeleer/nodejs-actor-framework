'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setupTempEnv, cleanup } = require('./helpers');

const tempDir = setupTempEnv('actor-proto');

const {
  writeVarint,
  readVarint,
  encodeMessage,
  decodeMessage,
  encodeGatewayFrame,
  decodeGatewayFrame,
  GATEWAY_FRAME_SCHEMA,
} = require('../proto');
const { crc32 } = require('../stores/crc32');

test.after(() => cleanup(tempDir));

test('crc32 matches the standard check vector', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.strictEqual(crc32(Buffer.alloc(0)), 0);
});

test('varint round-trips all the sizes the framework uses', () => {
  const values = [0, 1, 127, 128, 300, 16383, 16384, 2097151, 2097152, Date.now(), 2 ** 40];
  for (const value of values) {
    const buf = writeVarint(value);
    const { value: decoded, offset } = readVarint(buf, 0);
    assert.strictEqual(decoded, value, `round trip failed for ${value}`);
    assert.strictEqual(offset, buf.length);
  }
});

test('varint rejects negatives and detects truncation', () => {
  assert.throws(() => writeVarint(-1), RangeError);
  assert.throws(() => readVarint(Buffer.from([0x80, 0x80]), 0), /truncated varint/);
  assert.throws(() => readVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]), 0), /too long/);
});

test('message codec round-trips strings, bytes, uint64 and bool', () => {
  const schema = [
    { name: 'name', no: 1, type: 'string' },
    { name: 'blob', no: 2, type: 'bytes' },
    { name: 'count', no: 3, type: 'uint64' },
    { name: 'flag', no: 4, type: 'bool' },
  ];
  const encoded = encodeMessage(schema, {
    name: 'actor-1',
    blob: Buffer.from([1, 2, 3]),
    count: 1234567890123,
    flag: true,
  });
  const decoded = decodeMessage(schema, encoded);
  assert.strictEqual(decoded.name, 'actor-1');
  assert.deepStrictEqual(decoded.blob, Buffer.from([1, 2, 3]));
  assert.strictEqual(decoded.count, 1234567890123);
  assert.strictEqual(decoded.flag, true);
});

test('absent fields are omitted, and false is still transmitted', () => {
  const schema = [
    { name: 'a', no: 1, type: 'string' },
    { name: 'ok', no: 2, type: 'bool' },
  ];
  const encoded = encodeMessage(schema, { a: 'x', ok: false });
  const decoded = decodeMessage(schema, encoded);
  assert.strictEqual(decoded.a, 'x');
  assert.strictEqual(decoded.ok, false);

  const empty = decodeMessage(schema, encodeMessage(schema, { a: null, ok: undefined }));
  assert.deepStrictEqual(empty, {});
});

test('unknown fields are skipped, so the schema can grow safely', () => {
  const extended = [...GATEWAY_FRAME_SCHEMA, { name: 'futureField', no: 77, type: 'string' }];
  const buf = encodeMessage(extended, {
    kind: 'ping',
    id: 'abc',
    futureField: 'from a newer peer',
  });
  const decoded = decodeGatewayFrame(buf); // old schema must ignore field 77
  assert.strictEqual(decoded.kind, 'ping');
  assert.strictEqual(decoded.id, 'abc');
  assert.strictEqual(decoded.futureField, undefined);
});

test('gateway frames round-trip payload and reply data', () => {
  const frame = {
    kind: 'deliver',
    id: 'req-1',
    nodeId: 'node-1',
    targetActorId: 'player_001',
    payload: { type: 'hurt', damage: 5, priority: 0, trace: { traceId: 't', spanId: 's' } },
  };
  assert.deepStrictEqual(decodeGatewayFrame(encodeGatewayFrame(frame)), frame);

  const result = { kind: 'result', id: 'req-1', ok: false, error: 'actor not found' };
  assert.deepStrictEqual(decodeGatewayFrame(encodeGatewayFrame(result)), result);

  const withData = { kind: 'result', id: 'r', ok: true, data: { hp: 95 } };
  assert.deepStrictEqual(decodeGatewayFrame(encodeGatewayFrame(withData)), withData);
});

test('a frame without payload or data decodes without those keys', () => {
  const decoded = decodeGatewayFrame(encodeGatewayFrame({ kind: 'pong', nodeId: 'n', ts: 42 }));
  assert.strictEqual(decoded.kind, 'pong');
  assert.strictEqual(decoded.ts, 42);
  assert.strictEqual('payload' in decoded, false);
  assert.strictEqual('data' in decoded, false);
});

test('a protobuf frame is materially smaller than the JSON equivalent', () => {
  const frame = {
    kind: 'deliver',
    id: 'e0a1b2c3-d4e5-f6a7-8899-aabbccddeeff',
    nodeId: 'node-1',
    targetActorId: 'player_001',
    payload: { type: 'hurt', damage: 5 },
  };
  const protoBytes = encodeGatewayFrame(frame).length;
  const jsonBytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  assert.ok(protoBytes < jsonBytes, `expected protobuf (${protoBytes}) < json (${jsonBytes})`);
});

test('malformed frames are rejected with a clear error', () => {
  // 0x80 sets the varint continuation bit with no following byte.
  assert.throws(() => decodeGatewayFrame(Buffer.from([0x80])), /truncated varint/);
  // A tag that declares a varint for a string field must be refused.
  assert.throws(() => decodeGatewayFrame(Buffer.from([0x08, 0x01])), /must be length-delimited/);

  const bad = encodeMessage([{ name: 'payloadJson', no: 6, type: 'bytes' }], {
    payloadJson: Buffer.from('{not json'),
  });
  assert.throws(() => decodeGatewayFrame(bad), /invalid JSON/);
});
