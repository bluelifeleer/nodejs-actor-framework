// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const crypto = require('crypto');

/**
 * In-memory backend: fast, dependency-free, and obviously non-durable.
 * Intended for tests and ephemeral workloads (e.g. ACTOR_STORE=memory).
 */
class MemoryStore {
  constructor() {
    /** @type {Map<string, Map<string, object>>} actorId -> msgId -> msg */
    this.data = new Map();
  }

  get backendName() {
    return 'memory';
  }

  _actor(actorId) {
    const key = String(actorId);
    if (!this.data.has(key)) this.data.set(key, new Map());
    return this.data.get(key);
  }

  async append(actorId, msg) {
    const record = msg && typeof msg === 'object' ? msg : { type: 'raw', value: msg };
    if (!record.__msgId) record.__msgId = crypto.randomUUID();
    this._actor(actorId).set(record.__msgId, record);
    return record;
  }

  async ack(actorId, msgIds) {
    const ids = Array.isArray(msgIds) ? msgIds : [msgIds];
    const actor = this._actor(actorId);
    let removed = 0;
    for (const id of ids) if (actor.delete(id)) removed += 1;
    return removed;
  }

  async load(actorId) {
    return [...this._actor(actorId).values()];
  }

  async clear(actorId) {
    this.data.set(String(actorId), new Map());
  }

  async pendingCount(actorId) {
    return this._actor(actorId).size;
  }

  async compact() {
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
