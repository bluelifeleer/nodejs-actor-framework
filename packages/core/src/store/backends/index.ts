'use strict';

const path = require('path');
const config = require('../../config.ts');
const { FileStore } = require('./file-store.ts');
const { MemoryStore } = require('./memory-store.ts');
const { LevelStore, isAvailable: levelAvailable } = require('./level-store.ts');
const { fileName } = require('./naming.ts');

const BACKENDS = ['file', 'memory', 'level'];

/**
 * Build the configured persistence backend.
 *
 *   ACTOR_STORE=file    default: dependency-free append-only log + compaction
 *   ACTOR_STORE=memory  tests / ephemeral
 *   ACTOR_STORE=level   optional classic-level binding (per-actor database)
 */
function createStore(options = {}) {
  const storeConfig = options.store || config.store;
  const backend = String(options.backend || storeConfig.backend || 'file').toLowerCase();

  switch (backend) {
    case 'memory':
      return new MemoryStore(options);
    case 'level':
      return new LevelStore({
        root: options.levelPath || storeConfig.levelPath || path.join(config.dataDir, 'level'),
      });
    case 'file':
      return new FileStore({
        baseDir: options.baseDir || path.join(config.dataDir, 'msg_store'),
        compactionThresholdBytes: options.compactionThresholdBytes || storeConfig.compactionThresholdBytes,
        maxFileBytes: options.maxFileBytes || storeConfig.maxFileBytes,
      });
    default:
      throw new Error(`unknown store backend "${backend}" (expected one of: ${BACKENDS.join(', ')})`);
  }
}

/** Validate the configuration without opening anything. */
function validateStoreConfig(storeConfig = config.store) {
  const backend = String(storeConfig.backend || 'file').toLowerCase();
  if (!BACKENDS.includes(backend)) {
    return { ok: false, reason: `unknown store backend "${backend}" (expected: ${BACKENDS.join(', ')})` };
  }
  if (backend === 'level') {
    const availability = levelAvailable();
    if (!availability.available) return { ok: false, reason: availability.reason };
  }
  return { ok: true, backend };
}

function pathForActor(actorId, storeConfig = config.store) {
  const backend = String(storeConfig.backend || 'file').toLowerCase();
  if (backend === 'level') {
    return path.join(storeConfig.levelPath || path.join(config.dataDir, 'level'), fileName(actorId, ''));
  }
  return path.join(config.dataDir, 'msg_store', fileName(actorId));
}

module.exports = {
  createStore,
  validateStoreConfig,
  pathForActor,
  BACKENDS,
  FileStore,
  MemoryStore,
  LevelStore,
};
