'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { setTimeout: delay } = require('node:timers/promises');

const {
  AlertManager,
  parsePrometheusText,
  sumSamples,
  evaluateRule,
  parseDuration,
  consoleNotifier,
  webhookNotifier,
  defaultGameRules,
} = require('../src/obs/alerting');

const EXPOSITION = `# HELP actor_mailbox_depth_total Messages queued across all actors.
# TYPE actor_mailbox_depth_total gauge
actor_mailbox_depth_total 120
# HELP actor_messages_handled_total Messages handled successfully.
# TYPE actor_messages_handled_total counter
actor_messages_handled_total{actor="room-1/alice"} 40
actor_messages_handled_total{actor="room-1/bob"} 2
# HELP actor_messages_throttled_total Messages delayed by the rate limit.
# TYPE actor_messages_throttled_total counter
actor_messages_throttled_total{actor="session-1"} 300
# HELP actor_supervisor_restarts_in_window Restarts recorded inside the window.
# TYPE actor_supervisor_restarts_in_window gauge
actor_supervisor_restarts_in_window{supervisor="actor-system"} 3
# HELP actor_process_uptime_seconds Process uptime.
# TYPE actor_process_uptime_seconds gauge
actor_process_uptime_seconds 12.5
`;

test('alerting: the exposition format is parsed into typed samples', () => {
  const parsed = parsePrometheusText(EXPOSITION);
  assert.strictEqual(parsed.types.actor_mailbox_depth_total, 'gauge');
  assert.strictEqual(parsed.types.actor_messages_handled_total, 'counter');
  assert.strictEqual(parsed.samples.length, 6);
  assert.deepStrictEqual(parsed.samples[1].labels, { actor: 'room-1/alice' });
  assert.strictEqual(sumSamples(parsed, 'actor_messages_handled_total'), 42);
  assert.strictEqual(sumSamples(parsed, 'actor_messages_handled_total', { actor: 'room-1/bob' }), 2);
  assert.strictEqual(sumSamples(parsed, 'not_there'), null);
  assert.match(parsed.help.actor_mailbox_depth_total, /queued/i);
});

test('alerting: the parser survives malformed input instead of throwing', () => {
  const parsed = parsePrometheusText([
    'not a metric line',
    '# TYPE onlyname',
    'broken{a="1"} notanumber',
    'actor_x{a="unterminated} 5',
    'actor_y NaN',
    'actor_ok 3',
  ].join('\n'));
  assert.deepStrictEqual(parsed.samples.map((s) => s.name), ['actor_x', 'actor_ok']);
  assert.strictEqual(sumSamples(parsed, 'actor_ok'), 3);
  assert.deepStrictEqual(parsePrometheusText('').samples, []);
  assert.deepStrictEqual(parsePrometheusText(null).samples, []);
});

test('alerting: durations accept ms/s/m/h and numbers', () => {
  assert.strictEqual(parseDuration('10s'), 10000);
  assert.strictEqual(parseDuration('1m'), 60000);
  assert.strictEqual(parseDuration('2h'), 7200000);
  assert.strictEqual(parseDuration('500ms'), 500);
  assert.strictEqual(parseDuration(0), 0);
  assert.strictEqual(parseDuration(undefined), 0);
  assert.strictEqual(parseDuration('3'), 3000);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
});

test('alerting: gauge and counter rules evaluate correctly', () => {
  const parsed = parsePrometheusText(EXPOSITION);
  parsed._now = Date.now();

  assert.strictEqual(evaluateRule({ name: 'a', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 100 }, parsed, null).ok, true);
  assert.strictEqual(evaluateRule({ name: 'a', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 1000 }, parsed, null).ok, false);
  assert.strictEqual(evaluateRule({ name: 'a', metric: 'actor_supervisor_restarts_in_window', condition: '>=', threshold: 3 }, parsed, null).ok, true);
  assert.strictEqual(evaluateRule({ name: 'a', metric: 'actor_mailbox_depth_total', condition: '<=', threshold: 120 }, parsed, null).ok, true);

  // Missing metric: not firing, and distinguishable from "below threshold".
  assert.deepStrictEqual(evaluateRule({ name: 'a', metric: 'nope', condition: '>' }, parsed, null), { value: null, ok: false });

  // Counter increase: 300 - 200 over 10s = 100 increase, 10/s.
  const previous = { value: 200, at: parsed._now - 10000 };
  assert.strictEqual(evaluateRule({ name: 'a', metric: 'actor_messages_throttled_total', condition: 'increase>', threshold: 50 }, parsed, previous).value, 100);
  assert.strictEqual(evaluateRule({ name: 'a', metric: 'actor_messages_throttled_total', condition: 'rate>', threshold: 5 }, parsed, previous).value, 10);

  // A counter reset must not look like a huge negative rate.
  assert.strictEqual(evaluateRule({ name: 'a', metric: 'actor_messages_throttled_total', condition: 'increase>', threshold: 1 }, parsed, { value: 9999, at: parsed._now - 1000 }).value, 0);

  // rate/increase on a gauge is meaningless: refuse rather than mislead.
  assert.strictEqual(evaluateRule({ name: 'a', metric: 'actor_mailbox_depth_total', condition: 'rate>' }, parsed, previous).value, null);

  assert.throws(() => evaluateRule({ name: 'bad', metric: 'actor_ok', condition: '~>' }, parsed, null), /unknown condition/);
});

