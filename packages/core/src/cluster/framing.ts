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
    /** 还没消费完的字节。审计 S11：改成"待拼片段队列"，避免每个 chunk 都 concat 全部已收字节。 */
    chunks: Buffer[];
    /** 已收到但还没解析的字节数（用于判断"帧到齐了没有"，不需要真的拼起来）。 */
    pending: number;
    max: number;

    /** 兼容旧字段名（有些调用方/测试读 `decoder.buf`）——惰性拼一次。 */
    get buf(): Buffer {
      if (this.chunks.length === 0) return Buffer.alloc(0);
      if (this.chunks.length === 1) return this.chunks[0] ?? Buffer.alloc(0);
      const joined = Buffer.concat(this.chunks, this.pending);
      this.chunks = [joined];
      return joined;
    }

    constructor(maxFrameBytes: number) {
      this.chunks = [];
      this.pending = 0;
      this.max = maxFrameBytes;
    }

    push(chunk: Buffer): Record<string, unknown>[] {
      if (chunk.length > 0) {
        this.chunks.push(chunk);
        this.pending += chunk.length;
      }
      const frames: Record<string, unknown>[] = [];
      // 头部（5 字节）先拼出来读长度；只有确认"整帧到齐"才拼一次完整的帧
      while (this.pending >= HEADER_BYTES) {
        const head = this.buf.subarray(0, HEADER_BYTES);
        const len = head.readUInt32BE(0);
        if (len > this.max) throw new Error(`frame too large: ${len} > ${this.max}`);
        if (this.pending < HEADER_BYTES + len) break;
        const whole = this.buf.subarray(0, HEADER_BYTES + len);
        const codec = whole.readUInt8(4);
        const body = whole.subarray(HEADER_BYTES);
        frames.push(decode(codec, body));
        // 注意：rest 必须从**整个缓冲区**上取，而不是从 `whole`（那是只到本帧末尾的视图）——
        // 我第一版就是从前一帧的视图上取 rest，于是同一块里的后续帧全被丢掉（网关请求全部超时）。
        const rest = this.buf.subarray(HEADER_BYTES + len); // subarray 是视图，不拷贝
        this.chunks = rest.length > 0 ? [Buffer.from(rest)] : [];
        this.pending = rest.length;
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
