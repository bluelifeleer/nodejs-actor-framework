// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config.ts');
const { fileName } = require('./naming.ts');

/**
 * LevelDB backend (optional).
 *
 * `classic-level` is declared as an *optional* dependency: the framework keeps
 * working with zero installed dependencies on the `file` backend, and this
 * adapter gives O(1) acknowledgement plus LevelDB compaction when the binding
 * is present. If it is missing, the store fails with an actionable message
 * instead of silently falling back to a different durability guarantee.
 *
 * Layout: one LevelDB directory per actor.
 *
 *   <root>/<safe actor name>/        keys: m!<paddedSeq>!<msgId> -> JSON message
 *
 * Per-actor directories matter here: actors run in separate worker threads and
 * LevelDB takes an exclusive lock on its directory, so a single shared database
 * could not be opened concurrently by several workers. Sharding per actor keeps
 * the actor's data self-contained and lock-free between actors.
 *
 * The padded sequence keeps range scans in enqueue order (message ids are
 * random UUIDs and would otherwise come back unordered).
 */

const SEQ_WIDTH = 20;
const KEY_PREFIX = 'm!';

/**
 * classic-level 是**可选依赖**、本仓库并未安装（所以拿不到官方类型）。
 * 这里只声明我们用到的形状；上游 API 若变化，会在运行时明确报错，而不是被类型伪装成安全。
 */
interface ClassicLevelModule {
  ClassicLevel: new (location: string, options?: Record<string, unknown>) => ClassicLevelDb;
}

interface ClassicLevelDb {
  open(): Promise<void>;
  close(): Promise<void>;
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  batch(ops: unknown[]): Promise<void>;
  iterator(options?: Record<string, unknown>): AsyncIterable<[string, string]>;
  /** 有些版本才有：用于手动触发范围压缩。 */
  compactRange?(start: string, end: string): Promise<void>;
}

let classicLevel: ClassicLevelModule | null = null;
let loadError: Error | null = null;

