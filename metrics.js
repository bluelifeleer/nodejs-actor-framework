'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');

const COUNTER_FIELDS = [
  'received',
  'handled',
  'failed',
  'retries',
  'dlq',
  'dropped',
  'throttled',
  'recovered',
  'batches',
  'totalLatencyMs',
  'maxLatencyMs',
];

function blank() {
  return {
    received: 0,
    handled: 0,
    failed: 0,
    retries: 0,
    dlq: 0,
    dropped: 0,
    throttled: 0,
    recovered: 0,
    batches: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
  };
}

/**
 * Worker-side counter accumulator.
 *
 * Actors run inside worker threads, which do NOT share module state with the
 * main thread. Each worker therefore accumulates a delta and posts it to the
 * main process, where `Metrics.observe()` merges it. This is what makes
 * `metrics dump` show real numbers instead of `{}`.
 */
class Counters {
  constructor() {
    this.fields = {};
  }

  inc(field, value = 1) {
    this.fields[field] = (this.fields[field] || 0) + value;
  }

  addLatency(ms) {
    this.inc('totalLatencyMs', ms);
    if (ms > (this.fields.maxLatencyMs || 0)) this.fields.maxLatencyMs = ms;
  }

  get isEmpty() {
    return Object.keys(this.fields).length === 0;
  }

  /** Return the accumulated delta and reset. */
  take() {
    const delta = this.fields;
    this.fields = {};
    return delta;
  }
}

/** Main-process metrics store. */
class Metrics {
  constructor(options = {}) {
    this.data = new Map();
    this.logDir = options.logDir || config.logDir;
    this.logPath = path.join(this.logDir, 'metrics.log');
    this.enabled = options.enabled !== false;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch {
      /* surfaced on first dump */
    }
  }

  initActor(actorId) {
    if (!this.data.has(actorId)) this.data.set(actorId, blank());
    return this.data.get(actorId);
  }

  /** Merge a delta produced by a worker thread. */
  observe(actorId, delta) {
    const entry = this.initActor(actorId);
    for (const [field, value] of Object.entries(delta || {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (field === 'maxLatencyMs') {
        entry.maxLatencyMs = Math.max(entry.maxLatencyMs || 0, value);
      } else if (field === 'avgLatencyMs') {
        continue; // derived on read
      } else if (COUNTER_FIELDS.includes(field)) {
        entry[field] += value;
      } else {
        entry[field] = (entry[field] || 0) + value;
      }
    }
    return entry;
  }

  inc(actorId, field, value = 1) {
    const entry = this.initActor(actorId);
    entry[field] = (entry[field] || 0) + value;
    return entry;
  }

  addLatency(actorId, ms) {
    const entry = this.initActor(actorId);
    entry.totalLatencyMs += ms;
    if (ms > entry.maxLatencyMs) entry.maxLatencyMs = ms;
    return entry;
  }

  get(actorId) {
    return this.data.get(actorId);
  }

  reset(actorId) {
    if (actorId === undefined) this.data.clear();
    else this.data.delete(actorId);
  }

  snapshot() {
    const snap = {};
    for (const [actorId, m] of this.data) {
      snap[actorId] = {
        ...m,
        avgLatencyMs: m.handled ? Math.round(m.totalLatencyMs / m.handled) : 0,
      };
    }
    return snap;
  }

  /** Snapshot + append it to metrics.log (as before), but with real data. */
  dump({ persist = true } = {}) {
    const snap = this.snapshot();
    if (persist && this.enabled) {
      fsp.appendFile(this.logPath, `${JSON.stringify({ ts: Date.now(), snapshot: snap })}\n`).catch(() => {});
    }
    return snap;
  }
}

const metrics = new Metrics();
module.exports = metrics;
module.exports.Metrics = Metrics;
module.exports.Counters = Counters;
module.exports.COUNTER_FIELDS = COUNTER_FIELDS;
