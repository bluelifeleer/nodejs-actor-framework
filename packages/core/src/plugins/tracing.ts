// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
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
