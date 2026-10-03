'use strict';

const { createStore, validateStoreConfig, pathForActor } = require('./stores');

/**
 * Persistence facade.
 *
 * The registry of unacknowledged messages is delegated to a pluggable backend
 * (see stores/): `file` (default, dependency-free, log + compaction), `memory`
 * (tests) or `level` (optional LevelDB binding).
 *
 * Contract used by actor-worker.js:
 *   append(actorId, msg)      queue a message durably, returns the stored record
 *   ack(actorId, msgId|ids)   mark as terminal (handled or dead-lettered)
 *   load(actorId)             replay everything that was never acknowledged
 *   pendingCount(actorId)     number of unacknowledged messages
 *   clear(actorId)            drop an actor's state
 */
class MessageStore {
  constructor(options = {}) {
    this.backend = options.backend && typeof options.backend.append === 'function'
      ? options.backend
      : createStore(options);
  }

  get backendName() {
    return this.backend.backendName || 'unknown';
  }

  append(actorId, msg) {
    return this.backend.append(actorId, msg);
  }

  ack(actorId, msgIds) {
    return this.backend.ack(actorId, msgIds);
  }

  load(actorId) {
    return this.backend.load(actorId);
  }

  clear(actorId) {
    return this.backend.clear(actorId);
  }

  pendingCount(actorId) {
    return this.backend.pendingCount(actorId);
  }

  compact(actorId) {
    return typeof this.backend.compact === 'function' ? this.backend.compact(actorId) : undefined;
  }

  stats() {
    return this.backend.stats();
  }

  close() {
    return typeof this.backend.close === 'function' ? this.backend.close() : undefined;
  }

  /**
   * Where an actor's data lives (used by tests and operators). This is a pure
   * path computation, so it works even when the backend kept no path yet.
   */
  pathFor(actorId) {
    if (typeof this.backend.pathFor === 'function') return this.backend.pathFor(actorId);
    return pathForActor(actorId);
  }
}

const store = new MessageStore();
module.exports = store;
module.exports.MessageStore = MessageStore;
module.exports.createStore = createStore;
module.exports.validateStoreConfig = validateStoreConfig;
