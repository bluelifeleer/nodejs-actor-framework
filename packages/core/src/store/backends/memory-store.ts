// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const crypto = require('crypto');

/**
 * In-memory backend: fast, dependency-free, and obviously non-durable.
 * Intended for tests and ephemeral workloads (e.g. ACTOR_STORE=memory).
 */
/** 存储的记录：至少带一个内部消息 id（用于 ack）。 */
interface StoredRecord {
  __msgId?: string;
  [key: string]: unknown;
}

class MemoryStore {
  /** actorId -> msgId -> 记录。 */
  readonly data: Map<string, Map<string, StoredRecord>>;

  constructor() {
    this.data = new Map();
  }

  get backendName(): string {
    return 'memory';
  }

  _actor(actorId: string): Map<string, StoredRecord> {
    const key = String(actorId);
    let actor = this.data.get(key);
    if (actor === undefined) {
      actor = new Map<string, StoredRecord>();
      this.data.set(key, actor);
    }
    return actor;
  }

  async append(actorId: string, msg: unknown): Promise<StoredRecord> {
    const record: StoredRecord = msg !== null && typeof msg === 'object' ? (msg as StoredRecord) : { type: 'raw', value: msg };
    const msgId = record.__msgId ?? crypto.randomUUID();
    record.__msgId = msgId;
    this._actor(actorId).set(msgId, record);
    return record;
  }

  async ack(actorId: string, msgIds: string | string[]): Promise<number> {
    const ids = Array.isArray(msgIds) ? msgIds : [msgIds];
    const actor = this._actor(actorId);
    let removed = 0;
    for (const id of ids) if (actor.delete(id)) removed += 1;
    return removed;
  }

  async load(actorId: string): Promise<StoredRecord[]> {
    return [...this._actor(actorId).values()];
  }

  async clear(actorId: string): Promise<void> {
    this.data.set(String(actorId), new Map<string, StoredRecord>());
  }

  async pendingCount(actorId: string): Promise<number> {
    return this._actor(actorId).size;
  }

  async compact(): Promise<{ before: number; after: number; records: number }> {
    return { before: 0, after: 0, records: 0 };
  }

  async stats() {
    let keys = 0;
    for (const actor of this.data.values()) keys += actor.size;
    return { backend: 'memory', actors: this.data.size, bytes: null, keys };
  }

  async close() {
    this.data.clear();
  }
}

module.exports = MemoryStore;
module.exports.MemoryStore = MemoryStore;
