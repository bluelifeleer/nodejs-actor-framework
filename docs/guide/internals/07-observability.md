# 7. 可观测性（追踪导出 / 日志适配 / 指标）

## 追踪：span 生命周期 + OTLP 真实导出

内核在**处理每条消息**的边界上开一个 span（名字是 `actorPath:messageType`，属性带 actor 路径、
消息类型、结果与错误），结束时交给 `system.spanSink`。没装 sink 就没有 span 开销。

`plugins.otlp()` 就是一个 sink：按 OTLP/HTTP+JSON **真实导出**到任何 OTLP 收集器
（Collector / Jaeger / Tempo…），**零依赖**（协议是公开的，自己发一个 JSON 请求即可）：

```ts
import { createSystem, plugins } from 'nodejs-actor-framework';

const exporter = plugins.otlp({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318',
  serviceName: 'checkout',
  resource: { 'deployment.environment': 'prod' },
  maxBatch: 512,
  flushIntervalMs: 5000,
});
const system = createSystem({ plugins: [exporter] });
```

三条约定：**批量 + 定时 flush**（定时器走系统时钟，测试里可瞬时推进）、
**失败可见**（`otlp_export_failed` 日志 + `exporter.stats()` 的 `failed/dropped` 计数，绝不静默丢 span）、
**停机关闭**（teardown 时 flush 一次）。

想接官方 SDK？把 `system.spanSink` 换成你自己的 `{ onSpan(span) }` 就行——内核只认这个结构。

## 日志：内核是"一个函数"，适配器负责桥接

内核的日志接缝刻意是**一个函数**：`createSystem({ logger: (event, meta) => void })`。零依赖、零约定，
代价是用户要自己写桥。`createLogAdapter()` 就是那座桥：

```ts
import { createLogAdapter, createSystem } from 'nodejs-actor-framework';
import pino from 'pino';

const logger = pino();
const system = createSystem({
  logger: createLogAdapter(logger),           // 级别按事件名猜：*_failed / *_error → warn
  // logger: createLogAdapter(logger, { level: () => 'info', message: (event, meta) => `${event} ${JSON.stringify(meta)}` }),
});
```

每条日志也**同时以事件形式**发出（`system.on('log', (event, meta) => …)`），测试里断言日志最方便——
不用假装成日志器。

## 这一条示例会被测试执行：span 真的导出成 OTLP 形状

```js verify
import assert from 'node:assert';
import http from 'node:http';
import { createLogAdapter, createSystem, plugins } from 'nodejs-actor-framework';

// 最小 OTLP 收集器（真实 HTTP，不是 mock）
const received = [];
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    received.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const exporter = plugins.otlp({
  endpoint: `http://127.0.0.1:${server.address().port}`,
  flushIntervalMs: 0, // 手动 flush，测试里不用等定时器
  serviceName: 'demo-service',
});
const system = createSystem({ logger: false, plugins: [exporter] });
try {
  const ref = await system.spawn({ preStart() {}, receive: () => 'ok' }, { id: 'orders' });
  await ref.ask({ type: 'place' });
  await new Promise((resolve) => setImmediate(resolve)); // span 在处理结束后才交给 sink
  await exporter.flush();

  const span = received[0].resourceSpans[0].scopeSpans[0].spans[0];
  assert.strictEqual(span.name, 'orders:place');
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.startTimeUnixNano, /^\d+$/);
  const attributes = Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
  assert.strictEqual(attributes['actor.path'], 'orders');
  assert.strictEqual(span.status.code, 1);

  // 日志适配器：把对象日志器接到内核的 (event, meta) 函数接口
  const lines = [];
  const logger = createLogAdapter({ info: (line) => lines.push(line), warn: (line) => lines.push(line) });
  logger('cache_miss', { key: 'a' });
  logger('export_failed', { err: 'boom' });
  assert.match(lines[0], /cache_miss/);
  assert.strictEqual(lines.length, 2);
} finally {
  await system.stop();
  await new Promise((resolve) => server.close(resolve));
}
console.log('ok');
```

## 指标

`metricsPlugin()` 暴露计数器（Actor 数、消息数、延迟、错误…），应用层可以直接接 Prometheus 文本格式
或任何抓取器。见 [`examples/app-data`](../../examples/app-data/README.md)。
