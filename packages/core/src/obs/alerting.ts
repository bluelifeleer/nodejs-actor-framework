'use strict';

/**
 * Metric-based alerting for the framework's own Prometheus endpoint.
 *
 * Two ways to use the framework's metrics:
 *
 *   1. **Prometheus (recommended in production)** — point Prometheus at
 *      `/metrics` and keep the rules in `examples/prometheus/alerts.yml`.
 *      Nothing in this file is needed.
 *   2. **In-process (this module)** — for single-node deployments, tests, or
 *      when you have no Prometheus yet: poll `/metrics` (or read an in-process
 *      snapshot), evaluate rules, and notify.
 *
 * Rules are intentionally small but not naive: they know about counter vs gauge,
 * support gauge thresholds plus counter `rate>`/`increase>`, honour a `for:`
 * duration before firing, and emit a `resolved` event so alerts cannot get stuck.
 *
 *   const alerts = new AlertManager({
 *     source: { url: 'http://127.0.0.1:9464/metrics' },   // or { snapshot: () => ... }
 *     rules: [
 *       { name: 'MailboxBacklog', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 1000, for: '10s', severity: 'warning' },
 *       { name: 'ThrottledFlood', metric: 'actor_messages_throttled_total', condition: 'rate>', threshold: 50, for: '30s', severity: 'warning' },
 *       { name: 'DeadLetters', metric: 'actor_dead_lettered_total', condition: 'increase>', threshold: 5, for: '0s', severity: 'critical' },
 *     ],
 *     notifiers: [consoleNotifier(), webhookNotifier(process.env.ALERT_WEBHOOK)],
 *   });
 *   await alerts.start();
 *   alerts.on('firing', (event) => { ... });
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// Minimal Prometheus text parser
// ---------------------------------------------------------------------------

/**
 * Parse the Prometheus text exposition format.
 *
 * @returns {{types: Record<string,string>, help: Record<string,string>, samples: Array<{name:string, labels:Record<string,string>, value:number}>}}
 */
export interface NotifierOptions {
  /** Default sink for notifications (default: console.log). */
  log?: (line: string) => void;
}

export interface WebhookOptions {
  timeoutMs?: number;
  name?: string;
}

export interface AlertManagerOptions {
  source?: any;
  rules?: any[];
  notifiers?: any[];
  intervalMs?: number;
}

function parsePrometheusText(text: string) {
  const types: Record<string, string> = {};
  const help: Record<string, string> = {};
  const samples = [];
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const typeMatch = /^#\s*TYPE\s+(\S+)\s+(\S+)/.exec(line);
      if (typeMatch) types[typeMatch[1]!] = typeMatch[2]!;
      const helpMatch = /^#\s*HELP\s+(\S+)\s+(.*)$/.exec(line);
      if (helpMatch) help[helpMatch[1]!] = helpMatch[2]!;
      continue;
    }
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue; // NaN/Inf are not useful for rules
    const labels: Record<string, string> = {};
    if (match[2]) {
      const body = match[2].slice(1, -1);
      const labelRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
      let labelMatch;
      while ((labelMatch = labelRe.exec(body)) !== null) {
        labels[labelMatch[1]!] = (labelMatch[2] || '').replace(/\\(.)/g, '$1');
      }
    }
    samples.push({ name: match[1], labels, value });
  }
  return { types, help, samples };
}

