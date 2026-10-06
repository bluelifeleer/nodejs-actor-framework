// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * OTLP/HTTP 导出（M5 第 4 步）：把内核的 span **真实导出**到 OTLP 兼容的收集器。
 *
 * 为什么自己写而不引 `@opentelemetry/*`：这个仓库的内核是零依赖的，而 OTLP/HTTP+JSON 是一个
 * **公开协议**（`POST <endpoint>/v1/traces`，body 形如 `{ resourceSpans: [...] }`）。自己发一个
 * JSON 请求就能接上任何 OTLP 收集器（Jaeger/Tempo/Collector/…），不需要 SDK。
 * 想用官方 SDK？把 `system.spanSink` 换成你自己的 `{ onSpan }` 即可——内核只认这个结构。
 *
 * 三条行为约定：
 *   - **批量 + 定时 flush**：默认最多 512 条或 5 秒一次（用系统时钟，虚拟时钟下可瞬时推进）；
 *   - **失败要可见**：导出失败记 `otlp_export_failed` 日志并计数，绝不静默丢 span；
 *   - **停机关闭**：teardown 时 flush 一次（尽量把已经产生的 span 发出去）。
 */

const { randomBytes } = require('node:crypto');

/** span → OTLP JSON 的一条 span。 */
function toOtlpSpan(span) {
  const attributes = Object.entries(span.attributes || {}).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? Number.isInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: String(value) },
  }));

  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL：Actor 处理一条消息
    startTimeUnixNano: String(Math.round(span.startTimeMs * 1e6)),
    endTimeUnixNano: String(Math.round(span.endTimeMs * 1e6)),
    attributes,
    status: span.status === 'error' ? { code: 2, message: String(span.attributes['error.message'] || 'error') } : { code: 1 },
  };
}

function otlp(options = {}) {
  const endpoint = String(options.endpoint || 'http://127.0.0.1:4318').replace(/\/+$/, '');
  const serviceName = String(options.serviceName || 'actor-framework');
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  const maxBatch = Number.isInteger(options.maxBatch) ? options.maxBatch : 512;
  const flushIntervalMs = Number.isFinite(options.flushIntervalMs) ? options.flushIntervalMs : 5000;
  const fetchImpl = options.fetch || globalThis.fetch;

  let buffer = [];
  let timer = null;
  const stats = { exported: 0, failed: 0, batches: 0, dropped: 0, lastError: null };
  let system = null;
  let flushing = null;

  const body = (spans) => ({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
            ...Object.entries(options.resource || {}).map(([key, value]) => ({
              key,
              value: { stringValue: String(value) },
            })),
          ],
        },
        scopeSpans: [{ scope: { name: 'nodejs-actor-framework' }, spans: spans.map(toOtlpSpan) }],
      },
    ],
  });

  const flush = async () => {
    if (buffer.length === 0) return { sent: 0 };
    if (flushing !== null) return flushing;
    const batch = buffer;
    buffer = [];
    stats.batches += 1;
    flushing = (async () => {
      try {
        const response = await fetchImpl(`${endpoint}/v1/traces`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body(batch)),
        });
        if (!response || response.ok !== true) {
          throw new Error(`HTTP ${response ? response.status : 'no response'}`);
        }
        stats.exported += batch.length;
        return { sent: batch.length };
      } catch (err) {
        // 失败要可见：计数 + 日志（span 已经出队，不重试——重试策略交给收集器/代理）
        stats.failed += 1;
        stats.dropped += batch.length;
        stats.lastError = err && err.message ? err.message : String(err);
        if (system) system._log('otlp_export_failed', { endpoint, err: stats.lastError, spans: batch.length });
        return { sent: 0, error: stats.lastError };
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  };

  return {
    name: 'otlp',

    setup(target) {
      system = target;
      // 作为 spanSink 接上：内核只在装了 sink 时才创建 span（热路径零开销）
      target.spanSink = {
        onSpan(span) {
          if (!span.sampled) return;
          buffer.push(span);
          if (buffer.length >= maxBatch) void flush();
        },
      };
      if (flushIntervalMs > 0) {
        timer = target.clock.setInterval(() => void flush(), flushIntervalMs, { unref: true });
      }
    },

    async teardown(target) {
      if (timer !== null && target && target.clock) target.clock.clearInterval(timer);
      timer = null;
      await flush(); // 关机前尽量把已产生的 span 发出去
      if (target) target.spanSink = null;
      system = null;
    },

    /** 手动 flush（测试与脚本用）。 */
    flush,
    /** 导出统计（诊断用：导出了多少、失败多少、丢了多少）。 */
    stats: () => ({ ...stats, buffered: buffer.length }),
    /** endpoint（诊断用）。 */
    endpoint,
  };
}

module.exports = otlp;
module.exports.otlp = otlp;
module.exports.toOtlpSpan = toOtlpSpan;
