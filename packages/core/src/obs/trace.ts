// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const crypto = require('crypto');

/**
 * Distributed-trace context helpers.
 *
 * A context is { traceId, spanId, parentSpanId, sampled }.
 * Span ids are only ever minted on the node that creates the span, so a
 * cluster needs no clock agreement for tracing.
 */
interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sampled: boolean;
}

interface TraceOptions {
  sampleRate?: number;
}

class Trace {
  static genTraceId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /** 追踪上下文（跨节点传播的就是这四个字段）。 */
  static genSpanId() {
    return crypto.randomBytes(8).toString('hex');
  }

  static isValid(ctx: TraceContext | null | undefined): boolean {
    return Boolean(ctx && typeof ctx.traceId === 'string' && typeof ctx.spanId === 'string');
  }

  /**
   * Create a root span, or a child span when a valid parent is supplied.
   * @param {object|null} parentTrace
   * @param {{sampleRate?: number}} [opts]
   */
  static buildContext(parentTrace: TraceContext | null = null, opts: TraceOptions = {}): TraceContext {
    const sampleRate = typeof opts.sampleRate === 'number' ? opts.sampleRate : 1;
    const sampled = parentTrace && typeof parentTrace.sampled === 'boolean'
      ? parentTrace.sampled
      : Math.random() < sampleRate;

    const parent = Trace.isValid(parentTrace) ? (parentTrace as TraceContext) : null;
    if (parent !== null) {
      return {
        traceId: parent.traceId,
        spanId: Trace.genSpanId(),
        parentSpanId: parent.spanId,
        sampled,
      };
    }
    return {
      traceId: Trace.genTraceId(),
      spanId: Trace.genSpanId(),
      parentSpanId: null,
      sampled,
    };
  }

  /** Explicit child span of a parent context. */
  static child(parentTrace: TraceContext | null | undefined, opts: TraceOptions = {}): TraceContext {
    if (!Trace.isValid(parentTrace)) return Trace.buildContext(null, opts);
    return Trace.buildContext(parentTrace, opts);
  }

  static newRoot(opts: TraceOptions = {}): TraceContext {
    return Trace.buildContext(null, opts);
  }

  /** Compact representation for log lines. */
  static format(ctx: TraceContext | null | undefined): string | null {
    if (!Trace.isValid(ctx)) return null;
    const valid = ctx as TraceContext;
    return `${valid.traceId}/${valid.spanId}${valid.parentSpanId ? `<${valid.parentSpanId}` : ''}`;
  }
}

module.exports = Trace;
module.exports.Trace = Trace;
