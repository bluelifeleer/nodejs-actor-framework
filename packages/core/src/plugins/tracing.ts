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
/** 插件配置。 */
interface TracingOptions {
  sampleRate?: number;
}

/** 结构型 system 视图（见 rate-limit.ts 的说明）。 */
interface TracingSystem {
  tracer: unknown;
  traceContext: (() => unknown) | null;
}

function tracing(options: TracingOptions = {}) {
  const sampleRate = typeof options.sampleRate === 'number' ? options.sampleRate : 1;

  return {
    name: 'tracing',

    setup(system: TracingSystem) {
      system.tracer = {
        sampleRate,
        buildContext: (parent: unknown) => Trace.buildContext(parent, { sampleRate }),
        child: (parent: unknown) => Trace.child(parent, { sampleRate }),
        format: Trace.format,
      };
      system.traceContext = () => Trace.newRoot({ sampleRate });
    },

    teardown(system: TracingSystem | null) {
      if (system) system.tracer = null;
    },
  };
}

module.exports = tracing;
module.exports.tracing = tracing;
