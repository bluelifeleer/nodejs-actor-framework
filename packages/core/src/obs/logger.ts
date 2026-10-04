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
class Logger {
  constructor(options = {}) {
    this.logDir = options.logDir || config.logDir;
    this.logPath = path.join(this.logDir, 'actor.log');
    this.sampleRate = typeof options.sampleRate === 'number' ? options.sampleRate : config.log.sampleRate;
    this.maxFieldChars = options.maxFieldChars || config.log.maxFieldChars;
    this.enabled = options.enabled !== false;
    this._pending = new Set();
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch {
      /* directory creation failures surface on first write */
    }
  }

  _write(rec) {
    if (!this.enabled) return;
    let line;
    try {
      line = `${JSON.stringify(rec)}\n`;
    } catch {
      return; // circular payload: drop rather than crash the actor
    }
    const p = fsp.appendFile(this.logPath, line).catch(() => {});
    this._pending.add(p);
    p.finally(() => this._pending.delete(p));
  }

  _truncate(value) {
    if (typeof value !== 'string') return value;
    if (value.length <= this.maxFieldChars) return value;
    return `${value.slice(0, this.maxFieldChars)}…(${value.length} chars)`;
  }

  _safeMessage(msg) {
    if (!msg || typeof msg !== 'object') return { value: this._truncate(String(msg)) };
    const copy = {};
    for (const [k, v] of Object.entries(msg)) {
      copy[k] = typeof v === 'string' ? this._truncate(v) : v;
    }
    return copy;
  }

  /** Sampled business/message log. */
  logMessage(op, actorId, msg) {
    const ts = Date.now();
    const trace = msg && msg.trace ? msg.trace.traceId : undefined;
    if (Math.random() < this.sampleRate) {
      this._write({ ts, op, actorId, type: 'FULL', trace, msg: this._safeMessage(msg) });
    } else {
      this._write({
        ts,
        op,
        actorId,
        type: 'SHORT',
        trace,
        msgType: msg ? msg.type : undefined,
        msgId: msg ? msg.__msgId : undefined,
      });
    }
  }

  /** System events are never sampled. */
  logSystem(op, extra) {
    this._write({ ts: Date.now(), op, type: 'SYSTEM', extra: extra === undefined ? null : this._safeMessage(extra) });
  }

  /** Await all in-flight writes (tests, graceful shutdown). */
  async flush() {
    while (this._pending.size > 0) {
      await Promise.allSettled([...this._pending]);
    }
  }
}

const logger = new Logger();
module.exports = logger;
module.exports.Logger = Logger;
