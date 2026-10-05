// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
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
  // 10-12 were added so a remote call keeps the semantics of a local one:
  // the caller's timeout, who is asking, and the trace chain.
  { name: 'timeoutMs', no: 10, type: 'uint64' },
  { name: 'senderPath', no: 11, type: 'string' },
  { name: 'traceJson', no: 12, type: 'bytes' },
  // 13-14: the sender's own gateway address, so the receiver can reply to a
  // remote sender without waiting for gossip to learn about it.
  { name: 'senderHost', no: 13, type: 'string' },
  { name: 'senderPort', no: 14, type: 'uint64' },
  // 15: fencing token 的"第几代"。**可选**：老节点不写它，新解码器读不到就当作"没有 token"
  // （见 docs/design/m4-cluster-governance.md §3.4：软升级是默认策略）。
  { name: 'shardEpoch', no: 15, type: 'uint64' },
  // 16-17: hello 的能力与分片数。caps 用 JSON bytes（数组；不引入 repeated 支持，
  // 与 payload/trace/registry 的做法一致）。**注意**：任何新字段都必须在这里登记，
  // 否则 protobuf 路径会静默丢掉它（JSON 路径照带）——我自己就踩过这个坑。
  { name: 'capsJson', no: 16, type: 'bytes' },
  { name: 'shardCount', no: 17, type: 'uint64' },
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
    timeoutMs: frame.timeoutMs,
    senderPath: frame.senderPath,
    traceJson: toJsonBytes(frame.trace),
    senderHost: frame.senderHost,
    senderPort: frame.senderPort,
    shardEpoch: frame.shardEpoch,
    capsJson: toJsonBytes(frame.caps),
    shardCount: frame.shardCount,
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
  if (wire.timeoutMs !== undefined) frame.timeoutMs = wire.timeoutMs;
  if (wire.senderPath !== undefined) frame.senderPath = wire.senderPath;
  if (wire.senderHost !== undefined) frame.senderHost = wire.senderHost;
  if (wire.senderPort !== undefined) frame.senderPort = wire.senderPort;
  if (wire.shardEpoch !== undefined) frame.shardEpoch = wire.shardEpoch;
  if (wire.shardCount !== undefined) frame.shardCount = wire.shardCount;
  try {
    const payload = fromJsonBytes(wire.payloadJson);
    if (payload !== undefined) frame.payload = payload;
    const data = fromJsonBytes(wire.dataJson);
    if (data !== undefined) frame.data = data;
    const trace = fromJsonBytes(wire.traceJson);
    if (trace !== undefined) frame.trace = trace;
    const caps = fromJsonBytes(wire.capsJson);
    if (caps !== undefined) frame.caps = caps;
  } catch (err) {
    throw new Error(`gateway frame carries invalid JSON: ${err.message}`);
  }
  return frame;
}

// --- gossip envelope schema (mirrors actor-proto.proto) --------------------
//
// The envelope is typed; the replicated registry map stays JSON bytes because
// its values are heterogeneous (actor metadata and subscription sets).

const GOSSIP_ENVELOPE_SCHEMA = [
  { name: 'type', no: 1, type: 'string' },
  { name: 'sender', no: 2, type: 'string' },
  { name: 'advertiseHost', no: 3, type: 'string' },
  { name: 'port', no: 4, type: 'uint64' },
  { name: 'dataJson', no: 5, type: 'bytes' },
];

function encodeGossipEnvelope(envelope) {
  return encodeMessage(GOSSIP_ENVELOPE_SCHEMA, {
    type: envelope.type,
    sender: envelope.sender,
    advertiseHost: envelope.advertiseHost,
    port: envelope.port,
    dataJson: toJsonBytes(envelope.data),
  });
}

function decodeGossipEnvelope(buf) {
  const wire = decodeMessage(GOSSIP_ENVELOPE_SCHEMA, buf);
  const envelope = {};
  if (wire.type !== undefined) envelope.type = wire.type;
  if (wire.sender !== undefined) envelope.sender = wire.sender;
  if (wire.advertiseHost !== undefined) envelope.advertiseHost = wire.advertiseHost;
  if (wire.port !== undefined) envelope.port = wire.port;
  try {
    const data = fromJsonBytes(wire.dataJson);
    if (data !== undefined) envelope.data = data;
  } catch (err) {
    throw new Error(`gossip envelope carries invalid JSON: ${err.message}`);
  }
  return envelope;
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
  GOSSIP_ENVELOPE_SCHEMA,
  encodeGossipEnvelope,
  decodeGossipEnvelope,
};