test('alerting: a rule fires only after its `for` duration, then resolves', async () => {
  let mailboxDepth = 500;
  const alerts = new AlertManager({
    source: { snapshot: () => ({ types: { actor_mailbox_depth_total: 'gauge' }, samples: [{ name: 'actor_mailbox_depth_total', labels: {}, value: mailboxDepth }] }) },
    rules: [{ name: 'MailboxBacklog', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 100, for: '100ms', severity: 'warning' }],
    notifiers: [],
  });

  const events = [];
  alerts.on('pending', () => events.push('pending'));
  alerts.on('firing', () => events.push('firing'));
  alerts.on('resolved', () => events.push('resolved'));

  const now = Date.now();
  await alerts.evaluateOnce(now); // first breach → pending
  assert.deepStrictEqual(events, ['pending']);
  assert.strictEqual(alerts.status().alerts[0].status, 'pending');

  await alerts.evaluateOnce(now + 50); // still inside `for`
  assert.deepStrictEqual(events, ['pending']);

  await alerts.evaluateOnce(now + 150); // past `for` → firing
  assert.deepStrictEqual(events, ['pending', 'firing']);
  assert.strictEqual(alerts.status().alerts[0].status, 'firing');
  assert.strictEqual(alerts.status().alerts[0].value, 500);

  mailboxDepth = 10; // recovered
  await alerts.evaluateOnce(now + 200);
  assert.deepStrictEqual(events, ['pending', 'firing', 'resolved']);
  assert.strictEqual(alerts.status().alerts[0].status, 'resolved');
});

test('alerting: a transient spike never fires (the `for` window resets)', async () => {
  let value = 500;
  const alerts = new AlertManager({
    source: { snapshot: () => ({ types: { m: 'gauge' }, samples: [{ name: 'm', labels: {}, value }] }) },
    rules: [{ name: 'Spike', metric: 'm', condition: '>', threshold: 100, for: '200ms' }],
  });
  const events = [];
  alerts.on('firing', () => events.push('firing'));
  alerts.on('pending_cleared', () => events.push('cleared'));

  const t0 = Date.now();
  await alerts.evaluateOnce(t0); // pending
  await alerts.evaluateOnce(t0 + 150); // still pending
  value = 10;
  await alerts.evaluateOnce(t0 + 180); // dropped before `for` elapsed
  await alerts.evaluateOnce(t0 + 400);
  assert.deepStrictEqual(events, ['cleared'], 'a spike shorter than `for` must not fire');
  assert.strictEqual(alerts.status().alerts[0].status, 'inactive');
});

test('alerting: resolveFor keeps flapping alerts quiet', async () => {
  let value = 500;
  const alerts = new AlertManager({
    source: { snapshot: () => ({ types: { m: 'gauge' }, samples: [{ name: 'm', labels: {}, value }] }) },
    rules: [{ name: 'Flap', metric: 'm', condition: '>', threshold: 100, for: '0s', resolveFor: '1s' }],
  });
  const firings = [];
  alerts.on('firing', () => firings.push(1));

  const t0 = Date.now();
  await alerts.evaluateOnce(t0);
  assert.strictEqual(alerts.status().alerts[0].status, 'firing');

  value = 0;
  await alerts.evaluateOnce(t0 + 100); // inside resolveFor → still firing
  assert.strictEqual(alerts.status().alerts[0].status, 'firing');

  value = 500;
  await alerts.evaluateOnce(t0 + 200); // flapped back → no new firing event
  assert.strictEqual(firings.length, 1, 'one firing event, not two');

  value = 0;
  await alerts.evaluateOnce(t0 + 2000); // resolveFor elapsed → resolved
  assert.strictEqual(alerts.status().alerts[0].status, 'resolved');
});

