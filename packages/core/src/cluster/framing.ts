'use strict';

/**
 * Shared frame framing for the binary transports (gateway and gossip).
 *
 * Frame layout, identical for every transport:
 *
 *   uint32_be bodyLength | uint8 codec | body
 *
 * codec 0 = JSON      (utf-8, handy for packet capture and debugging)
 * codec 1 = Protobuf  (see proto.js; the default)
 *
 * The codec byte travels with each frame, so a peer always accepts both
 * encodings and mixed deployments interoperate without negotiation. The
 * protobuf codec is injected per transport because each one has its own
 * message type.
 */

const CODEC = { JSON: 0, PROTOBUF: 1 };
const HEADER_BYTES = 5;

const CODEC_NAME = { [CODEC.JSON]: 'json', [CODEC.PROTOBUF]: 'proto' };

function codecFromName(name) {
  return String(name).toLowerCase() === 'json' ? CODEC.JSON : CODEC.PROTOBUF;
}

/**
 * @param {{protoEncode: (obj:object)=>Buffer, protoDecode: (buf:Buffer)=>object}} codecs
 */
function createFraming(codecs) {
  function encode(obj, codec = CODEC.PROTOBUF) {
    if (codec !== CODEC.JSON && codec !== CODEC.PROTOBUF) {
      throw new TypeError(`unknown frame codec: ${codec} (use CODEC.JSON or CODEC.PROTOBUF)`);
    }
    const body = codec === CODEC.JSON
      ? Buffer.from(JSON.stringify(obj), 'utf8')
      : codecs.protoEncode(obj);
    const head = Buffer.allocUnsafe(HEADER_BYTES);
    head.writeUInt32BE(body.length, 0);
    head.writeUInt8(codec, 4);
    return Buffer.concat([head, body]);
  }

  function decode(codec, body) {
    if (codec === CODEC.JSON) return JSON.parse(body.toString('utf8'));
    if (codec === CODEC.PROTOBUF) return codecs.protoDecode(body);
    throw new Error(`unknown frame codec: ${codec}`);
  }

  class FrameDecoder {
    constructor(maxFrameBytes) {
      this.buf = Buffer.alloc(0);
      this.max = maxFrameBytes;
    }

    push(chunk) {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      const frames = [];
      while (this.buf.length >= HEADER_BYTES) {
        const len = this.buf.readUInt32BE(0);
        if (len > this.max) throw new Error(`frame too large: ${len} > ${this.max}`);
        if (this.buf.length < HEADER_BYTES + len) break;
        const codec = this.buf.readUInt8(4);
        const body = this.buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
        frames.push(decode(codec, body));
        this.buf = this.buf.subarray(HEADER_BYTES + len);
      }
      return frames;
    }
  }

  return { encode, decode, FrameDecoder };
}

module.exports = {
  CODEC,
  CODEC_NAME,
  HEADER_BYTES,
  codecFromName,
  createFraming,
};
