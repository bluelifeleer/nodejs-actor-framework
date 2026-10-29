





import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import _helpers from '../packages/core/test/helpers.js';
const { setupTempEnv, cleanup, waitFor, delay } = _helpers;
import _pkg from 'nodejs-actor-framework';
const { createSystem,
  plugins,
  cluster,
  pubsub,
  metrics: metricsPlugin,
  tracing,
  deadLetters,
  rateLimit, } = _pkg;
import _dead_letter_queue from '../packages/core/src/store/dead-letter-queue.ts';
const { DeadLetterQueue } = _dead_letter_queue;

const tempDir = setupTempEnv('actor-plugins');




test.after(() => cleanup(tempDir));

let seq = 0;
const uniqueDir = (prefix) => path.join(tempDir, `${prefix}-${++seq}`);

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'GET' }, (res) => {
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

// ---------------------------------------------------------------------------
// tracing
// ---------------------------------------------------------------------------

test('tracing: one trace spans a chain of actors with nested spans', async () => {
  const system = createSystem({ logger: false, plugins: [tracing()] });
  try {
    const seen = {};
    await system.spawn(
      async (msg, ctx) => {
        seen.c = { ...ctx.trace };
        return 'c';
      },
      { id: 'c' },
    );
    await system.spawn(
      async (msg, ctx) => {
        seen.b = { ...ctx.trace };
        await ctx.ask('c', 'go');
        return 'b';
      },
      { id: 'b' },
    );
    const a = await system.spawn(
      async (msg, ctx) => {
        seen.a = { ...ctx.trace };
        await ctx.ask('b', 'go');
        return 'a';
      },
      { id: 'a' },
    );

    assert.strictEqual(await a.ask('go'), 'a');

    assert.strictEqual(seen.a.traceId, seen.b.traceId, 'one trace id across the chain');
    assert.strictEqual(seen.b.traceId, seen.c.traceId);
    assert.strictEqual(seen.a.parentSpanId, null, 'a is the root span');
    assert.strictEqual(seen.b.parentSpanId, seen.a.spanId, 'b is a child of a');
    assert.strictEqual(seen.c.parentSpanId, seen.b.spanId, 'c is a child of b');
    assert.strictEqual(new Set([seen.a.spanId, seen.b.spanId, seen.c.spanId]).size, 3);
  } finally {
    await system.stop();
  }
});

test('tracing: ctx.span() can nest spans an actor starts itself, and sampling is honoured', async () => {
  const system = createSystem({ logger: false, plugins: [tracing({ sampleRate: 0 })] });
  try {
    const ref = await system.spawn(async (msg, ctx) => {
      const child = ctx.span();
      return { hasTrace: ctx.trace !== null, sampled: ctx.trace ? ctx.trace.sampled : null, childIsChild: child.parentSpanId === ctx.trace.spanId };
    }, { id: 'spaner' });

    const result = await ref.ask('go');
    assert.strictEqual(result.hasTrace, true);
    assert.strictEqual(result.sampled, false, 'sampleRate 0 is propagated');
    assert.strictEqual(result.childIsChild, true);
  } finally {
    await system.stop();
  }
});

test('tracing: without the plugin there is no trace context (no cost)', async () => {
  const system = createSystem({ logger: false });
  try {
    const ref = await system.spawn(async (msg, ctx) => ({ trace: ctx.trace, span: ctx.span() }), { id: 'plain' });
    assert.deepStrictEqual(await ref.ask('x'), { trace: null, span: null });
    assert.strictEqual(system.tracer, null);
  } finally {
    await system.stop();
  }
});

// ---------------------------------------------------------------------------
// rate limit
// ---------------------------------------------------------------------------

test('rateLimit: a per-actor token bucket throttles without reordering', async () => {
  const system = createSystem({ logger: false, plugins: [rateLimit({ capacity: 2, rate: 10 })] });
  try {
    const order = [];
    const ref = await system.spawn(async (msg) => {
      order.push(msg);
      return msg;
    }, { id: 'limited', mailbox: { maxSize: 100 } });

    for (let i = 0; i < 5; i += 1) ref.tell(i);
    await waitFor(() => system.inspect('limited').counters.handled === 5, { message: 'all messages handled', timeout: 5000 });

    assert.deepStrictEqual(order, [0, 1, 2, 3, 4], 'throttling must not reorder the mailbox');
    assert.ok(system.inspect('limited').counters.throttled > 0, 'the bucket was actually enforced');
  } finally {
    await system.stop();
  }
});

test('rateLimit: a per-actor option overrides the system policy', async () => {
  const system = createSystem({ logger: false, plugins: [rateLimit({ capacity: 1, rate: 1 })] });
  try {
    const ref = await system.spawn(async () => 'ok', { id: 'fast', rateLimit: { capacity: 100, rate: 1000 } });
    for (let i = 0; i < 20; i += 1) ref.tell(i);
    await waitFor(() => system.inspect('fast').counters.handled === 20, { message: 'handled quickly', timeout: 3000 });
    assert.strictEqual(system.inspect('fast').counters.throttled, 0, 'the per-actor policy won');
  } finally {
    await system.stop();
  }
});

// ---------------------------------------------------------------------------
// durable dead letters
// ---------------------------------------------------------------------------

test('deadLetters: exhausted retries land in the durable store', async () => {
  const dlqDir = uniqueDir('dlq');
  const store = new DeadLetterQueue({ baseDir: dlqDir, filePath: path.join(dlqDir, 'dlq.jsonl') });
  const system = createSystem({
    logger: false,
    plugins: [deadLetters({ store })],
    defaults: { failure: 'retry', maxRetry: 1, retryBackoffMs: 1 },
  });
  try {
    const ref = await system.spawn(async () => {
      throw new Error('always fails');
    }, { id: 'flaky' });

    await assert.rejects(() => ref.ask('x'), /always fails/);
    await waitFor(() => system.deadLetters.length === 1, { message: 'the in-memory view' });
    await waitFor(async () => (await store.size()) === 1, { message: 'the durable record' });

    const durable = await system.readDeadLetters();
    assert.strictEqual(durable.length, 1);
    assert.strictEqual(durable[0].actorId, 'flaky');
    assert.equal(durable[0].msg, 'x');
    assert.match(durable[0].reason, /always fails/);

    await system.clearDeadLetters();
    assert.strictEqual(await store.size(), 0);
    assert.deepStrictEqual(await system.readDeadLetters(), []);
  } finally {
    await system.stop();
  }
});

test('deadLetters: without the plugin dead letters stay in memory', async () => {
  const system = createSystem({ logger: false, defaults: { failure: 'retry', maxRetry: 0 } });
  try {
    const ref = await system.spawn(async () => {
      throw new Error('nope');
    }, { id: 'mem' });
    await assert.rejects(() => ref.ask('x'), /nope/);
    assert.strictEqual(system.deadLetterStore, null);
    assert.strictEqual((await system.readDeadLetters()).length, 1);
  } finally {
    await system.stop();
  }
});

// ---------------------------------------------------------------------------
// cluster + pubsub
// ---------------------------------------------------------------------------

/** Two nodes with the cluster plugin wired to each other. */
async function clusterPair(t, extraPlugins = () => []) {
  const options = {
    host: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    intervalMs: 80,
    peerTimeoutMs: 5000,
    port: 0,
  };

  const a = createSystem({ logger: false, name: 'node-a', plugins: [cluster(options), ...extraPlugins()] });
  await a.init();
  const aGossip = a.cluster.port;
  await a.listen({ host: '127.0.0.1', port: 0 });

  const b = createSystem({
    logger: false,
    name: 'node-b',
    plugins: [cluster({ ...options, seeds: [{ host: '127.0.0.1', port: aGossip }] }), ...extraPlugins()],
  });
  await b.init();
  await b.listen({ host: '127.0.0.1', port: 0 });

  const close = async () => {
    await b.stop();
    await a.stop();
  };
  if (t && typeof t.after === 'function') t.after(close);
  return { a, b, close };
}

test('cluster: an actor is reachable by name across nodes, with no host:port at the call site', async (t) => {
  const { a, b } = await clusterPair(t);

  await a.spawn(
    {
      preStart() {
        this.state = { hp: 100 };
      },
      async onMessage(msg) {
        if (msg.type === 'hurt') {
          this.state.hp -= msg.damage;
          return this.state.hp;
        }
        return this.state.hp;
      },
    },
    { id: 'player_001' },
  );

  await b.cluster.waitFor('player_001');
  assert.deepStrictEqual(b.cluster.remoteActors(), ['player_001']);
  assert.strictEqual(b.cluster.lookup('player_001').nodeId, 'node-a');
  assert.ok(b.cluster.peers().some((peer) => peer.lastSeen > 0), 'the peer is live, not just known');

  const remote = b.resolve('player_001');
  assert.ok(remote, 'the cluster made the remote actor resolvable');
  assert.strictEqual(remote.isLocal, false);
  assert.strictEqual(await remote.ask({ type: 'hurt', damage: 5 }, 3000), 95);
  assert.strictEqual(await remote.ask({ type: 'hurt', damage: 5 }, 3000), 90);

  assert.strictEqual(a.inspect('player_001').state.hp, 90, 'the message really ran on node-a');
  assert.throws(() => remote.inspect(), /local-only/);
  await assert.rejects(() => remote.state(), /local-only/);
});

test('cluster: an actor on one node asks an actor on another by name', async (t) => {
  const { a, b } = await clusterPair(t);

  await a.spawn(async (msg) => `a-says:${msg.n}`, { id: 'echo' });
  await b.cluster.waitFor('echo');

  const caller = await b.spawn(async (msg, ctx) => ctx.ask('echo', { n: 7 }, 3000), { id: 'caller' });
  assert.strictEqual(await caller.ask('go', 4000), 'a-says:7');
});

test('cluster: a stopped actor is withdrawn from discovery', async (t) => {
  const { a, b } = await clusterPair(t);
  await a.spawn(async () => 'bye', { id: 'temporary' });
  await b.cluster.waitFor('temporary');

  await a.ref('temporary').stop();
  await waitFor(() => b.cluster.lookup('temporary') === null, {
    message: 'the withdrawal to propagate',
    timeout: 10000,
  });
});

test('pubsub: local delivery carries the topic', async () => {
  const system = createSystem({ logger: false, plugins: [pubsub()] });
  try {
    const received = [];
    await system.spawn(async (msg) => {
      received.push(msg);
      return 'ok';
    }, { id: 'listener' });

    assert.strictEqual(system.pubsub.subscribe('news', 'listener'), true);
    assert.deepStrictEqual(system.pubsub.topics(), ['news']);
    assert.deepStrictEqual(system.pubsub.subscribers('news'), ['listener']);

    const results = await system.pubsub.publish('news', { text: 'hello' });
    assert.deepStrictEqual(results, [{ path: 'listener', ok: true }]);
    await waitFor(() => received.length === 1, { message: 'the broadcast to be delivered' });
    assert.deepStrictEqual(received, [{ text: 'hello', topic: 'news' }]);

    assert.strictEqual(system.pubsub.unsubscribe('news', 'listener'), true);
    assert.deepStrictEqual(system.pubsub.topics(), []);
  } finally {
    await system.stop();
  }
});

test('pubsub: a subscription on one node receives a broadcast from another', async (t) => {
  const { a, b } = await clusterPair(t, () => [pubsub()]);

  const received = [];
  await a.spawn(async (msg) => {
    received.push(msg);
    return 'ok';
  }, { id: 'listener' });
  a.pubsub.subscribe('game/notice', 'listener');

  await waitFor(() => b.pubsub.subscribers('game/notice').includes('listener'), {
    message: 'the subscription to replicate over gossip',
    timeout: 10000,
  });
  assert.deepStrictEqual(b.pubsub.topics(), ['game/notice']);

  const results = await b.pubsub.publish('game/notice', { text: 'server open' });
  assert.deepStrictEqual(results, [{ path: 'listener', ok: true }]);
  await waitFor(() => received.length === 1, { message: 'the broadcast to arrive on node-a' });
  assert.deepStrictEqual(received[0], { text: 'server open', topic: 'game/notice' });
});

test('pubsub: an unresolvable subscriber is reported, not swallowed', async (t) => {
  const { b } = await clusterPair(t, () => [pubsub()]);
  b.pubsub.subscribe('ghost/topic', 'nobody');
  const results = await b.pubsub.publish('ghost/topic', {});
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].ok, false);
  assert.match(results[0].err, /not resolvable/);
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

test('metrics: actor counters reach the metrics store', async () => {
  const system = createSystem({ logger: false, plugins: [metricsPlugin({ intervalMs: 20 })] });
  try {
    const ref = await system.spawn(async () => 'ok', { id: 'measured' });
    await ref.ask('a');
    await ref.ask('b');
    await waitFor(() => (system.metrics.get('measured') || {}).handled === 2, { message: 'counters to be collected' });

    const snapshot = system.metrics.dump({ persist: false });
    assert.strictEqual(snapshot.measured.received, 2);
    assert.strictEqual(snapshot.measured.handled, 2);
    assert.ok(snapshot.measured.batches >= 1);
    assert.strictEqual(typeof snapshot.measured.avgLatencyMs, 'number');
  } finally {
    await system.stop();
  }
});

test('metrics: the Prometheus endpoint exposes framework-shaped gauges', async () => {
  const system = createSystem({
    logger: false,
    plugins: [
      metricsPlugin({ intervalMs: 0, exporter: { enabled: true, host: '127.0.0.1', port: 0 } }),
      tracing(),
    ],
  });
  try {
    const ref = await system.spawn(async () => 'ok', { id: 'player_001' });
    await system.spawn('./examples/actors/encoder.js', { id: 'isolated', isolation: 'worker' });
    await ref.ask('go');

    const port = system.metricsExporter.boundPort;
    assert.ok(port > 0);

    const res = await httpGet(port, '/metrics');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /actor_cluster_actors 2/);
    assert.match(res.body, /actor_isolated_actors 1/);
    assert.match(res.body, /actor_mailbox_depth_total 0/);
    assert.match(res.body, /actor_messages_handled_total\{actor="player_001"\} 1/);
    assert.match(res.body, /actor_supervisor_escalations_total\{supervisor="actor-system"\} 0/);
    assert.match(res.body, /# TYPE actor_dead_lettered_total counter/);

    // A scrape must reflect the current counters, not the last interval.
    await ref.ask('go');
    const second = await httpGet(port, '/metrics');
    assert.match(second.body, /actor_messages_handled_total\{actor="player_001"\} 2/);
  } finally {
    await system.stop();
  }
});

test('plugins: a broken plugin does not wedge spawn, and init is idempotent', async () => {
  const system = createSystem({
    logger: false,
    plugins: [
      { name: 'noop' },
      { name: 'async-setup', setup: async () => delay(5) },
    ],
  });
  try {
    await system.init();
    await system.init(); // idempotent
    assert.deepStrictEqual([...system.installed.keys()], ['noop', 'async-setup']);
    assert.deepStrictEqual(system.stats().plugins, ['noop', 'async-setup']);
    assert.strictEqual(await system.spawn(async () => 'ok', { id: 'after' }).then((r) => r.ask('x')), 'ok');
  } finally {
    await system.stop();
  }
});

test('metrics: per-actor dead-letter 与 dropped 指标不再是恒 0（回归）', async () => {
  const system = createSystem({
    logger: false,
    plugins: [metricsPlugin({ intervalMs: 0, exporter: { enabled: true, host: '127.0.0.1', port: 0 } })],
  });
  try {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const slow = await system.spawn(async (msg) => {
      if (msg === 'block') await gate;
      return 'ok';
    }, { id: 'drop', mailbox: { maxSize: 1 } });
    slow.tell('block');
    await new Promise((resolve) => setImmediate(resolve));
    slow.tell('a');
    slow.tell('b'); // 队列已满 → 背压丢弃
    release();

    const dead = await system.spawn(async () => {
      throw new Error('no');
    }, { id: 'dead', failure: 'retry', maxRetry: 0 });
    await dead.ask('x').catch(() => undefined);

    system.collectMetrics();
    const port = system.metricsExporter.boundPort;
    const res = await httpGet(port, '/metrics');
    assert.match(res.body, /actor_messages_dead_lettered_total\{actor="dead"\} [1-9]/, '死信必须进入 per-actor 指标');
    assert.match(res.body, /actor_messages_dropped_total\{actor="drop"\} [1-9]/, '背压丢弃必须进入 per-actor 指标');
  } finally {
    await system.stop();
  }
});

test('metrics: exporter.enabled=false 必须真的不启动（回归）', async () => {
  const system = createSystem({
    logger: false,
    plugins: [metricsPlugin({ intervalMs: 0, exporter: { enabled: false, host: '127.0.0.1', port: 0 } })],
  });
  try {
    await system.spawn(async () => 'ok', { id: 'no-exporter' });
    assert.strictEqual(system.metricsExporter, null, 'enabled:false 时不应启动导出器');
  } finally {
    await system.stop();
  }
});