/** Sum samples of a metric, optionally filtered by exact label matches. */
function sumSamples(parsed: any, metric: string, labelFilter: Record<string, string> | null = null) {
  let total = 0;
  let found = false;
  for (const sample of parsed.samples) {
    if (sample.name !== metric) continue;
    if (labelFilter) {
      let matches = true;
      for (const [key, value] of Object.entries(labelFilter)) {
        if (sample.labels[key] !== value) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
    }
    total += sample.value;
    found = true;
  }
  return found ? total : null;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

const COMPARATORS = {
  '>': (a: number, b: number) => a > b,
  '>=': (a: number, b: number) => a >= b,
  '<': (a: number, b: number) => a < b,
  '<=': (a: number, b: number) => a <= b,
  '==': (a: number, b: number) => a === b,
  '!=': (a: number, b: number) => a !== b,
};

/**
 * Evaluate one rule against a parsed snapshot.
 *
 * `rate>`/`increase>` are counter-aware: they need the previous sample, which
 * the AlertManager keeps per rule. A counter that went *backwards* (process
 * restarted, exporter reset) counts as no increase rather than as a huge drop.
 *
 * @returns {{value:number|null, ok:boolean}}
 */
function evaluateRule(rule: any, parsed: any, previous: any) {
  const labelFilter = rule.labels || null;
  const metricName = rule.metric;
  const isCounter = parsed.types[metricName] === 'counter';

  // Resolve the comparator first: a typo in a rule must fail loudly even when
  // the metric happens to be absent from this scrape.
  const comparator = rule.condition.replace(/^(rate|increase)/, '');
  const compare = COMPARATORS[comparator as keyof typeof COMPARATORS];
  if (!compare) throw new Error(`alert rule "${rule.name}": unknown condition "${rule.condition}"`);

  let value = sumSamples(parsed, metricName, labelFilter);
  if (value === null) return { value: null, ok: false }; // metric absent: not firing, not resolved-from-here

  if (rule.condition.startsWith('rate') || rule.condition.startsWith('increase')) {
    if (!isCounter) return { value: null, ok: false };
    const before = previous ? previous.value : null;
    let delta = before === null ? 0 : value - before;
    if (delta < 0) delta = 0; // counter reset
    const elapsedMs = previous ? Math.max(1, parsed._now - previous.at) : 0;
    value = rule.condition.startsWith('rate') ? (delta / elapsedMs) * 1000 : delta;
  }

  return { value, ok: compare(value, rule.threshold) };
}

function parseDuration(value: string) {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value).trim());
  if (!match) throw new Error(`invalid duration "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  return amount * (({ ms: 1, s: 1000, m: 60000, h: 3600000 } as Record<string, number>)[unit] ?? 1);
}

// ---------------------------------------------------------------------------
// Notifiers
// ---------------------------------------------------------------------------

/** Print alerts to the console (or any log function). */
function consoleNotifier(options: NotifierOptions = {}) {
  const log = options.log || ((line: string) => console.log(line));
  return {
    name: 'console',
    async send(event: any) {
      const icon = event.status === 'firing' ? '[ALERT]' : '[RESOLVED]';
      log(
        `${icon} ${event.rule.name} (${event.rule.severity || 'warning'}) ` +
          `${event.rule.metric}${event.rule.condition} ${event.rule.threshold} → ${formatValue(event.value)}` +
          `${event.summary ? ` — ${event.summary}` : ''}`,
      );
    },
  };
}

/** POST the alert as JSON to a webhook (Slack/钉钉/自建网关都行). */
function webhookNotifier(url: string, options: WebhookOptions = {}) {
  if (!url) throw new Error('webhookNotifier(url) requires a url');
  const timeoutMs = options.timeoutMs === undefined ? 3000 : options.timeoutMs;
  return {
    name: options.name || 'webhook',
    async send(event: any) {
      const body = JSON.stringify({
        status: event.status,
        name: event.rule.name,
        severity: event.rule.severity || 'warning',
        metric: event.rule.metric,
        condition: event.rule.condition,
        threshold: event.rule.threshold,
        value: event.value,
        summary: event.summary || event.rule.summary || '',
        at: event.at,
      });
      await postJson(url, body, timeoutMs);
    },
  };
}

function postJson(url: string, body: any, timeoutMs: number) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res: any) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode);
        else reject(new Error(`webhook responded ${res.statusCode}`));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`webhook timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

function formatValue(value: any): string {
  if (value === null || value === undefined) return 'n/a';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

// ---------------------------------------------------------------------------
// AlertManager
// ---------------------------------------------------------------------------

class AlertManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.source  `{ url }` to scrape, or `{ snapshot }` (sync/async fn returning parsed metrics or raw text)
   * @param {Array}  options.rules
   * @param {Array}  [options.notifiers]
   * @param {number} [options.intervalMs]
   */
  constructor(options: AlertManagerOptions = {}) {
    super();
    this.source = options.source || {};
    this.rules = (options.rules || []).map((rule: any) => {
      if (!rule.name || !rule.metric) throw new Error('each alert rule needs { name, metric }');
      const condition = rule.condition || '>';
      if (!/^(rate|increase)?(>=|<=|>|<|==|!=)$/.test(condition)) {
        throw new Error(`alert rule "${rule.name}": unsupported condition "${condition}"`);
      }
      return {
        severity: 'warning',
        ...rule,
        condition,
        forMs: parseDuration(rule.for),
        resolveForMs: parseDuration(rule.resolveFor),
      };
    });
    this.notifiers = (options.notifiers || []).filter(Boolean);
    this.intervalMs = options.intervalMs === undefined ? 5000 : options.intervalMs;
    /** @type {Map<string, object>} per-rule state */
    this.state = new Map();
    this.timer = null;
    this._running = false;
    this._pending = Promise.resolve();
    this.startedAt = null;
    this.evaluations = 0;
    this.lastError = null;
    for (const rule of this.rules) this.state.set(rule.name, { status: 'inactive', since: 0, value: null, previous: null, flippedAt: 0 });
  }

  /** Scrape/collect once and evaluate every rule. */
  async evaluateOnce(now = Date.now()) {
    const parsed = await this._collect(now);
    parsed._now = now;
    const transitions = [];

    for (const rule of this.rules) {
      const entry = this.state.get(rule.name);
      let result;
      try {
        result = evaluateRule(rule, parsed, entry.previous);
      } catch (err) {
        this.lastError = err;
        continue;
      }
      if (result.value !== null && parsed.types[rule.metric] === 'counter') {
        entry.previous = { value: sumSamples(parsed, rule.metric, rule.labels || null), at: now };
      }
      entry.value = result.value;

      if (result.value === null) continue; // metric missing: leave the state alone

      const firing = entry.status === 'firing';
      if (result.ok) {
        if (!firing) {
          if (entry.status !== 'pending') {
            entry.status = 'pending';
            entry.since = now;
            this.emit('pending', this._event('pending', rule, result.value, now));
          }
          // Promote to firing once the condition has held for `for`.
          if (now - entry.since >= rule.forMs) {
            entry.status = 'firing';
            entry.flippedAt = now;
            const event = this._event('firing', rule, result.value, now);
            transitions.push(event);
            this.emit('firing', event);
            await this._notify(event);
          }
        }
        // Already firing: keep it firing (re-notify only on an explicit repeat).
        continue;
      }

      // Condition no longer holds.
      if (entry.status === 'pending') {
        entry.status = 'inactive';
        entry.since = 0;
        this.emit('pending_cleared', this._event('pending_cleared', rule, result.value, now));
        continue;
      }
      if (entry.status === 'firing') {
        if (now - entry.flippedAt < rule.resolveForMs) continue;
        entry.status = 'resolved';
        entry.since = now;
        const event = this._event('resolved', rule, result.value, now);
        transitions.push(event);
        this.emit('resolved', event);
        await this._notify(event);
      }
    }

    this.evaluations += 1;
    return transitions;
  }

  _event(status: string, rule: any, value: number, at: number) {
    return { status, rule, value, at, summary: rule.summary || '' };
  }

  async _notify(event: any) {
    for (const notifier of this.notifiers) {
      try {
        await notifier.send(event);
      } catch (err) {
        this.lastError = err;
        this.emit('notify_error', { notifier: notifier.name, error: err, event });
      }
    }
  }

  async _collect(now: number) {
    if (typeof this.source.snapshot === 'function') {
      const result = await this.source.snapshot();
      if (typeof result === 'string') return parsePrometheusText(result);
      if (result && result.samples) return result; // already parsed
      return { types: {}, help: {}, samples: [], ...result };
    }
    if (this.source.url) {
      const text = await scrape(String(this.source.url), this.source.timeoutMs === undefined ? 3000 : this.source.timeoutMs);
      return parsePrometheusText(text);
    }
    throw new Error('AlertManager needs source.url or source.snapshot');
  }

  /** Start polling. */
  async start() {
    if (this._running) return;
    this._running = true;
    this.startedAt = Date.now();
    await this.evaluateOnce().catch((err: Error) => {
      this.lastError = err;
      this.emit('error', err);
    });
    this.timer = setInterval(() => {
      // Serialise evaluations: a slow scrape must not stack up.
      this._pending = this._pending
        .then(() => (this._running ? this.evaluateOnce() : null))
        .catch((err: Error) => {
          this.lastError = err;
          this.emit('error', err);
        });
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop() {
    this._running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this._pending.catch(() => {});
  }

  /** Current alert status, for a console command or an /alerts endpoint. */
  status() {
    const alerts = [];
    for (const rule of this.rules) {
      const entry = this.state.get(rule.name);
      alerts.push({
        name: rule.name,
        severity: rule.severity,
        metric: rule.metric,
        condition: rule.condition,
        threshold: rule.threshold,
        status: entry.status,
        value: entry.value,
        since: entry.since || null,
        summary: rule.summary || '',
      });
    }
    return { evaluations: this.evaluations, lastError: this.lastError ? this.lastError.message : null, alerts };
  }
}

function scrape(url: string, timeoutMs: number) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res: any) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: Buffer) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`metrics endpoint responded ${res.statusCode}`));
          else resolve(body);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`metrics scrape timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Rules that make sense for the game-server shape, ready to pass to
 * `new AlertManager({ rules: defaultGameRules() })`.
 */
function defaultGameRules() {
  return [
    { name: 'MailboxBacklog', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 1000, for: '10s', severity: 'warning', summary: 'Actor 邮箱积压，处理速度跟不上' },
    { name: 'ThrottledFlood', metric: 'actor_messages_throttled_total', condition: 'rate>', threshold: 50, for: '30s', severity: 'info', summary: '被限流的消息速率偏高，可能是刷屏或攻击' },
    { name: 'DeadLettersGrowing', metric: 'actor_dead_lettered_total', condition: 'increase>', threshold: 5, for: '0s', severity: 'critical', summary: '出现死信，业务消息被丢弃' },
    { name: 'ActorCrashLoop', metric: 'actor_supervisor_restarts_in_window', condition: '>', threshold: 2, for: '0s', severity: 'critical', summary: 'Actor 反复重启，可能连续崩溃' },
    { name: 'IsolatedActors', metric: 'actor_isolated_actors', condition: '==', threshold: 0, for: '0s', severity: 'info', summary: '没有 worker 隔离的 Actor（信息项，可按需删除）' },
  ];
}

module.exports = {
  AlertManager,
  parsePrometheusText,
  sumSamples,
  evaluateRule,
  parseDuration,
  consoleNotifier,
  webhookNotifier,
  defaultGameRules,
};
module.exports.AlertManager = AlertManager;
