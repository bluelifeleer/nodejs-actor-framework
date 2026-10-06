// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
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

const CODEC = { JSON: 0, PROTOBUF: 1 } as const;
const HEADER_BYTES = 5;

const CODEC_NAME: Record<number, string> = { [CODEC.JSON]: 'json', [CODEC.PROTOBUF]: 'proto' };

/** 帧编码通道：0 = JSON（诊断/互操作），1 = protobuf（默认，带宽小）。 */
type Codec = 0 | 1;

function codecFromName(name: string): Codec {
  return String(name).toLowerCase() === 'json' ? CODEC.JSON : CODEC.PROTOBUF;
}

/** 编解码实现（protobuf 由 proto.ts 提供，测试里可以换成假的）。 */
interface FramingCodecs {
  protoEncode(obj: Record<string, unknown>): Buffer;
  protoDecode(buf: Buffer): Record<string, unknown>;
}

function createFraming(codecs: FramingCodecs) {
  function encode(obj: Record<string, unknown>, codec: Codec = CODEC.PROTOBUF): Buffer {
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

  function decode(codec: number, body: Buffer): Record<string, unknown> {
    if (codec === CODEC.JSON) return JSON.parse(body.toString('utf8'));
    if (codec === CODEC.PROTOBUF) return codecs.protoDecode(body);
    throw new Error(`unknown frame codec: ${codec}`);
  }

  class FrameDecoder {
    buf: Buffer;
    max: number;

    constructor(maxFrameBytes: number) {
      this.buf = Buffer.alloc(0);
      this.max = maxFrameBytes;
    }

    push(chunk: Buffer): Record<string, unknown>[] {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      const frames: Record<string, unknown>[] = [];
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
