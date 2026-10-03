'use strict';

/**
 * Service registry: maps actorId -> metadata.
 *
 * Local actors get { nodeId, type:'actor' }. Remote actors discovered through
 * gossip get { nodeId, type:'remote', host, gatewayPort, lastSeen } so that
 * ActorManager.send() can dispatch over the TCP gateway.
 *
 * `pruneStale` removes remote entries whose owning node stopped gossiping, so
 * a dead node's actors do not linger forever.
 */
class Registry {
  constructor() {
    /** @type {Map<string, object>} */
    this.map = new Map();
  }

  set(id, meta) {
    if (id === undefined || id === null || id === '') return false;
    this.map.set(String(id), { ...meta, updatedAt: Date.now() });
    return true;
  }

  register(id, meta) {
    return this.set(id, meta);
  }

  get(id) {
    return this.map.get(String(id));
  }

  find(id) {
    return this.get(id);
  }

  has(id) {
    return this.map.has(String(id));
  }

  del(id) {
    return this.map.delete(String(id));
  }

  unregister(id) {
    return this.del(id);
  }

  keys() {
    return [...this.map.keys()];
  }

  get size() {
    return this.map.size;
  }

  getAll() {
    return Object.fromEntries(this.map);
  }

  listAll() {
    return Object.entries(this.getAll()).map(([id, meta]) => ({ id, ...meta }));
  }

  /** Refresh lastSeen for entries belonging to a node that just gossiped. */
  touchNode(nodeId, now = Date.now()) {
    for (const meta of this.map.values()) {
      if (meta.nodeId === nodeId) meta.lastSeen = now;
    }
  }

  /**
   * Drop remote actors whose node has not been heard from within timeoutMs.
   * Local entries are never pruned.
   */
  pruneStale(timeoutMs, now = Date.now()) {
    const removed = [];
    for (const [id, meta] of this.map) {
      if (meta.type !== 'remote') continue;
      const seen = meta.lastSeen ?? meta.updatedAt ?? 0;
      if (now - seen > timeoutMs) {
        this.map.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  clear() {
    this.map.clear();
  }
}

const registry = new Registry();
module.exports = registry;
module.exports.Registry = Registry;
