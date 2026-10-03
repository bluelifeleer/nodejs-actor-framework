'use strict';

const crypto = require('crypto');

/**
 * Distributed-trace context helpers.
 *
 * A context is { traceId, spanId, parentSpanId, sampled }.
 * Span ids are only ever minted on the node that creates the span, so a
 * cluster needs no clock agreement for tracing.
 */
class Trace {
  static genTraceId() {
    return crypto.randomBytes(16).toString('hex');
  }

  static genSpanId() {
    return crypto.randomBytes(8).toString('hex');
  }

  static isValid(ctx) {
    return Boolean(ctx && typeof ctx.traceId === 'string' && typeof ctx.spanId === 'string');
  }

  /**
   * Create a root span, or a child span when a valid parent is supplied.
   * @param {object|null} parentTrace
   * @param {{sampleRate?: number}} [opts]
   */
  static buildContext(parentTrace = null, opts = {}) {
    const sampleRate = typeof opts.sampleRate === 'number' ? opts.sampleRate : 1;
    const sampled = parentTrace && typeof parentTrace.sampled === 'boolean'
      ? parentTrace.sampled
      : Math.random() < sampleRate;

    if (Trace.isValid(parentTrace)) {
      return {
        traceId: parentTrace.traceId,
        spanId: Trace.genSpanId(),
        parentSpanId: parentTrace.spanId,
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
  static child(parentTrace, opts) {
    if (!Trace.isValid(parentTrace)) return Trace.buildContext(null, opts);
    return Trace.buildContext(parentTrace, opts);
  }

  static newRoot(opts) {
    return Trace.buildContext(null, opts);
  }

  /** Compact representation for log lines. */
  static format(ctx) {
    if (!Trace.isValid(ctx)) return null;
    return `${ctx.traceId}/${ctx.spanId}${ctx.parentSpanId ? `<${ctx.parentSpanId}` : ''}`;
  }
}

module.exports = Trace;
module.exports.Trace = Trace;
