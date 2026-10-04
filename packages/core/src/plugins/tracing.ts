'use strict';

const Trace = require('../obs/trace.ts');

/**
 * Tracing plugin: gives every message a distributed-trace context and nests
 * spans across actor hops, including `ctx.ask` chains and worker-isolated
 * actors.
 *
 * Without this plugin no trace context is created at all, so the actor hot
 * path pays nothing.
 */
function tracing(options = {}) {
  const sampleRate = typeof options.sampleRate === 'number' ? options.sampleRate : 1;

  return {
    name: 'tracing',

    setup(system) {
      system.tracer = {
        sampleRate,
        buildContext: (parent) => Trace.buildContext(parent, { sampleRate }),
        child: (parent) => Trace.child(parent, { sampleRate }),
        format: Trace.format,
      };
      system.traceContext = () => Trace.newRoot({ sampleRate });
    },

    teardown(system) {
      if (system) system.tracer = null;
    },
  };
}

module.exports = tracing;
module.exports.tracing = tracing;
