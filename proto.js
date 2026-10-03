'use strict';

/**
 * Minimal, dependency-free Protocol Buffers wire-format codec.
 *
 * Only what the framework needs: string, bytes, uint64 and bool fields, plus
 * unknown-field skipping so a newer peer can add fields without breaking an
 * older one. The schema lives in code (and is mirrored, for reference, in
 * actor-proto.proto).
 *
 * Wire format: varint tags (fieldNumber << 3 | wireType) followed by the
 * value; length-delimited for strings/bytes.
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH = 2;
const WIRE_32BIT = 5;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function writeVarint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
  if (v < 0n) throw new RangeError('varint value must be non-negative');
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const value = result <= MAX_SAFE ? Number(result) : result;
      return { value, offset: i };
    }
    shift += 7n;
    if (shift > 70n) throw new Error('varint is too long (malformed frame)');
  }
  throw new Error('truncated varint');
}

function tagFor(fieldNumber, wireType) {
  return writeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

function encodeField(field, value) {
  switch (field.type) {
    case 'string': {
      const body = Buffer.from(String(value), 'utf8');
      return Buffer.concat([tagFor(field.no, WIRE_LENGTH), writeVarint(body.length), body]);
    }
    case 'bytes': {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
      return Buffer.concat([tagFor(field.no, WIRE_LENGTH), writeVarint(body.length), body]);
    }
    case 'uint64':
      return Buffer.concat([tagFor(field.no, WIRE_VARINT), writeVarint(value)]);
    case 'bool':
      return Buffer.concat([tagFor(field.no, WIRE_VARINT), writeVarint(value ? 1 : 0)]);
    default:
      throw new Error(`unsupported protobuf field type: ${field.type}`);
  }
}

/**
 * @param {Array<{name:string, no:number, type:string}>} schema
 * @param {object} obj
 */
function encodeMessage(schema, obj) {
  const parts = [];
  for (const field of schema) {
    const value = obj[field.name];
    if (value === undefined || value === null) continue; // proto3 default: omit
    parts.push(encodeField(field, value));
  }
  return Buffer.concat(parts);
}

function skipField(buf, offset, wireType) {
  switch (wireType) {
    case WIRE_VARINT: {
      const { offset: next } = readVarint(buf, offset);
      return next;
    }
    case WIRE_64BIT:
      return offset + 8;
    case WIRE_LENGTH: {
      const { value: len, offset: afterLen } = readVarint(buf, offset);
      return afterLen + Number(len);
    }
    case WIRE_32BIT:
      return offset + 4;
    default:
      throw new Error(`unsupported protobuf wire type: ${wireType}`);
  }
}

/**
 * Decode a message. Unknown field numbers are skipped, so the schema can grow
 * without breaking older peers.
 * @returns {object} only the fields present on the wire
 */
function decodeMessage(schema, buf) {
  const byNumber = new Map(schema.map((f) => [f.no, f]));
  const out = {};
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.offset;
    const fieldNumber = Number(BigInt(tag.value) >> 3n);
    const wireType = Number(BigInt(tag.value) & 0x7n);
    const field = byNumber.get(fieldNumber);

    if (!field) {
      offset = skipField(buf, offset, wireType);
      continue;
    }

    switch (field.type) {
      case 'string':
      case 'bytes': {
        if (wireType !== WIRE_LENGTH) throw new Error(`field ${field.name} must be length-delimited`);
        const { value: len, offset: afterLen } = readVarint(buf, offset);
        const end = afterLen + Number(len);
        if (end > buf.length) throw new Error(`field ${field.name} is truncated`);
        const slice = buf.subarray(afterLen, end);
        out[field.name] = field.type === 'string' ? slice.toString('utf8') : Buffer.from(slice);
        offset = end;
        break;
      }
      case 'uint64': {
        if (wireType !== WIRE_VARINT) throw new Error(`field ${field.name} must be a varint`);
        const { value, offset: next } = readVarint(buf, offset);
        out[field.name] = value;
        offset = next;
        break;
      }
      case 'bool': {
        if (wireType !== WIRE_VARINT) throw new Error(`field ${field.name} must be a varint`);
        const { value, offset: next } = readVarint(buf, offset);
        out[field.name] = value !== 0 && value !== 0n;
        offset = next;
        break;
      }
      default:
        offset = skipField(buf, offset, wireType);
    }
  }
  return out;
}

// --- gateway frame schema (mirrors actor-proto.proto) ----------------------

const GATEWAY_FRAME_SCHEMA = [
  { name: 'kind', no: 1, type: 'string' },
  { name: 'id', no: 2, type: 'string' },
  { name: 'nodeId', no: 3, type: 'string' },
  { name: 'ts', no: 4, type: 'uint64' },
  { name: 'targetActorId', no: 5, type: 'string' },
  { name: 'payloadJson', no: 6, type: 'bytes' },
  { name: 'ok', no: 7, type: 'bool' },
  { name: 'error', no: 8, type: 'string' },
  { name: 'dataJson', no: 9, type: 'bytes' },
];

function toJsonBytes(value) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined) return undefined; // e.g. a bare function/undefined
  return Buffer.from(text, 'utf8');
}

function fromJsonBytes(value) {
  if (value === undefined || value === null) return undefined;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  if (text === '') return undefined;
  return JSON.parse(text);
}

/** Encode a gateway frame (payload/data become embedded JSON bytes). */
function encodeGatewayFrame(frame) {
  return encodeMessage(GATEWAY_FRAME_SCHEMA, {
    kind: frame.kind,
    id: frame.id,
    nodeId: frame.nodeId,
    ts: frame.ts,
    targetActorId: frame.targetActorId,
    payloadJson: toJsonBytes(frame.payload),
    ok: frame.ok,
    error: frame.error,
    dataJson: toJsonBytes(frame.data),
  });
}

/** Decode a gateway frame back into the plain-object form the gateway uses. */
function decodeGatewayFrame(buf) {
  const wire = decodeMessage(GATEWAY_FRAME_SCHEMA, buf);
  const frame = {};
  if (wire.kind !== undefined) frame.kind = wire.kind;
  if (wire.id !== undefined) frame.id = wire.id;
  if (wire.nodeId !== undefined) frame.nodeId = wire.nodeId;
  if (wire.ts !== undefined) frame.ts = wire.ts;
  if (wire.targetActorId !== undefined) frame.targetActorId = wire.targetActorId;
  if (wire.ok !== undefined) frame.ok = wire.ok;
  if (wire.error !== undefined) frame.error = wire.error;
  try {
    const payload = fromJsonBytes(wire.payloadJson);
    if (payload !== undefined) frame.payload = payload;
    const data = fromJsonBytes(wire.dataJson);
    if (data !== undefined) frame.data = data;
  } catch (err) {
    throw new Error(`gateway frame carries invalid JSON: ${err.message}`);
  }
  return frame;
}

module.exports = {
  WIRE_VARINT,
  WIRE_LENGTH,
  writeVarint,
  readVarint,
  encodeMessage,
  decodeMessage,
  skipField,
  GATEWAY_FRAME_SCHEMA,
  encodeGatewayFrame,
  decodeGatewayFrame,
};
