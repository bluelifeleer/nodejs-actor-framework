// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config.ts');

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

/** 计数器字段名（与 ActorCell.counters 保持一致）。 */
type CounterField = (typeof COUNTER_FIELDS)[number] | string;

/** 一组计数器（每个 actor 一份）。 */
interface CounterValues {
  received: number;
  handled: number;
  failed: number;
  retries: number;
  dlq: number;
  dropped: number;
  throttled: number;
  recovered: number;
  batches: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  [field: string]: number;
}

function blank(): CounterValues {
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
  /** field -> 累计增量。 */
  fields: Record<string, number>;

  constructor() {
    this.fields = {};
  }

  inc(field: string, value = 1): void {
    this.fields[field] = (this.fields[field] ?? 0) + value;
  }

  addLatency(ms: number): void {
    this.inc('totalLatencyMs', ms);
    if (ms > (this.fields.maxLatencyMs ?? 0)) this.fields.maxLatencyMs = ms;
  }

  get isEmpty(): boolean {
    return Object.keys(this.fields).length === 0;
  }

  /** Return the accumulated delta and reset. */
  take(): Record<string, number> {
    const delta = this.fields;
    this.fields = {};
    return delta;
  }
}

/** Main-process metrics store. */
interface MetricsOptions {
  logDir?: string;
  enabled?: boolean;
}

class Metrics {
  /** actorId -> 计数器。 */
  readonly data: Map<string, CounterValues>;
  readonly logDir: string;
  readonly logPath: string;
  readonly enabled: boolean;

  constructor(options: MetricsOptions = {}) {
    this.data = new Map();
    this.logDir = options.logDir ?? config.logDir;
    this.logPath = path.join(this.logDir, 'metrics.log');
    this.enabled = options.enabled !== false;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch {
      /* surfaced on first dump */
    }
  }

  initActor(actorId: string): CounterValues {
    let entry = this.data.get(actorId);
    if (entry === undefined) {
      entry = blank();
      this.data.set(actorId, entry);
    }
    return entry;
  }

  /** Merge a delta produced by a worker thread. */
  observe(actorId: string, delta: Record<string, number> | null | undefined): CounterValues {
    const entry = this.initActor(actorId);
    for (const [field, value] of Object.entries(delta || {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (field === 'maxLatencyMs') {
        entry.maxLatencyMs = Math.max(entry.maxLatencyMs || 0, value);
      } else if (field === 'avgLatencyMs') {
        continue; // derived on read
      } else if (COUNTER_FIELDS.includes(field)) {
        entry[field] = (entry[field] ?? 0) + value;
      } else {
        entry[field] = (entry[field] ?? 0) + value;
      }
    }
    return entry;
  }

  inc(actorId: string, field: string, value = 1): CounterValues {
    const entry = this.initActor(actorId);
    entry[field] = (entry[field] ?? 0) + value;
    return entry;
  }

  addLatency(actorId: string, ms: number): CounterValues {
    const entry = this.initActor(actorId);
    entry.totalLatencyMs += ms;
    if (ms > entry.maxLatencyMs) entry.maxLatencyMs = ms;
    return entry;
  }

  get(actorId: string): CounterValues | undefined {
    return this.data.get(actorId);
  }

  /** 不清 actorId 就清全部。 */
  reset(actorId?: string): void {
    if (actorId === undefined) this.data.clear();
    else this.data.delete(actorId);
  }

  /** 每个 actor 的计数器 + 派生的 avgLatencyMs（读取时算，不落库）。 */
  snapshot(): Record<string, CounterValues & { avgLatencyMs: number }> {
    const snap: Record<string, CounterValues & { avgLatencyMs: number }> = {};
    for (const [actorId, m] of this.data) {
      snap[actorId] = {
        ...m,
        avgLatencyMs: m.handled ? Math.round(m.totalLatencyMs / m.handled) : 0,
      };
    }
    return snap;
  }

  /** Snapshot + append it to metrics.log (as before), but with real data. */
  dump({ persist = true }: { persist?: boolean } = {}): Record<string, CounterValues & { avgLatencyMs: number }> {
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
