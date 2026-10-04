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

class FileStore {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(config.dataDir, 'msg_store');
    this.compactionThresholdBytes = options.compactionThresholdBytes
      || config.store.compactionThresholdBytes;
    this.maxFileBytes = options.maxFileBytes || config.store.maxFileBytes;
    fs.mkdirSync(this.baseDir, { recursive: true });
    /** Actor id -> on-disk file index, so tooling can enumerate actors. */
    this.manifest = options.manifest || new Manifest(this.baseDir);
    /**
     * @type {Map<string, {records: Map<string, {msg: object, bytes: number}>,
     *                     liveBytes: number, fileBytes: number, loaded: boolean}>}
     */
    this.index = new Map();
    /** @type {Map<string, Promise<any>>} per-actor write serialisation */
    this.chain = new Map();
  }

  get backendName() {
    return 'file';
  }

  pathFor(actorId) {
    return path.join(this.baseDir, fileName(actorId));
  }

  _state(actorId) {
    const key = String(actorId);
    let state = this.index.get(key);
    if (!state) {
      state = { records: new Map(), liveBytes: 0, fileBytes: 0, loaded: false };
      this.index.set(key, state);
    }
    return state;
  }

  _withLock(actorId, fn) {
    const key = String(actorId);
    const prev = this.chain.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.chain.set(key, next.catch(() => {}));
    return next;
  }

  _frame(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const head = Buffer.allocUnsafe(HEADER_BYTES);
    head.writeUInt32BE(body.length, 0);
    head.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([head, body]);
  }

  /** Queue a message durably. Assigns a `__msgId` when missing. */
  async append(actorId, msg) {
    const record = msg && typeof msg === 'object' ? msg : { type: 'raw', value: msg };
    if (!record.__msgId) record.__msgId = crypto.randomUUID();
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      if (!state.loaded) await this._loadInto(actorId, state);

      const frame = this._frame({ t: 'm', id: record.__msgId, msg: record });
      await fsp.appendFile(this.pathFor(actorId), frame);
      await this.manifest.record(actorId, fileName(actorId));

      const previous = state.records.get(record.__msgId);
      if (previous) state.liveBytes -= previous.bytes;
      state.records.set(record.__msgId, { msg: record, bytes: frame.length });
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
  async ack(actorId, msgIds) {
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
        state.liveBytes -= entry.bytes;
        state.records.delete(id);
      }

      await this._maybeCompact(actorId, state);
      return present.length;
    });
  }

  async _maybeCompact(actorId, state) {
    const dead = state.fileBytes - state.liveBytes;
    const threshold = Math.max(this.compactionThresholdBytes, state.liveBytes);
    if (dead < threshold) return;
    await this._compactLocked(actorId, state);
  }

  /** Rewrite the log with only live messages (caller must hold the lock). */
  async _compactLocked(actorId, state) {
    const before = state.fileBytes;
    const target = this.pathFor(actorId);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const parts = [];
    for (const { msg } of state.records.values()) parts.push(this._frame({ t: 'm', id: msg.__msgId, msg }));
    await fsp.writeFile(tmp, Buffer.concat(parts));
    await fsp.rename(tmp, target);
    state.liveBytes = parts.reduce((sum, b) => sum + b.length, 0);
    state.fileBytes = state.liveBytes;
    return { before, after: state.fileBytes, records: state.records.size };
  }

  /** Public compaction entry point (takes the lock itself). */
  async compact(actorId) {
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      if (!state.loaded) await this._loadInto(actorId, state);
      return this._compactLocked(actorId, state);
    });
  }

  /** Replay the log into the in-memory index. Caller must hold the lock. */
  async _loadInto(actorId, state) {
    await this._migrateLegacy(actorId);
    let buf;
    try {
      buf = await fsp.readFile(this.pathFor(actorId));
    } catch (err) {
      if (err.code === 'ENOENT') {
        state.records = new Map();
        state.liveBytes = 0;
        state.fileBytes = 0;
        state.loaded = true;
        return state;
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
    this.skippedRecords = (this.skippedRecords || 0) + skipped;
    return state;
  }

  /** Read durable messages in enqueue order, skipping corrupt records. */
  async load(actorId) {
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      await this._loadInto(actorId, state);
      return [...state.records.values()].map((entry) => entry.msg);
    });
  }

  async clear(actorId) {
    return this._withLock(actorId, async () => {
      const state = this._state(actorId);
      state.records = new Map();
      state.liveBytes = 0;
      state.fileBytes = 0;
      state.loaded = true;
      await fsp.writeFile(this.pathFor(actorId), '');
    });
  }

  async pendingCount(actorId) {
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
  async _migrateLegacy(actorId) {
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
    this.migrated = (this.migrated || 0) + 1;
    return true;
  }

  /** Actor ids this store knows about (from the manifest). */
  async listActors() {
    return this.manifest.list();
  }

  async stats() {
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

  async close() {
    /* writes are not streamed, so there is nothing to flush */
  }
}

module.exports = FileStore;
module.exports.FileStore = FileStore;
module.exports.HEADER_BYTES = HEADER_BYTES;
