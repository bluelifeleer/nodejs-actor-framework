// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config.ts');
const { crc32 } = require('./crc32.ts');
const { fileName, legacyFileName } = require('./naming.ts');
const { Manifest } = require('./manifest.ts');

/**
 * Default, dependency-free persistence backend: an append-only log per actor.
 *
 * Record framing (both record kinds share it):
 *
 *   uint32_be jsonLength | uint32_be crc32(json) | json
 *
 * Two record kinds are appended:
 *
 *   { t: 'm', id, msg }   a message entered the mailbox
 *   { t: 'a', ids: [...] } those messages reached a terminal state
 *
 * Acknowledgements are appended, not applied in place, which makes them O(1)
 * AND durable: a reopen replays the log and the ack records remove exactly the
 * right messages. (Keeping acks only in memory until compaction would resurrect
 * acknowledged messages after a crash, i.e. deliver them twice.)
 *
 * The log is rewritten ("compacted") once dead records dominate, so the file
 * stays bounded without a full rewrite per acknowledgement. Compaction is
 * atomic (tmp file + rename) and writes are serialised per actor.
 *
 * Recovery tolerates a torn tail or a corrupted record: only the unreadable
 * record is skipped, everything before it survives. Older files containing bare
 * message records (no `t` field) are still readable.
 */

const HEADER_BYTES = 8;

interface FileStoreOptions {
  /** 进程内 actor 缓存上限（审计 F9），默认 1024。 */
  maxTrackedActors?: number;
  baseDir?: string;
  compactionThresholdBytes?: number;
  maxFileBytes?: number;
  manifest?: InstanceType<typeof Manifest>;
}

/** 一条待确认的消息（含它占用的字节数，用于判断何时压缩）。 */
interface StoredMessage {
  msg: Record<string, unknown>;
  bytes: number;
}

/** 单个 actor 的内存索引。 */
interface ActorState {
  records: Map<string, StoredMessage>;
  liveBytes: number;
  fileBytes: number;
  loaded: boolean;
}

class FileStore {
  readonly baseDir: string;
  readonly compactionThresholdBytes: number;
  readonly maxFileBytes: number;
  /** actor id -> 磁盘文件索引（运维用它枚举 actor）。 */
  readonly manifest: InstanceType<typeof Manifest>;
  /** actor id -> 内存索引。 */
  readonly index: Map<string, ActorState>;
  /** actor id -> 写入串行化（同一 actor 的写不并发）。 */
  readonly chain: Map<string, Promise<unknown>>;
  /** 进程内缓存的 actor 数上限（审计 F9）：超过就按最久未用淘汰。 */
  readonly maxTrackedActors: number;
  /** 恢复时跳过的损坏记录数（诊断用：损坏必须可见，而不是静默丢数据）。 */
  skippedRecords: number;
  /** 从旧格式迁移过来的 actor 数。 */
  migrated: number;

  constructor(options: FileStoreOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(config.dataDir, 'msg_store');
    this.compactionThresholdBytes = options.compactionThresholdBytes ?? (config.store.compactionThresholdBytes as number);
    this.maxFileBytes = options.maxFileBytes ?? (config.store.maxFileBytes as number);
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.manifest = options.manifest ?? new Manifest(this.baseDir);
    this.index = new Map();
    this.chain = new Map();
    this.maxTrackedActors = (options.maxTrackedActors as number | undefined) ?? 1024;
    this.skippedRecords = 0;
    this.migrated = 0;
  }

  get backendName(): string {
    return 'file';
  }

  pathFor(actorId: string): string {
    return path.join(this.baseDir, fileName(actorId));
  }

  _state(actorId: string): ActorState {
    const key = String(actorId);
    const cached = this.index.get(key);
    if (cached !== undefined) {
      // 触一下 LRU 顺序（Map 保持插入序）：淘汰时丢的是最久没用的那个
      this.index.delete(key);
      this.index.set(key, cached);
      return cached;
    }
    const state: ActorState = { records: new Map(), liveBytes: 0, fileBytes: 0, loaded: false };
    this.index.set(key, state);
    /**
     * 审计 F9：`index` 以 actor 路径为键、只增不减 —— actor id 动态时每个出现过的 id
     * 永久占一份内存（records + 两个计数器）。
     *
     * 淘汰是**安全**的：`_state` 给出的 state 带 `loaded: false`，下一次访问会由
     * `_loadInto()` 从盘上重放重建（见 append/load 的分支）。所以这里只需要一个上界。
     */
    while (this.index.size > this.maxTrackedActors) {
      const oldest = this.index.keys().next();
      if (oldest.done === true || oldest.value === key) break;
      this.index.delete(oldest.value);
    }
    return state;
  }