test('alerting: notifiers receive firing and resolved events, and failures are isolated', async () => {
  const sent = [];
  const broken = { name: 'broken', send: async () => { throw new Error('notifier down'); } };
  const collector = { name: 'collector', send: async (event) => sent.push(`${event.status}:${event.rule.name}`) };

  let value = 500;
  const alerts = new AlertManager({
    source: { snapshot: () => ({ types: { m: 'gauge' }, samples: [{ name: 'm', labels: {}, value }] }) },
    rules: [{ name: 'R', metric: 'm', condition: '>', threshold: 100, for: '0s' }],
    notifiers: [broken, collector],
  });
  const notifyErrors = [];
  alerts.on('notify_error', (info) => notifyErrors.push(info.notifier));

  await alerts.evaluateOnce(Date.now());
  value = 0;
  await alerts.evaluateOnce(Date.now() + 10);

  assert.deepStrictEqual(sent, ['firing:R', 'resolved:R']);
  assert.deepStrictEqual(notifyErrors, ['broken', 'broken'], 'a broken notifier is reported, not thrown');
});

test('alerting: the console notifier prints a readable line', async () => {
  const lines = [];
  const notifier = consoleNotifier({ log: (line) => lines.push(line) });
  await notifier.send({
    status: 'firing',
    rule: { name: 'MailboxBacklog', severity: 'warning', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 1000 },
    value: 1500,
    summary: '邮箱积压',
  });
  assert.match(lines[0], /\[ALERT\] MailboxBacklog \(warning\) actor_mailbox_depth_total> 1000 → 1500 — 邮箱积压/);
});

test('alerting: the webhook notifier posts JSON and reports a bad endpoint', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const notifier = webhookNotifier(`http://127.0.0.1:${port}/hook`);
    await notifier.send({
      status: 'firing',
      rule: { name: 'DeadLetters', severity: 'critical', metric: 'actor_dead_lettered_total', condition: 'increase>', threshold: 5 },
      value: 9,
      summary: '出现死信',
    });
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].status, 'firing');
    assert.strictEqual(received[0].name, 'DeadLetters');
    assert.strictEqual(received[0].value, 9);

    // A 500 from the webhook surfaces as a rejection.
    await new Promise((resolve) => {
      server.removeAllListeners('request');
      server.on('request', (req, res) => res.writeHead(500).end('boom'));
      resolve();
    });
    await assert.rejects(
      () => notifier.send({ status: 'firing', rule: { name: 'X' }, value: 1 }),
      /webhook responded 500/,
    );

    // And an unreachable endpoint rejects instead of hanging (the alert loop
    // must not be blocked by a dead webhook).
    const dead = webhookNotifier('http://127.0.0.1:1/hook', { timeoutMs: 300 });
    await assert.rejects(() => dead.send({ status: 'firing', rule: { name: 'X' }, value: 1 }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('alerting: it can poll a real /metrics endpoint end to end', async () => {
  // A tiny stand-in for the framework's exporter.
  let depth = 2000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(EXPOSITION.replace('actor_mailbox_depth_total 120', `actor_mailbox_depth_total ${depth}`));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const fired = [];
  const alerts = new AlertManager({
    source: { url: `http://127.0.0.1:${port}/metrics` },
    rules: [{ name: 'MailboxBacklog', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 1000, for: '0s' }],
    notifiers: [{ name: 'test', send: async (event) => fired.push(event) }],
    intervalMs: 30,
  });

  try {
    await alerts.start();
    assert.strictEqual(alerts.status().alerts[0].status, 'firing');

    depth = 5; // the endpoint recovers
    await delay(120);
    assert.strictEqual(alerts.status().alerts[0].status, 'resolved');
    assert.deepStrictEqual(fired.map((e) => e.status), ['firing', 'resolved']);
    assert.strictEqual(alerts.status().evaluations >= 2, true);
  } finally {
    await alerts.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('alerting: a missing metrics endpoint is reported, not fatal', async () => {
  const alerts = new AlertManager({
    source: { url: 'http://127.0.0.1:1/metrics', timeoutMs: 200 },
    rules: [{ name: 'R', metric: 'm', condition: '>' }],
    intervalMs: 20,
  });
  const errors = [];
  alerts.on('error', (err) => errors.push(err));
  await alerts.start();
  await delay(60);
  await alerts.stop();
  assert.ok(errors.length > 0, 'the scrape failure is surfaced');
  assert.strictEqual(alerts.status().alerts[0].status, 'inactive');
});

test('alerting: rule definitions are validated up front', () => {
  assert.throws(() => new AlertManager({ rules: [{ metric: 'm' }] }), /needs \{ name, metric \}/);
  assert.throws(
    () => new AlertManager({ rules: [{ name: 'R', metric: 'm', condition: '~>' }] }),
    /unsupported condition/,
  );
  assert.throws(() => new AlertManager({ rules: [{ name: 'R', metric: 'm', for: 'soon' }] }), /invalid duration/);

  const manager = new AlertManager({ rules: defaultGameRules() });
  const names = manager.status().alerts.map((a) => a.name);
  assert.ok(names.includes('MailboxBacklog'));
  assert.ok(names.includes('ThrottledFlood'));
  assert.ok(names.includes('DeadLettersGrowing'));
  // Defaults are filled in.
  assert.strictEqual(manager.status().alerts[0].severity, 'warning');
});
