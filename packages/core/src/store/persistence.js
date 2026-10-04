'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fileName } = require('./backends/naming');
const { PersistenceError } = require('../actor/errors');

/**
 * Persistence adapters for actor state and events.
 *
 * The framework treats "durable mailbox" (message replay) as a separate,
 * opt-in strategy that reuses the message store; snapshots and events live
 * here because they are actor-native (recover *state*, not messages).
 */

/** Interface documentation; both adapters below implement it. */
class PersistenceAdapter {
  /* eslint-disable no-unused-vars */
  async loadSnapshot(id) {
    return undefined;
  }

  async saveSnapshot(id, state) {}

  async deleteSnapshot(id) {}

  async appendEvent(id, event) {}

  async loadEvents(id) {
    return [];
  }

  async deleteEvents(id) {}
  /* eslint-enable no-unused-vars */
}

class MemoryPersistence extends PersistenceAdapter {
  constructor() {
    super();
    this.snapshots = new Map();
    this.events = new Map();
  }

  async loadSnapshot(id) {
    return this.snapshots.get(String(id));
  }

  async saveSnapshot(id, state) {
    this.snapshots.set(String(id), state);
  }

  async deleteSnapshot(id) {
    return this.snapshots.delete(String(id));
  }

  async appendEvent(id, event) {
    const key = String(id);
    if (!this.events.has(key)) this.events.set(key, []);
    this.events.get(key).push(event);
  }

  async loadEvents(id) {
    return [...(this.events.get(String(id)) || [])];
  }

  async deleteEvents(id) {
    return this.events.delete(String(id));
  }
}

/**
 * File-backed adapter.
 *
 *   <baseDir>/snapshots/<actor>.json   atomic tmp+rename
 *   <baseDir>/events/<actor>.jsonl     append-only, torn tail tolerated
 */
class FilePersistence extends PersistenceAdapter {
  constructor(options = {}) {
    super();
    this.baseDir = options.baseDir || path.join(process.cwd(), '.actors');
    this.snapshotDir = path.join(this.baseDir, 'snapshots');
    this.eventDir = path.join(this.baseDir, 'events');
    this.deferDirs = options.deferDirs !== false; // do not touch the fs until first use
    if (!this.deferDirs) this._ensureDirs();
  }

  _ensureDirs() {
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    fs.mkdirSync(this.eventDir, { recursive: true });
  }

  _snapshotPath(id) {
    return path.join(this.snapshotDir, fileName(String(id), '.json'));
  }

  _eventPath(id) {
    return path.join(this.eventDir, fileName(String(id), '.jsonl'));
  }

  async loadSnapshot(id) {
    try {
      const raw = await fsp.readFile(this._snapshotPath(id), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      if (err instanceof SyntaxError) {
        throw new PersistenceError(`snapshot for ${id} is corrupt: ${err.message}`, { actorId: String(id) });
      }
      throw new PersistenceError(`cannot read snapshot for ${id}: ${err.message}`, { actorId: String(id) });
    }
  }

  async saveSnapshot(id, state) {
    const target = this._snapshotPath(id);
    try {
      this._ensureDirs();
      const tmp = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(state)}\n`);
      await fsp.rename(tmp, target);
    } catch (err) {
      throw new PersistenceError(`cannot save snapshot for ${id}: ${err.message}`, { actorId: String(id) });
    }
  }

  async deleteSnapshot(id) {
    try {
      await fsp.unlink(this._snapshotPath(id));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw new PersistenceError(`cannot delete snapshot for ${id}: ${err.message}`);
    }
  }

  async appendEvent(id, event) {
    try {
      this._ensureDirs();
      await fsp.appendFile(this._eventPath(id), `${JSON.stringify(event)}\n`);
    } catch (err) {
      throw new PersistenceError(`cannot append event for ${id}: ${err.message}`, { actorId: String(id) });
    }
  }

  async loadEvents(id) {
    let raw;
    try {
      raw = await fsp.readFile(this._eventPath(id), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new PersistenceError(`cannot read events for ${id}: ${err.message}`);
    }
    const events = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        break; // torn tail from a crash: stop at the first unreadable line
      }
    }
    return events;
  }

  async deleteEvents(id) {
    try {
      await fsp.unlink(this._eventPath(id));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw new PersistenceError(`cannot delete events for ${id}: ${err.message}`);
    }
  }

  async stats() {
    const count = async (dir) => {
      try {
        return (await fsp.readdir(dir)).length;
      } catch {
        return 0;
      }
    };
    return {
      backend: 'file',
      baseDir: this.baseDir,
      snapshots: await count(this.snapshotDir),
      eventLogs: await count(this.eventDir),
    };
  }
}

/**
 * Resolve a persistence strategy.
 * @param {string|object|undefined} spec 'none' | 'snapshot' | 'events' | 'mailbox' | {mode, store, ...}
 */
function resolvePersistence(spec, fallbackStore) {
  const normalized = typeof spec === 'string' ? { mode: spec } : { ...(spec || {}) };
  const mode = normalized.mode || 'none';
  if (!['none', 'snapshot', 'events', 'mailbox'].includes(mode)) {
    throw new PersistenceError(`unknown persistence mode "${mode}" (expected none|snapshot|events|mailbox)`);
  }
  return {
    mode,
    store: normalized.store || fallbackStore || null,
    onStop: normalized.onStop !== false,
    mailboxStore: normalized.mailboxStore || null,
  };
}

module.exports = {
  PersistenceAdapter,
  MemoryPersistence,
  FilePersistence,
  resolvePersistence,
};
