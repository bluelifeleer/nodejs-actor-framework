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
  /** 字节上限（审计 S10），默认 64 MiB。 */
  maxBytes?: number;
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
  /** 字节上限（审计 S10）。 */
  readonly maxBytes: number;
  /** `{ lines, bytes }` 的内存视图；null 表示"还不知道，需要读一次"。 */
  _size: { lines: number; bytes: number } | null;
  _ready: Promise<unknown> | null;
  /** 立刻可用的加载 promise（构造时确定，便于类型收窄）。 */
  _writeChain: Promise<unknown>;

  constructor(options: DeadLetterQueueOptions = {}) {
    this.baseDir = options.baseDir || config.dataDir;
    this.filePath = options.filePath || path.join(this.baseDir, 'dlq.jsonl');
    this.maxEntries = options.maxEntries || 10000;
    /**
     * 审计 S10：原来只有"条数"上限、没有"字节"上限，而每条消息最大可到 8 MiB ——
     * 1 万条的上限意味着理论上 80 GB 磁盘占用。类注释却写着 "cannot fill the disk"。
     */
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this._size = null; // { lines, bytes }：已知就增量维护，避免每次 enqueue 都全量读文件
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
      const line = `${JSON.stringify(rec)}\n`;
      await fsp.appendFile(this.filePath, line);
      // 增量记账：把刚写进去的字节数交给上限检查，避免每次都全量读文件
      await this._enforceLimit(Buffer.byteLength(line, 'utf8'));
    }).catch(() => {});
    return this._writeChain;
  }

  /**
   * 审计 S10：条数**与字节**双上限，并且不再"每次 enqueue 都全量读文件"。
   *
   * 记账是增量的：`enqueue` 写成功后更新 `_size`；只有第一次（或裁剪后）才读盘对齐。
   */
  async _enforceLimit(addedBytes = 0): Promise<void> {
    if (!this.maxEntries && !this.maxBytes) return;
    if (this._size === null) {
      const raw = await fsp.readFile(this.filePath, 'utf8').catch(() => '');
      const lines = raw.split('\n').filter((line: string) => line.trim() !== '');
      this._size = { lines: lines.length, bytes: Buffer.byteLength(raw, 'utf8') };
    } else if (addedBytes > 0) {
      this._size = { lines: this._size.lines + 1, bytes: this._size.bytes + addedBytes };
    }
    const overEntries = this.maxEntries > 0 && this._size.lines > this.maxEntries;
    const overBytes = this.maxBytes > 0 && this._size.bytes > this.maxBytes;
    if (!overEntries && !overBytes) return;

    const raw = await fsp.readFile(this.filePath, 'utf8').catch(() => '');
    const lines = raw.split('\n').filter((line: string) => line.trim() !== '');
    // 先从最老的开始丢，直到同时满足条数与字节两条上限
    let kept = lines;
    const fits = (candidate: string[]): boolean => {
      const bytes = candidate.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);
      return (this.maxEntries <= 0 || candidate.length <= this.maxEntries) && (this.maxBytes <= 0 || bytes <= this.maxBytes);
    };
    while (kept.length > 0 && !fits(kept)) kept = kept.slice(1);
    const text = kept.length > 0 ? `${kept.join('\n')}\n` : '';
    await fsp.writeFile(this.filePath, text);
    this._size = { lines: kept.length, bytes: Buffer.byteLength(text, 'utf8') };
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