function loadClassicLevel(): ClassicLevelModule {
  if (classicLevel !== null) return classicLevel;
  if (loadError !== null) throw loadError;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    classicLevel = require('classic-level') as ClassicLevelModule;
    return classicLevel;
  } catch (err) {
    loadError = new Error(
      'the "level" store backend needs the optional dependency "classic-level": ' +
        `run "npm install classic-level" (or use ACTOR_STORE=file). Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw loadError;
  }
}

function isAvailable(): { available: boolean; reason?: string } {
  try {
    loadClassicLevel();
    return { available: true };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

interface LevelStoreOptions {
  root?: string;
  levelPath?: string;
}

class LevelStore {
  readonly root: string;
  /** actorId -> LevelDB 句柄。 */
  readonly dbs: Map<string, ClassicLevelDb>;
  /** actorId -> msgId -> key。 */
  readonly keys: Map<string, Map<string, string>>;
  /** actorId -> 下一个序号。 */
  readonly seq: Map<string, bigint>;
  /** actorId -> 写串行化。 */
  readonly chain: Map<string, Promise<unknown>>;

  constructor(options: LevelStoreOptions = {}) {
    this.root = options.root ?? options.levelPath ?? (config.store.levelPath as string) ?? path.join(config.dataDir, 'level');
    fs.mkdirSync(this.root, { recursive: true });
    this.dbs = new Map();
    this.keys = new Map();
    this.seq = new Map();
    this.chain = new Map();
  }

  get backendName(): string {
    return 'level';
  }

  pathFor(actorId: string): string {
    return path.join(this.root, fileName(actorId, ''));
  }

  _withLock<T>(actorId: string, fn: () => Promise<T> | T): Promise<T> {
    const key = String(actorId);
    const prev = this.chain.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn) as Promise<T>;
    this.chain.set(key, next.catch(() => undefined));
    return next;
  }

  async _db(actorId: string): Promise<ClassicLevelDb> {
    const key = String(actorId);
    let db = this.dbs.get(key);
    if (db) return db;
    const { ClassicLevel } = loadClassicLevel();
    db = new ClassicLevel(this.pathFor(key), { keyEncoding: 'utf8', valueEncoding: 'utf8' });
    await db.open();
    this.dbs.set(key, db);
    return db;
  }

  _keyMap(actorId: string): Map<string, string> {
    const key = String(actorId);
    let map = this.keys.get(key);
    if (map === undefined) {
      map = new Map<string, string>();
      this.keys.set(key, map);
    }
    return map;
  }

  _key(seq: bigint, msgId: string): string {
    return `${KEY_PREFIX}${String(seq).padStart(SEQ_WIDTH, '0')}!${msgId}`;
  }

  /** Seed the sequence counter from the highest existing key. */
  async _nextSeq(actorId: string): Promise<bigint> {
    const key = String(actorId);
    const current = this.seq.get(key);
    if (current !== undefined) {
      this.seq.set(key, current + 1n);
      return current;
    }
    const db = await this._db(actorId);
    let highest = 0n;
    for await (const [k] of db.iterator({ gte: KEY_PREFIX, lt: `${KEY_PREFIX}~`, reverse: true, limit: 1 })) {
      const seqPart = String(k).slice(KEY_PREFIX.length).split('!')[0] ?? '';
      try {
        highest = BigInt(seqPart);
      } catch {
        highest = 0n;
      }
    }
    this.seq.set(key, highest + 2n);
    return highest + 1n;
  }

  async append(actorId: string, msg: unknown): Promise<Record<string, unknown>> {
    const record: Record<string, unknown> = msg !== null && typeof msg === 'object' ? (msg as Record<string, unknown>) : { type: 'raw', value: msg };
    const msgId = typeof record.__msgId === 'string' ? record.__msgId : crypto.randomUUID();
    record.__msgId = msgId;
    return this._withLock(actorId, async () => {
      const db = await this._db(actorId);
      const seq = await this._nextSeq(actorId);
      const key = this._key(seq, msgId);
      await db.put(key, JSON.stringify(record));
      this._keyMap(actorId).set(msgId, key);
      return record;
    });
  }

  async ack(actorId: string, msgIds: string | string[]): Promise<number> {
    const ids = Array.isArray(msgIds) ? msgIds : [msgIds];
    return this._withLock(actorId, async () => {
      if (ids.length === 0) return 0;
      const map = this._keyMap(actorId);
      if (map.size === 0) await this._loadLocked(actorId);
      const keys = [];
      for (const id of ids) {
        const key = map.get(id);
        if (!key) continue;
        keys.push(key);
        map.delete(id);
      }
      if (keys.length === 0) return 0;
      const db = await this._db(actorId);
      await db.batch(keys.map((key) => ({ type: 'del', key })));
      return keys.length;
    });
  }

  async load(actorId: string): Promise<Record<string, unknown>[]> {
    return this._withLock(actorId, async () => this._loadLocked(actorId));
  }

  /** Caller must hold the per-actor lock. */
  async _loadLocked(actorId: string): Promise<Record<string, unknown>[]> {
    const db = await this._db(actorId);
    const map = this._keyMap(actorId);
    map.clear();
    const messages = [];
    let highest = 0n;
    for await (const [key, value] of db.iterator({ gte: KEY_PREFIX, lt: `${KEY_PREFIX}~` })) {
      const seqPart = String(key).slice(KEY_PREFIX.length).split('!')[0] ?? '';
      try {
        const seq = BigInt(seqPart);
        if (seq > highest) highest = seq;
      } catch {
        /* ignore malformed key */
      }
      let record;
      try {
        record = JSON.parse(value);
      } catch {
        continue; // corrupted value: skip rather than fail the whole load
      }
      map.set(record.__msgId, key);
      messages.push(record);
    }
    this.seq.set(String(actorId), highest + 1n);
    return messages;
  }

  async clear(actorId: string): Promise<void> {
    return this._withLock(actorId, async () => {
      const db = await this._db(actorId);
      const keys = [];
      for await (const [key] of db.iterator({ gte: KEY_PREFIX, lt: `${KEY_PREFIX}~` })) keys.push(key);
      if (keys.length > 0) await db.batch(keys.map((key) => ({ type: 'del', key })));
      this._keyMap(actorId).clear();
      this.seq.set(String(actorId), 0n);
    });
  }

  async pendingCount(actorId: string): Promise<number> {
    return this._withLock(actorId, async () => {
      const db = await this._db(actorId);
      let count = 0;
      for await (const [] of db.iterator({ gte: KEY_PREFIX, lt: `${KEY_PREFIX}~` })) count += 1;
      return count;
    });
  }

  /** LevelDB compacts itself; nothing to do, but keep the interface uniform. */
  async compact(actorId?: string): Promise<unknown> {
    if (actorId === undefined) {
      const results: unknown[] = [];
      for (const key of [...this.dbs.keys()]) results.push(await this.compact(key));
      return results;
    }
    const db = await this._db(actorId);
    if (typeof db.compactRange === 'function') await db.compactRange(KEY_PREFIX, `${KEY_PREFIX}~`);
    return { before: null, after: null, records: await this.pendingCount(actorId) };
  }

  async stats(): Promise<Record<string, unknown>> {
    return { backend: 'level', actors: this.dbs.size, bytes: null, root: this.root };
  }

  async close(): Promise<void> {
    for (const db of this.dbs.values()) {
      try {
        await db.close();
      } catch {
        /* already closed */
      }
    }
    this.dbs.clear();
    this.keys.clear();
  }
}

module.exports = LevelStore;
module.exports.LevelStore = LevelStore;
module.exports.isAvailable = isAvailable;
