'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { setupTempEnv, cleanup, waitFor } = require('../packages/core/test/helpers');

const tempDir = setupTempEnv('actor-metrics');

const MetricsExporter = require('../packages/core/src/obs/metrics-exporter');
const { renderFamilies, escapeLabelValue, formatValue } = require('../packages/core/src/obs/metrics-exporter');
const { Metrics } = require('../packages/core/src/obs/metrics');

test.after(() => cleanup(tempDir));

function httpGet(port, pathName, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function buildExporter(overrides = {}) {
  const metrics = new Metrics({ logDir: tempDir });
  metrics.observe('player_001', { received: 10, handled: 8, failed: 1, retries: 2, dlq: 1, totalLatencyMs: 80, maxLatencyMs: 30 });
  metrics.observe('player_002', { received: 3, handled: 3, totalLatencyMs: 6, maxLatencyMs: 4 });

  // A framework-shaped source: the exporter reads gauges from a system, not
  // from the retired registry/supervisor objects.
  const system = {
    stopped: false,
    size: 2,
    cells: new Map([
      ['player_001', { path: 'player_001', isolation: 'inline', mailbox: { size: 2 }, counters: {} }],
      ['player_002', { path: 'player_002', isolation: 'worker', mailbox: { size: 0 }, counters: {} }],
    ]),
    cluster: null,
    pubsub: null,
    stats: () => ({
      name: 'fixture',
      actors: 2,
      mailboxDepth: 2,
      deadLettered: 1,
      deadLetters: 1,
      scheduled: 0,
      ticks: 5,
      uptimeMs: 1000,
      peers: 0,
      plugins: [],
      rootSupervisor: {
        id: 'actor-system',
        strategy: 'one_for_one',
        children: ['player_001', 'player_002'],
        restartsInWindow: 1,
        maxRestarts: 3,
        withinSeconds: 5,
        escalations: 0,
      },
    }),
  };

  return new MetricsExporter({
    host: '127.0.0.1',
    port: 0,
    metrics,
    framework: system,
    storeBackend: 'file',
    ...overrides,
  });
}

test('exporter: renders the Prometheus text exposition format', async () => {
  const exporter = buildExporter();
  await exporter.listen();
  try {
    const res = await httpGet(exporter.boundPort, '/metrics');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain; version=0\.0\.4/);

    // Every family has HELP + TYPE.
    assert.match(res.body, /# HELP actor_messages_handled_total Messages handled successfully\./);
    assert.match(res.body, /# TYPE actor_messages_handled_total counter/);
    assert.match(res.body, /actor_messages_handled_total\{actor="player_001"\} 8/);
    assert.match(res.body, /actor_messages_received_total\{actor="player_002"\} 3/);
    assert.match(res.body, /actor_messages_dead_lettered_total\{actor="player_001"\} 1/);

    // Cluster gauges reflect the framework-shaped source (labels are sorted).
    assert.match(res.body, /actor_cluster_actors 2/);
    assert.match(res.body, /actor_isolated_actors 1/);
    assert.match(res.body, /actor_supervisor_restarts_in_window\{supervisor="actor-system"\} 1/);
    assert.match(res.body, /# TYPE actor_supervisor_escalations_total counter/);
    assert.match(res.body, /actor_store_info\{backend="file"\} 1/);

    // Latency is converted to seconds.
    assert.match(res.body, /actor_message_latency_seconds_total\{actor="player_001"\} 0\.08/);
    assert.match(res.body, /actor_message_latency_seconds_max\{actor="player_001"\} 0\.03/);
    assert.match(res.body, /actor_message_latency_seconds_avg\{actor="player_001"\} 0\.01/);
  } finally {
    await exporter.close();
  }
});

test('exporter: every sample line is well formed', async () => {
  const exporter = buildExporter();
  await exporter.listen();
  try {
    const { body } = await httpGet(exporter.boundPort, '/metrics');
    const sampleLines = body.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.ok(sampleLines.length > 10, `expected real samples, got ${sampleLines.length}`);
    for (const line of sampleLines) {
      assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d+(\.\d+)?$/, `bad exposition line: ${line}`);
    }
    // No duplicate series.
    const names = sampleLines.map((l) => l.split(' ')[0]);
    assert.strictEqual(new Set(names).size, names.length, 'series must be unique');
  } finally {
    await exporter.close();
  }
});

test('exporter: scrape counter increases and non-metric paths are 404', async () => {
  const exporter = buildExporter();
  await exporter.listen();
  try {
    await httpGet(exporter.boundPort, '/metrics');
    const second = await httpGet(exporter.boundPort, '/metrics');
    assert.match(second.body, /actor_metrics_scrapes_total 2/);

    const missing = await httpGet(exporter.boundPort, '/nope');
    assert.strictEqual(missing.status, 404);

    const query = await httpGet(exporter.boundPort, '/metrics?foo=bar');
    assert.strictEqual(query.status, 200, 'query strings are ignored');

    const post = await httpGet(exporter.boundPort, '/metrics', 'POST');
    assert.strictEqual(post.status, 405);
    assert.strictEqual(post.headers.allow, 'GET, HEAD');
  } finally {
    await exporter.close();
  }
});

test('exporter: a custom path is honoured', async () => {
  const exporter = buildExporter({ path: '/internal/metrics' });
  await exporter.listen();
  try {
    assert.strictEqual((await httpGet(exporter.boundPort, '/internal/metrics')).status, 200);
    assert.strictEqual((await httpGet(exporter.boundPort, '/metrics')).status, 404);
  } finally {
    await exporter.close();
  }
});

test('exporter: missing optional sources still render', async () => {
  const exporter = new MetricsExporter({ host: '127.0.0.1', port: 0, metrics: new Metrics({ logDir: tempDir }) });
  await exporter.listen();
  try {
    const { status, body } = await httpGet(exporter.boundPort, '/metrics');
    assert.strictEqual(status, 200);
    assert.match(body, /actor_process_uptime_seconds/);
    assert.match(body, /actor_metrics_scrapes_total 1/);
    assert.ok(!body.includes('actor_cluster_actors'), 'no framework source means no cluster gauges');
    assert.ok(body.includes('actor_process_uptime_seconds'), 'process metrics still render');
  } finally {
    await exporter.close();
  }
});

test('exporter: label values are escaped and non-finite numbers are sanitised', () => {
  assert.strictEqual(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  assert.strictEqual(formatValue(Number.NaN), '0');
  assert.strictEqual(formatValue(Number.POSITIVE_INFINITY), '0');
  assert.strictEqual(formatValue(42), '42');
  assert.strictEqual(formatValue(0.5), '0.5');

  const rendered = renderFamilies([
    {
      name: 'actor_test_total',
      type: 'counter',
      help: 'help text',
      samples: [{ labels: { actor: 'we"ird\nname' }, value: 1 }, { labels: {}, value: Number.NaN }],
    },
    { name: 'actor_empty_total', type: 'counter', help: 'no samples', samples: [] },
  ]);
  assert.match(rendered, /actor_test_total\{actor="we\\"ird\\nname"\} 1/);
  assert.match(rendered, /actor_test_total 0/);
  assert.ok(!rendered.includes('actor_empty_total'), 'empty families are omitted');
});

test('integration: bootstrap exposes a working endpoint', async () => {
  const { bootstrap } = require('../actor-main');
  const ctx = await bootstrap({
    nodeId: 'metrics-node',
    telnet: { enabled: false },
    gateway: { enabled: false },
    gossip: { enabled: false },
    metrics: { exporter: { enabled: true, host: '127.0.0.1', port: 0, path: '/metrics' } },
    bootActors: ['player_001'],
  });

  try {
    assert.ok(ctx.ports.metrics > 0, 'the exporter listened on an ephemeral port');
    await ctx.system.ref('player_001').ask({ type: 'hurt', damage: 5 });
    await waitFor(() => {
      const m = ctx.metrics.get('player_001');
      return m && m.handled > 0;
    }, { message: 'metrics to arrive from the actors' });

    const { status, body } = await httpGet(ctx.ports.metrics, '/metrics');
    assert.strictEqual(status, 200);
    assert.match(body, /actor_messages_handled_total\{actor="player_001"\} [1-9]/);
    assert.match(body, /actor_cluster_actors 1/);
    assert.match(body, /actor_store_info\{backend="file"\} 1/);
    assert.match(body, /actor_process_resident_memory_bytes \d+/);
  } finally {
    await ctx.close();
  }
});

test('integration: a busy metrics port degrades to a warning, not a crash', async () => {
  const { bootstrap } = require('../actor-main');
  const first = await bootstrap({
    nodeId: 'm1',
    telnet: { enabled: false },
    gateway: { enabled: false },
    gossip: { enabled: false },
    metrics: { exporter: { enabled: true, host: '127.0.0.1', port: 0 } },
    bootActors: [],
  });
  try {
    const second = await bootstrap({
      nodeId: 'm2',
      telnet: { enabled: false },
      gateway: { enabled: false },
      gossip: { enabled: false },
      metrics: { exporter: { enabled: true, host: '127.0.0.1', port: first.ports.metrics } },
      bootActors: [],
    });
    try {
      assert.strictEqual(second.metricsExporter, null);
      assert.ok(second.warnings.some((w) => /metrics exporter could not listen/.test(w)));
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});
