'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createSystem, plugins } = require('../src/index.ts');

/**
 * OTLP 导出：**协议级**验证（真 HTTP 收集器，不是 mock）。
 *
 * 断言的是"发出去的 body 长什么样"——因为对接的是外部系统，形状错了收集器就是收不下，
 * 而这类错误在单元测试里最容易被放过。
 */

/** 起一个最小的 OTLP 收集器，记录收到的请求。 */
async function withCollector(run) {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await run({ port, received });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('otlp: span 按 OTLP/HTTP JSON 真实导出（收集器收到正确形状）', async () => {
  await withCollector(async ({ port, received }) => {
    const exporter = plugins.otlp({
      endpoint: `http://127.0.0.1:${port}`,
      flushIntervalMs: 0, // 测试里手动 flush
      serviceName: 'checkout',
      resource: { 'deployment.environment': 'test' },
    });
    const system = createSystem({ logger: false, plugins: [exporter] });
    try {
      const ref = await system.spawn(
        { preStart() {}, receive: (msg) => (msg.type === 'boom' ? Promise.reject(new Error('故意的')) : 'ok') },
        { id: 'payments' },
      );
      await ref.ask({ type: 'charge' });
      await assert.rejects(() => ref.ask({ type: 'boom' }), /故意的/);

      // span 是在"处理结束"时才交给 sink 的：失败的 ask 会先拒绝、再走完 finally，
      // 所以断言前要让事件循环走完一格（否则会看到只导出了第一个 span）
      await new Promise((resolve) => setImmediate(resolve));
      const result = await exporter.flush();
      assert.strictEqual(result.sent, 2, '两条消息各产生一个 span');

      assert.strictEqual(received.length, 1, '一次 flush 发一个请求');
      assert.strictEqual(received[0].url, '/v1/traces', 'OTLP/HTTP 的路径是 /v1/traces');
      assert.match(received[0].headers['content-type'], /application\/json/);

      const payload = received[0].body;
      const resourceSpans = payload.resourceSpans;
      assert.strictEqual(resourceSpans.length, 1);
      const resourceAttrs = Object.fromEntries(
        resourceSpans[0].resource.attributes.map((attr) => [attr.key, Object.values(attr.value)[0]]),
      );
      assert.strictEqual(resourceAttrs['service.name'], 'checkout');
      assert.strictEqual(resourceAttrs['deployment.environment'], 'test');

      const spans = resourceSpans[0].scopeSpans[0].spans;
      assert.strictEqual(spans.length, 2);
      assert.strictEqual(spans[0].name, 'payments:charge');
      assert.match(spans[0].traceId, /^[0-9a-f]{32}$/, 'traceId 是 32 位十六进制');
      assert.match(spans[0].spanId, /^[0-9a-f]{16}$/, 'spanId 是 16 位十六进制');
      assert.match(spans[0].startTimeUnixNano, /^\d+$/, '时间是纳秒字符串（OTLP 要求）');
      assert.ok(Number(spans[0].endTimeUnixNano) >= Number(spans[0].startTimeUnixNano));
      const spanAttrs = Object.fromEntries(spans[0].attributes.map((attr) => [attr.key, Object.values(attr.value)[0]]));
      assert.strictEqual(spanAttrs['actor.path'], 'payments');
      assert.strictEqual(spanAttrs['actor.message_type'], 'charge');
      assert.strictEqual(spans[0].status.code, 1, '成功的 span status.code = 1');

      // 失败的那条：status.code = 2 且带错误属性
      const failed = spans[1];
      assert.strictEqual(failed.status.code, 2);
      const failedAttrs = Object.fromEntries(failed.attributes.map((attr) => [attr.key, Object.values(attr.value)[0]]));
      assert.strictEqual(failedAttrs['error.type'], 'Error');
      assert.match(failedAttrs['error.message'], /故意的/);
    } finally {
      await system.stop();
    }
  });
});

test('otlp: 导出失败**可见**（计数 + 日志），不静默丢 span', async () => {
  const logged = [];
  const exporter = plugins.otlp({
    endpoint: 'http://127.0.0.1:1', // 关着的端口
    flushIntervalMs: 0,
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const system = createSystem({ logger: false, plugins: [exporter] });
  // 内核把每条日志同时以事件形式发出：用它断言"失败可见"，不依赖 logger 的具体形状
  system.on('log', (event, meta) => logged.push({ event, meta }));
  try {
    const ref = await system.spawn({ preStart() {}, receive: () => 'ok' }, { id: 'lost' });
    await ref.ask({ type: 'go' });

    const result = await exporter.flush();
    assert.deepStrictEqual(result.sent, 0);
    const stats = exporter.stats();
    assert.strictEqual(stats.failed, 1, '失败次数要计数');
    assert.strictEqual(stats.dropped, 1, '丢掉的 span 数要计数');
    assert.match(stats.lastError, /ECONNREFUSED/);
    assert.ok(
      logged.some((entry) => String(entry.event).includes('otlp_export_failed')),
      `导出失败要写日志（实际：${JSON.stringify(logged)}）`,
    );
    assert.strictEqual(logged.find((entry) => String(entry.event).includes('otlp_export_failed')).meta.endpoint, 'http://127.0.0.1:1');
  } finally {
    await system.stop();
  }
});

test('otlp: 采样为 false 的 span 不导出；teardown 会 flush 一次', async () => {
  const sent = [];
  const exporter = plugins.otlp({
    endpoint: 'http://collector.invalid',
    flushIntervalMs: 0,
    fetch: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    },
  });
  const system = createSystem({ logger: false, plugins: [exporter] });
  const ref = await system.spawn({ preStart() {}, receive: () => 'ok' }, { id: 'sampled' });
  await ref.ask({ type: 'go' });
  // 手动插一条"未采样"的 span：sink 应当直接忽略它
  system.spanSink.onSpan({ name: 'never', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: false, startTimeMs: 0, endTimeMs: 1, attributes: {} });
  await system.stop(); // teardown 里 flush
  assert.strictEqual(sent.length, 1, 'teardown 时把剩下的 span 发出去');
  assert.strictEqual(sent[0].resourceSpans[0].scopeSpans[0].spans.length, 1, '未采样的不导出');
});

test('log adapter: 对象日志器接到内核的函数日志接口上（级别按事件名猜，可覆盖）', () => {
  const { createLogAdapter } = require('../src/index.ts');

  const lines = [];
  const pinoLike = {
    debug: (line) => lines.push(['debug', line]),
    info: (line) => lines.push(['info', line]),
    warn: (line) => lines.push(['warn', line]),
    error: (line) => lines.push(['error', line]),
  };
  const logger = createLogAdapter(pinoLike);
  logger('actor_started', { path: 'a' });
  logger('otlp_export_failed', { err: 'ECONNREFUSED' });
  assert.deepStrictEqual(lines.map(([level]) => level), ['info', 'warn'], '失败类事件走 warn');
  assert.match(lines[0][1], /actor_started \{"path":"a"\}/, '默认消息文本包含事件名与 meta');

  // 自定义级别与文本
  const custom = [];
  const adapter = createLogAdapter(
    { info: (line) => custom.push(line), warn: (line) => custom.push(line) },
    { level: () => 'warn', message: (event) => `[actor] ${event}` },
  );
  adapter('anything');
  assert.deepStrictEqual(custom, ['[actor] anything']);

  assert.throws(() => createLogAdapter(null), /需要一个对象日志器/);
  // 目标缺方法时静默（不能因为日志把内核搞崩）
  const noop = createLogAdapter({});
  assert.doesNotThrow(() => noop('whatever'));
});