  /** 同一 actor 的写操作串行化（读和写都排队，避免交叉）。 */
  _withLock<T>(actorId: string, fn: () => Promise<T> | T): Promise<T> {
    const key = String(actorId);
    const prev = this.chain.get(key) ?? Promise.resolve();
    const next: Promise<T> = prev.then(fn, fn) as Promise<T>;
    const tail = next.catch(() => undefined);
    this.chain.set(key, tail);
    // 审计 F9：链一 settle 就摘掉（否则每个用过的 actor id 永久留一个已 settle 的 Promise）
    void tail.then(() => {
      if (this.chain.get(key) === tail) this.chain.delete(key);
    });
    return next;
  }

  _frame(payload: Record<string, unknown>): Buffer {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const head = Buffer.allocUnsafe(HEADER_BYTES);
    head.writeUInt32BE(body.length, 0);
    head.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([head, body]);
  }

  /** Queue a message durably. Assigns a `__msgId` when missing. */
  async append(actorId: string, msg: unknown): Promise<Record<string, unknown>> {
    const record: Record<string, unknown> = msg !== null && typeof msg === 'object' ? (msg as Record<string, unknown>) : { type: 'raw', value: msg };
    const msgId = typeof record.__msgId === 'string' ? record.__msgId : crypto.randomUUID();
    record.__msgId = msgId;
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      if (!state.loaded) await this._loadInto(actorId, state);

      const frame = this._frame({ t: 'm', id: msgId, msg: record });
      await fsp.appendFile(this.pathFor(actorId), frame);
      await this.manifest.record(actorId, fileName(actorId));

      const previous = state.records.get(msgId);
      if (previous !== undefined) state.liveBytes -= previous.bytes;
      state.records.set(msgId, { msg: record, bytes: frame.length });
      state.liveBytes += frame.length;
      state.fileBytes += frame.length;

      await this._maybeCompact(actorId, state);
      return record;
    });
  }

  /**
   * Acknowledge one or more messages. The ack is appended to the log, so it
   * survives a crash without rewriting the file.
   */
  async ack(actorId: string, msgIds: string | string[]): Promise<number> {
    const ids = Array.isArray(msgIds) ? msgIds : [msgIds];
    if (ids.length === 0) return 0;
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      if (!state.loaded) await this._loadInto(actorId, state);

      const present = ids.filter((id) => state.records.has(id));
      if (present.length === 0) return 0;

      const frame = this._frame({ t: 'a', ids: present });
      await fsp.appendFile(this.pathFor(actorId), frame);
      state.fileBytes += frame.length;

      for (const id of present) {
        const entry = state.records.get(id);
        if (entry === undefined) continue;
        state.liveBytes -= entry.bytes;
        state.records.delete(id);
      }

      await this._maybeCompact(actorId, state);
      return present.length;
    });
  }

  async _maybeCompact(actorId: string, state: ActorState): Promise<void> {
    const dead = state.fileBytes - state.liveBytes;
    const threshold = Math.max(this.compactionThresholdBytes, state.liveBytes);
    if (dead < threshold) return;
    await this._compactLocked(actorId, state);
  }

  /** Rewrite the log with only live messages (caller must hold the lock). */
  async _compactLocked(actorId: string, state: ActorState): Promise<{ before: number; after: number; records: number }> {
    const before = state.fileBytes;
    const target = this.pathFor(actorId);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const parts: Buffer[] = [];
    for (const { msg } of state.records.values()) parts.push(this._frame({ t: 'm', id: msg.__msgId, msg }));
    await fsp.writeFile(tmp, Buffer.concat(parts));
    await fsp.rename(tmp, target);
    state.liveBytes = parts.reduce((sum, b) => sum + b.length, 0);
    state.fileBytes = state.liveBytes;
    return { before, after: state.fileBytes, records: state.records.size };
  }

  /** Public compaction entry point (takes the lock itself). */
  async compact(actorId?: string): Promise<unknown> {
    if (actorId === undefined) {
      // 不指定 actor 就压缩全部（运维入口）
      const results: unknown[] = [];
      for (const key of [...this.index.keys()]) results.push(await this.compact(key));
      return results;
    }
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      if (!state.loaded) await this._loadInto(actorId, state);
      return this._compactLocked(actorId, state);
    });
  }

  /** Replay the log into the in-memory index. Caller must hold the lock. */
  async _loadInto(actorId: string, state: ActorState): Promise<void> {
    await this._migrateLegacy(actorId);
    let buf;
    try {
      buf = await fsp.readFile(this.pathFor(actorId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        state.records = new Map();
        state.liveBytes = 0;
        state.fileBytes = 0;
        state.loaded = true;
        return;
      }
      throw err;
    }

    const records = new Map();
    let liveBytes = 0;
    let offset = 0;
    let skipped = 0;

    while (offset + HEADER_BYTES <= buf.length) {
      const len = buf.readUInt32BE(offset);
      const expected = buf.readUInt32BE(offset + 4);
      const start = offset + HEADER_BYTES;
      const end = start + len;
      if (len === 0 || end > buf.length) break; // torn tail from a crash
      const body = buf.subarray(start, end);
      offset = end;

      if (crc32(body) !== expected) {
        skipped += 1;
        continue; // corrupted record: skip only this one
      }
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        skipped += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object') {
        skipped += 1;
        continue;
      }

      const bytes = HEADER_BYTES + len;
      if (parsed.t === 'a' && Array.isArray(parsed.ids)) {
        for (const id of parsed.ids) {
          const entry = records.get(id);
          if (!entry) continue;
          liveBytes -= entry.bytes;
          records.delete(id);
        }
        continue;
      }

      // 'm' records, plus legacy bare-message records (no `t` field).
      const msg = parsed.t === 'm' ? parsed.msg : parsed;
      const id = (parsed.t === 'm' ? parsed.id : parsed.__msgId) || crypto.randomUUID();
      if (!msg || typeof msg !== 'object') {
        skipped += 1;
        continue;
      }
      if (!msg.__msgId) msg.__msgId = id;
      const previous = records.get(id);
      if (previous) liveBytes -= previous.bytes; // duplicate: newest wins
      records.set(id, { msg, bytes });
      liveBytes += bytes;
    }

    state.records = records;
    state.liveBytes = liveBytes;
    // Only the well-formed region counts: a torn tail is dropped on the next
    // compaction and must not inflate the dead-byte accounting.
    state.fileBytes = offset;
    state.loaded = true;
    this.skippedRecords += skipped;
  }

  /** Read durable messages in enqueue order, skipping corrupt records. */
  async load(actorId: string): Promise<Record<string, unknown>[]> {
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      await this._loadInto(actorId, state);
      return [...state.records.values()].map((entry) => entry.msg);
    });
  }

  async clear(actorId: string): Promise<void> {
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      state.records = new Map();
      state.liveBytes = 0;
      state.fileBytes = 0;
      state.loaded = true;
      await fsp.writeFile(this.pathFor(actorId), '');
    });
  }

  async pendingCount(actorId: string): Promise<number> {
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      if (!state.loaded) await this._loadInto(actorId, state);
      return state.records.size;
    });
  }

  /**
   * Upgrade a pre-1.1 `.jsonl` line-delimited file to the framed log.
   * The legacy file is renamed rather than deleted, so nothing is destroyed.
   */
  async _migrateLegacy(actorId: string): Promise<boolean> {
    const target = this.pathFor(actorId);
    if (fs.existsSync(target)) return false;
    const legacy = path.join(this.baseDir, legacyFileName(actorId));
    if (!fs.existsSync(legacy)) return false;

    let raw;
    try {
      raw = await fsp.readFile(legacy, 'utf8');
    } catch {
      return false;
    }
    const parts = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // legacy torn line
      }
      if (!msg || typeof msg !== 'object') continue;
      if (!msg.__msgId) msg.__msgId = crypto.randomUUID();
      parts.push(this._frame({ t: 'm', id: msg.__msgId, msg }));
    }
    await fsp.writeFile(target, Buffer.concat(parts));
    await fsp.rename(legacy, `${legacy}.migrated`);
    await this.manifest.record(actorId, fileName(actorId));
    this.migrated += 1;
    return true;
  }

  /** Actor ids this store knows about (from the manifest). */
  async listActors(): Promise<{ actorId: string; file: string; updatedAt: number }[]> {
    return this.manifest.list();
  }

  async stats(): Promise<Record<string, unknown>> {
    let files = [];
    try {
      files = await fsp.readdir(this.baseDir);
    } catch {
      return { backend: 'file', actors: 0, bytes: 0 };
    }
    let bytes = 0;
    let actors = 0;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      try {
        bytes += (await fsp.stat(path.join(this.baseDir, file))).size;
        actors += 1;
      } catch {
        /* vanished */
      }
    }
    return { backend: 'file', actors, bytes };
  }

  async close(): Promise<void> {
    /* writes are not streamed, so there is nothing to flush */
  }
}

module.exports = FileStore;
module.exports.FileStore = FileStore;
module.exports.HEADER_BYTES = HEADER_BYTES;
