// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const { createStore, validateStoreConfig, pathForActor } = require('./backends/index.ts');

/**
 * Persistence facade.
 *
 * The registry of unacknowledged messages is delegated to a pluggable backend
 * (see stores/): `file` (default, dependency-free, log + compaction), `memory`
 * (tests) or `level` (optional LevelDB binding).
 *
 * Contract used by the framework:
 *   append(actorId, msg)      queue a message durably, returns the stored record
 *   ack(actorId, msgId|ids)   mark as terminal (handled or dead-lettered)
 *   load(actorId)             replay everything that was never acknowledged
 *   pendingCount(actorId)     number of unacknowledged messages
 *   clear(actorId)            drop an actor's state
 */
/** 存储后端契约：任何满足它的对象都能当 backend 注入（内存/文件/level）。 */
interface StoreBackend {
  readonly backendName?: string;
  append(actorId: string, msg: unknown): Promise<unknown>;
  ack(actorId: string, msgIds: string | string[]): Promise<unknown>;
  load(actorId: string): Promise<unknown[]>;
  clear(actorId: string): Promise<unknown>;
  pendingCount(actorId: string): Promise<number>;
  compact?(actorId?: string): Promise<unknown>;
  /** 可选：后端能说出某 actor 的数据落在哪（文件后端有，内存后端没有）。 */
  pathFor?(actorId: string, config?: unknown): string;
  stats(): Promise<unknown>;
  close?(): Promise<void>;
}

interface MessageStoreOptions {
  backend?: StoreBackend;
  [key: string]: unknown;
}

class MessageStore {
  readonly backend: StoreBackend;

  constructor(options: MessageStoreOptions = {}) {
    this.backend = options.backend !== undefined && typeof options.backend.append === 'function'
      ? options.backend
      : (createStore(options as never) as StoreBackend);
  }

  get backendName(): string {
    return this.backend.backendName ?? 'unknown';
  }

  append(actorId: string, msg: unknown): Promise<unknown> {
    return this.backend.append(actorId, msg);
  }

  ack(actorId: string, msgIds: string | string[]): Promise<unknown> {
    return this.backend.ack(actorId, msgIds);
  }

  load(actorId: string): Promise<unknown[]> {
    return this.backend.load(actorId);
  }

  clear(actorId: string): Promise<unknown> {
    return this.backend.clear(actorId);
  }

  pendingCount(actorId: string): Promise<number> {
    return this.backend.pendingCount(actorId);
  }

  compact(actorId?: string): Promise<unknown> | undefined {
    return typeof this.backend.compact === 'function' ? this.backend.compact(actorId) : undefined;
  }

  stats(): Promise<unknown> {
    return this.backend.stats();
  }

  close(): Promise<void> | undefined {
    return typeof this.backend.close === 'function' ? this.backend.close() : undefined;
  }

  /**
   * Where an actor's data lives (used by tests and operators). This is a pure
   * path computation, so it works even when the backend kept no path yet.
   */
  pathFor(actorId: string): string {
    if (typeof this.backend.pathFor === 'function') return this.backend.pathFor(actorId);
    return pathForActor(actorId);
  }
}

const store = new MessageStore();
module.exports = store;
module.exports.MessageStore = MessageStore;
module.exports.createStore = createStore;
module.exports.validateStoreConfig = validateStoreConfig;
