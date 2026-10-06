// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config.ts');

/**
 * 30/70 sampled logger.
 *
 * - Business/message events: 30% full record, 70% one-line summary.
 * - System events: always full (never sampled).
 *
 * Writes are fire-and-forget but tracked, so tests and shutdown can await
 * `logger.flush()`. A failing write never throws into the actor loop.
 */
interface LoggerOptions {
  logDir?: string;
  sampleRate?: number;
  maxFieldChars?: number;
  enabled?: boolean;
}

/** 一条日志记录（写进 actor.log 的一行 JSON）。 */
interface LogRecord {
  ts: number;
  op: string;
  type: 'FULL' | 'SHORT' | 'SYSTEM';
  actorId?: string;
  trace?: string | undefined;
  msg?: Record<string, unknown>;
  msgType?: unknown;
  msgId?: unknown;
  extra?: unknown;
}

class Logger {
  readonly logDir: string;
  readonly logPath: string;
  readonly sampleRate: number;
  readonly maxFieldChars: number;
  readonly enabled: boolean;
  /** 在途写入（flush 等它们）。 */
  readonly _pending: Set<Promise<unknown>>;

  constructor(options: LoggerOptions = {}) {
    this.logDir = options.logDir || config.logDir;
    this.logPath = path.join(this.logDir, 'actor.log');
    this.sampleRate = typeof options.sampleRate === 'number' ? options.sampleRate : (config.log.sampleRate as number);
    this.maxFieldChars = options.maxFieldChars ?? (config.log.maxFieldChars as number);
    this.enabled = options.enabled !== false;
    this._pending = new Set();
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch {
      /* directory creation failures surface on first write */
    }
  }

  _write(rec: LogRecord): void {
    if (!this.enabled) return;
    let line;
    try {
      line = `${JSON.stringify(rec)}\n`;
    } catch {
      return; // circular payload: drop rather than crash the actor
    }
    const p: Promise<unknown> = fsp.appendFile(this.logPath, line).catch(() => undefined);
    this._pending.add(p);
    p.finally(() => this._pending.delete(p));
  }

  _truncate(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    if (value.length <= this.maxFieldChars) return value;
    return `${value.slice(0, this.maxFieldChars)}…(${value.length} chars)`;
  }

  _safeMessage(msg: unknown): Record<string, unknown> {
    if (msg === null || typeof msg !== 'object') return { value: this._truncate(String(msg)) };
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(msg)) {
      copy[k] = typeof v === 'string' ? this._truncate(v) : v;
    }
    return copy;
  }

  /** Sampled business/message log. */
  logMessage(op: string, actorId: string, msg: unknown): void {
    const ts = Date.now();
    const traced = msg as { trace?: { traceId?: string }; type?: unknown; __msgId?: unknown } | null;
    const trace = traced !== null && traced !== undefined && traced.trace ? traced.trace.traceId : undefined;
    if (Math.random() < this.sampleRate) {
      this._write({ ts, op, actorId, type: 'FULL', trace, msg: this._safeMessage(msg) });
    } else {
      this._write({
        ts,
        op,
        actorId,
        type: 'SHORT',
        trace,
        msgType: traced ? traced.type : undefined,
        msgId: traced ? traced.__msgId : undefined,
      });
    }
  }

  /** System events are never sampled. */
  logSystem(op: string, extra?: unknown): void {
    this._write({ ts: Date.now(), op, type: 'SYSTEM', extra: extra === undefined ? null : this._safeMessage(extra) });
  }

  /** Await all in-flight writes (tests, graceful shutdown). */
  async flush(): Promise<void> {
    while (this._pending.size > 0) {
      await Promise.allSettled([...this._pending]);
    }
  }
}

const logger = new Logger();
module.exports = logger;
module.exports.Logger = Logger;
