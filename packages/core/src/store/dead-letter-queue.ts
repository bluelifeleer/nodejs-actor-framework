'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config.ts');

/**
 * Dead-letter queue: messages that exhausted their retries.
 *
 * - Reads tolerate corrupt/truncated lines instead of throwing (a crash
 *   mid-append used to make `dlq list` fail forever).
 * - The file is bounded: once `maxEntries` is exceeded the oldest entries are
 *   dropped, so a failing handler cannot fill the disk.
 */
class DeadLetterQueue {
  constructor(options = {}) {
    this.baseDir = options.baseDir || config.dataDir;
    this.filePath = options.filePath || path.join(this.baseDir, 'dlq.jsonl');
    this.maxEntries = options.maxEntries || 10000;
    this._ready = null;
    this._writeChain = Promise.resolve();
    fs.mkdirSync(this.baseDir, { recursive: true });
    // An explicit filePath may live elsewhere; create that directory too.
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  init() {
    if (!this._ready) {
      this._ready = fsp.writeFile(this.filePath, '', { flag: 'a' }).catch(() => {});
    }
    return this._ready;
  }

  async enqueue(entry) {
    const rec = {
      ts: Date.now(),
      actorId: entry.actorId ?? null,
      reason: entry.reason ? String(entry.reason).slice(0, 2000) : null,
      retryCount: entry.retryCount ?? 0,
      msg: entry.msg ?? null,
    };
    this._writeChain = this._writeChain.then(async () => {
      await fsp.appendFile(this.filePath, `${JSON.stringify(rec)}\n`);
      await this._enforceLimit();
    }).catch(() => {});
    return this._writeChain;
  }

  async _enforceLimit() {
    if (!this.maxEntries) return;
    const raw = await fsp.readFile(this.filePath, 'utf8').catch(() => '');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length <= this.maxEntries) return;
    const kept = lines.slice(lines.length - this.maxEntries);
    await fsp.writeFile(this.filePath, `${kept.join('\n')}\n`);
  }

  /** Parse defensively; unreadable lines are skipped and counted. */
  async readAll() {
    await this.init();
    const raw = await fsp.readFile(this.filePath, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    const entries = [];
    let skipped = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        skipped += 1;
      }
    }
    return entries;
  }

  async list(limit = 50) {
    const all = await this.readAll();
    return all.slice(-limit);
  }

  async size() {
    return (await this.readAll()).length;
  }

  async clear() {
    this._writeChain = this._writeChain.then(() => fsp.writeFile(this.filePath, '')).catch(() => {});
    return this._writeChain;
  }
}

const dlq = new DeadLetterQueue();
module.exports = dlq;
module.exports.DeadLetterQueue = DeadLetterQueue;
