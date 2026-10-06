// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
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
interface DeadLetterQueueOptions {
  baseDir?: string;
  filePath?: string;
  maxEntries?: number;
}

/** 一条死信：原始消息、重试次数与失败原因（原因截断到 2000 字符）。 */
interface DeadLetterEntry {
  ts: number;
  actorId: string | null;
  reason: string | null;
  retryCount: number;
  msg: unknown;
}

class DeadLetterQueue {
  readonly baseDir: string;
  readonly filePath: string;
  readonly maxEntries: number;
  _ready: Promise<unknown> | null;
  /** 立刻可用的加载 promise（构造时确定，便于类型收窄）。 */
  _writeChain: Promise<unknown>;

  constructor(options: DeadLetterQueueOptions = {}) {
    this.baseDir = options.baseDir || config.dataDir;
    this.filePath = options.filePath || path.join(this.baseDir, 'dlq.jsonl');
    this.maxEntries = options.maxEntries || 10000;
    this._ready = null;
    this._writeChain = Promise.resolve();
    fs.mkdirSync(this.baseDir, { recursive: true });
    // An explicit filePath may live elsewhere; create that directory too.
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  init(): Promise<unknown> {
    const ready = this._ready;
    if (ready !== null) return ready; // 收窄成非空，避免"可能为 null"的返回
    const started = fsp.writeFile(this.filePath, '', { flag: 'a' }).catch(() => undefined);
    this._ready = started;
    return started;
  }

  async enqueue(entry: { actorId?: string | null; reason?: unknown; retryCount?: number; msg?: unknown }): Promise<unknown> {
    const rec: DeadLetterEntry = {
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

  async _enforceLimit(): Promise<void> {
    if (!this.maxEntries) return;
    const raw = await fsp.readFile(this.filePath, 'utf8').catch(() => '');
    const lines = raw.split('\n').filter((line: string) => line.trim() !== '');
    if (lines.length <= this.maxEntries) return;
    const kept = lines.slice(lines.length - this.maxEntries);
    await fsp.writeFile(this.filePath, `${kept.join('\n')}\n`);
  }

  /** Parse defensively; unreadable lines are skipped and counted. */
  async readAll(): Promise<DeadLetterEntry[]> {
    await this.init();
    const raw: string = await fsp.readFile(this.filePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    const entries: DeadLetterEntry[] = [];
    let skipped = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as DeadLetterEntry);
      } catch {
        skipped += 1;
      }
    }
    return entries;
  }

  async list(limit = 50): Promise<DeadLetterEntry[]> {
    const all = await this.readAll();
    return all.slice(-limit);
  }

  async size(): Promise<number> {
    return (await this.readAll()).length;
  }

  async clear(): Promise<unknown> {
    this._writeChain = this._writeChain.then(() => fsp.writeFile(this.filePath, '')).catch(() => {});
    return this._writeChain;
  }
}

const dlq = new DeadLetterQueue();
module.exports = dlq;
module.exports.DeadLetterQueue = DeadLetterQueue;
