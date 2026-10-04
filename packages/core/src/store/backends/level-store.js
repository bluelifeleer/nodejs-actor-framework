'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { fileName } = require('./naming');

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

let classicLevel = null;
let loadError = null;

function loadClassicLevel() {
  if (classicLevel) return classicLevel;
  if (loadError) throw loadError;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    classicLevel = require('classic-level');
    return classicLevel;
  } catch (err) {
    loadError = new Error(
      'the "level" store backend needs the optional dependency "classic-level": ' +
        `run "npm install classic-level" (or use ACTOR_STORE=file). Original error: ${err.message}`,
    );
    throw loadError;
  }
}

function isAvailable() {
  try {
    loadClassicLevel();
    return { available: true };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

class LevelStore {
  constructor(options = {}) {
    this.root = options.root || options.levelPath || config.store.levelPath
      || path.join(config.dataDir, 'level');
    fs.mkdirSync(this.root, { recursive: true });
    /** @type {Map<string, object>} actorId -> ClassicLevel */
    this.dbs = new Map();
    /** @type {Map<string, Map<string, string>>} actorId -> msgId -> key */
    this.keys = new Map();
    /** @type {Map<string, bigint>} actorId -> next sequence */
    this.seq = new Map();
    /** @type {Map<string, Promise<any>>} per-actor serialisation */
    this.chain = new Map();
  }

  get backendName() {
    return 'level';
  }

  pathFor(actorId) {
    return path.join(this.root, fileName(actorId, ''));
  }

  _withLock(actorId, fn) {
    const key = String(actorId);
    const prev = this.chain.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.chain.set(key, next.catch(() => {}));
    return next;
  }

  async _db(actorId) {
    const key = String(actorId);
    let db = this.dbs.get(key);
    if (db) return db;
    const { ClassicLevel } = loadClassicLevel();
    db = new ClassicLevel(this.pathFor(key), { keyEncoding: 'utf8', valueEncoding: 'utf8' });
    await db.open();
    this.dbs.set(key, db);
    return db;
  }

  _keyMap(actorId) {
    const key = String(actorId);
    if (!this.keys.has(key)) this.keys.set(key, new Map());
    return this.keys.get(key);
  }

  _key(seq, msgId) {
    return `${KEY_PREFIX}${String(seq).padStart(SEQ_WIDTH, '0')}!${msgId}`;
  }

  /** Seed the sequence counter from the highest existing key. */
  async _nextSeq(actorId) {
    const key = String(actorId);
    if (this.seq.has(key)) {
      const next = this.seq.get(key);
      this.seq.set(key, next + 1n);
      return next;
    }
    const db = await this._db(actorId);
    let highest = 0n;
    for await (const [k] of db.iterator({ gte: KEY_PREFIX, lt: `${KEY_PREFIX}~`, reverse: true, limit: 1 })) {
      const seqPart = String(k).slice(KEY_PREFIX.length).split('!')[0];
      try {
        highest = BigInt(seqPart);
      } catch {
        highest = 0n;
      }
    }
    this.seq.set(key, highest + 2n);
    return highest + 1n;
  }

  async append(actorId, msg) {
    const record = msg && typeof msg === 'object' ? msg : { type: 'raw', value: msg };
    if (!record.__msgId) record.__msgId = crypto.randomUUID();
    return this._withLock(actorId, async () => {
      const db = await this._db(actorId);
      const seq = await this._nextSeq(actorId);
      const key = this._key(seq, record.__msgId);
      await db.put(key, JSON.stringify(record));
      this._keyMap(actorId).set(record.__msgId, key);
      return record;
    });
  }

  async ack(actorId, msgIds) {
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

  async load(actorId) {
    return this._withLock(actorId, async () => this._loadLocked(actorId));
  }

  /** Caller must hold the per-actor lock. */
  async _loadLocked(actorId) {
    const db = await this._db(actorId);
    const map = this._keyMap(actorId);
    map.clear();
    const messages = [];
    let highest = 0n;
    for await (const [key, value] of db.iterator({ gte: KEY_PREFIX, lt: `${KEY_PREFIX}~` })) {
      const seqPart = String(key).slice(KEY_PREFIX.length).split('!')[0];
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

  async clear(actorId) {
    return this._withLock(actorId, async () => {
      const db = await this._db(actorId);
      const keys = [];
      for await (const [key] of db.iterator({ gte: KEY_PREFIX, lt: `${KEY_PREFIX}~` })) keys.push(key);
      if (keys.length > 0) await db.batch(keys.map((key) => ({ type: 'del', key })));
      this._keyMap(actorId).clear();
      this.seq.set(String(actorId), 0n);
    });
  }

  async pendingCount(actorId) {
    return this._withLock(actorId, async () => {
      const db = await this._db(actorId);
      let count = 0;
      for await (const [] of db.iterator({ gte: KEY_PREFIX, lt: `${KEY_PREFIX}~` })) count += 1;
      return count;
    });
  }

  /** LevelDB compacts itself; nothing to do, but keep the interface uniform. */
  async compact(actorId) {
    const db = await this._db(actorId);
    if (typeof db.compactRange === 'function') await db.compactRange(KEY_PREFIX, `${KEY_PREFIX}~`);
    return { before: null, after: null, records: await this.pendingCount(actorId) };
  }

  async stats() {
    return { backend: 'level', actors: this.dbs.size, bytes: null, root: this.root };
  }

  async close() {
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
