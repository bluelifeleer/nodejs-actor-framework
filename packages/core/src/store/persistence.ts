// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fileName } = require('./backends/naming.ts');
const { PersistenceError, PersistenceConflictError } = require('../actor/errors.ts');

/**
 * Persistence adapters for actor state and events.
 *
 * The framework treats "durable mailbox" (message replay) as a separate,
 * opt-in strategy that reuses the message store; snapshots and events live
 * here because they are actor-native (recover *state*, not messages).
 */

/**
 * What a backend can actually guarantee. Adapters override `capabilities()`.
 *
 * `conditionalAppend`:
 *   - `'atomic'`      —— 检查与写入对其他进程/连接也是原子的（SQL、etcd 这类）；
 *   - `'in-process'`  —— 只保证本进程内（file / memory 后端：**不**保证跨进程）；
 *   - `false`         —— 不支持（默认；自定义适配器不实现就没有）。
 *
 * 之所以要把它查得出来：没有这个信息时，"以为有乐观并发保护、其实没有"是最危险的状态
 * （见 docs/design/m3-data-evolution.md §6.4）。
 */
const DEFAULT_CAPABILITIES = Object.freeze({ conditionalAppend: false, batchAppend: false });

/** Interface documentation; both adapters below implement it. */
class PersistenceAdapter {
  /* eslint-disable no-unused-vars */
  capabilities() {
    return DEFAULT_CAPABILITIES;
  }

  async loadSnapshot(id) {
    return undefined;
  }

  async saveSnapshot(id, state) {}

  async deleteSnapshot(id) {}

  /**
   * Append one event.
   *
   * `options.expectedVersion`（可选）是**日志的当前版本 = 已写入的记录条数**。
   * 给了它就必须条件写：版本对不上时抛 `PersistenceConflictError` 且**不写入**。
   * 用"条数"而不是"事件里的 seq"，是为了让后端保持格式无关（它们不认识信封）；
   * 而数据层的 `readLog` 已经保证 seq 连续，所以条数就是最后一条事件的 seq。
   */
  async appendEvent(id, event, options = {}) {
    void options;
  }

  /**
   * 一次写入多条事件（一条命令产出多个事件时用）。
   *
   * 基类的默认实现**只是逐个 appendEvent**——版本检查因此只覆盖第一条，谈不上原子。
   * 想要"整批要么都在、要么都不在"，适配器要实现它并把 `capabilities().batchAppend` 报上来；
   * 内核只在能力非 false 时才走批量路径（否则退回逐条并记一条日志）。
   */
  async appendEvents(id, events, options = {}) {
    const written = [];
    for (const event of events) {
      await this.appendEvent(id, event, written.length === 0 ? options : {});
      written.push(event);
    }
    return written.length;
  }

  async loadEvents(id) {
    return [];
  }

  async deleteEvents(id) {}
  /* eslint-enable no-unused-vars */
}

/** 条件写失败的统一错误信息（后端各自抛出，字段一致）。 */
function appendConflict(id, expectedVersion, actualVersion) {
  return new PersistenceConflictError(
    `"${String(id)}" 的条件写入失败：期望日志版本 ${expectedVersion}，实际 ${actualVersion}` +
      '（另一个实例/节点已经写过这个聚合了？先重新加载再重试）',
    { actorId: String(id), expectedVersion, actualVersion },
  );
}

/** 校验 `options.expectedVersion`（防止把 undefined/NaN 当成"期望 0"）。 */
function readExpectedVersion(options) {
  const expected = options ? options.expectedVersion : undefined;
  if (expected === undefined) return null;
  if (!Number.isInteger(expected) || expected < 0) {
    throw new PersistenceError(`expectedVersion 必须是 >= 0 的整数（当前 ${String(expected)}）`);
  }
  return expected;
}

class MemoryPersistence extends PersistenceAdapter {
  constructor() {
    super();
    this.snapshots = new Map();
    this.events = new Map();
  }

  /** 进程内的日志就是全部真相，所以条件写与批量写都是原子的（本来也没有别的进程）。 */
  capabilities() {
    return { conditionalAppend: 'in-process', batchAppend: 'in-process' };
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

  async appendEvent(id, event, options = {}) {
    const key = String(id);
    const expected = readExpectedVersion(options);
    if (!this.events.has(key)) this.events.set(key, []);
    const log = this.events.get(key);
    if (expected !== null && log.length !== expected) throw appendConflict(key, expected, log.length);
    log.push(event);
  }

  async appendEvents(id, events, options = {}) {
    const key = String(id);
    const expected = readExpectedVersion(options);
    if (!this.events.has(key)) this.events.set(key, []);
    const log = this.events.get(key);
    if (expected !== null && log.length !== expected) throw appendConflict(key, expected, log.length);
    log.push(...events); // 检查通过之后一次性推入：不会被看到"写了一半"
    return events.length;
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
    /**
     * 每路径"已写入的记录条数"的**进程内**缓存：条件写要用它。
     * 文件后端没有跨进程原子性，所以能力如实报 `'in-process'`；
     * 两个进程同时写同一路径时，谁都不会看到对方——这正是要暴露能力而不是假装有保护的原因。
     */
    this._counts = new Map();
    if (!this.deferDirs) this._ensureDirs();
  }

  capabilities() {
    // 批量写：版本检查之后**一次** appendFile ⇒ 对检查而言是原子的；
    // 但文件没有事务，崩溃仍可能只落下一部分（读取端的撕裂尾巴规则会把不完整的行截断，
    // 于是最坏情况是"看到批次的前缀"——真要严格原子请用支持事务的后端）
    return { conditionalAppend: 'in-process', batchAppend: 'in-process' };
  }

  _ensureDirs() {
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    fs.mkdirSync(this.eventDir, { recursive: true });
  }

  /** 解析 jsonl：遇到第一条读不通的行就停（崩溃留下的撕裂尾巴，与 loadEvents 同规则）。 */
  _parseLog(raw) {
    const records = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        break;
      }
    }
    return records;
  }

  async _logSize(key) {
    try {
      return (await fsp.stat(this._eventPath(key))).size;
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw new PersistenceError(`cannot stat events for ${key}: ${err.message}`);
    }
  }

  /**
   * 日志当前版本 = 已写入的记录条数（缓存形如 `{size, count}`）。
   *
   * 为什么要看 size：同一进程里可能有**两个指向同一目录的实例**（两个 system / 两个节点共用存储），
   * 各自的缓存会互相过期。用文件大小判断"有没有别人追加过"，只解析**新增的那一段字节**，
   * 既不重复解析整段日志，也不会被本地缓存骗过。
   * 跨进程仍然不保证（见 `capabilities()`）；要真正的原子条件写，请换支持 CAS 的后端。
   */
  async _countFor(key) {
    const size = await this._logSize(key);
    const cached = this._counts.get(key);
    if (cached && cached.size === size) return cached;
    if (cached && size > cached.size) {
      const handle = await fsp.open(this._eventPath(key), 'r');
      try {
        const length = size - cached.size;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, cached.size);
        const added = this._parseLog(buffer.toString('utf8')).length;
        const entry = { size, count: cached.count + added };
        this._counts.set(key, entry);
        return entry;
      } finally {
        await handle.close();
      }
    }
    // 冷缓存，或文件被截断过：整段重读一次
    let count = 0;
    try {
      count = this._parseLog(await fsp.readFile(this._eventPath(key), 'utf8')).length;
    } catch (err) {
      if (err.code !== 'ENOENT') throw new PersistenceError(`cannot count events for ${key}: ${err.message}`);
    }
    const entry = { size, count };
    this._counts.set(key, entry);
    return entry;
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

  async appendEvent(id, event, options = {}) {
    const key = String(id);
    const expected = readExpectedVersion(options);
    const { count: actual, size } = await this._countFor(key);
    if (expected !== null && actual !== expected) throw appendConflict(key, expected, actual);
    const line = `${JSON.stringify(event)}\n`;
    try {
      this._ensureDirs();
      await fsp.appendFile(this._eventPath(key), line);
      this._counts.set(key, { size: size + Buffer.byteLength(line), count: actual + 1 });
    } catch (err) {
      throw new PersistenceError(`cannot append event for ${key}: ${err.message}`, { actorId: key });
    }
  }

  async appendEvents(id, events, options = {}) {
    const key = String(id);
    const expected = readExpectedVersion(options);
    const { count: actual, size } = await this._countFor(key);
    if (expected !== null && actual !== expected) throw appendConflict(key, expected, actual);
    const lines = events.map((event) => `${JSON.stringify(event)}\n`).join('');
    try {
      this._ensureDirs();
      await fsp.appendFile(this._eventPath(key), lines); // 一次写完整批
      this._counts.set(key, { size: size + Buffer.byteLength(lines), count: actual + events.length });
      return events.length;
    } catch (err) {
      throw new PersistenceError(`cannot append events for ${key}: ${err.message}`, { actorId: key });
    }
  }

  async loadEvents(id) {
    const key = String(id);
    let raw;
    try {
      raw = await fsp.readFile(this._eventPath(key), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._counts.set(key, { size: 0, count: 0 }); // 明确知道是空的（spawn 时就会走到这里，正好喂上缓存）
        return [];
      }
      throw new PersistenceError(`cannot read events for ${key}: ${err.message}`);
    }
    const events = this._parseLog(raw);
    this._counts.set(key, { size: Buffer.byteLength(raw), count: events.length });
    return events;
  }

  async deleteEvents(id) {
    this._counts.delete(String(id));
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
    /**
     * `events` 模式下的**快照缓存**：`{ every }`，`every > 0` 表示每写 N 条事件自动存一次
     * （`0` = 只手动 `ctx.saveSnapshot()`）。`null` = 没启用（保持"纯重放"）。
     *
     * 语义（doc 04 §4.2 / docs/design/m3-data-evolution.md §6.2）：**快照是缓存，日志是真相**。
     * 快照里带"已经应用到第几条事件"，恢复时只重放增量；快照不可用时丢弃并全量重放。
     */
    snapshot: resolveEventsSnapshot(mode, normalized.snapshot),
    /** Structure-evolution hooks (see resolveEvolution); null = raw bytes in, raw bytes out. */
    evolution: resolveEvolution(normalized.evolution),
  };
}

/** 只有 `events` 模式才有"快照缓存"这回事；其它模式传了就明确报错（不静默忽略）。 */
function resolveEventsSnapshot(mode, snapshot) {
  if (snapshot === undefined || snapshot === null || snapshot === false) return null;
  if (mode !== 'events') {
    throw new PersistenceError(`persistence.snapshot.every 只在 mode: 'events' 下有意义（当前 mode: '${mode}'）`);
  }
  if (snapshot === true) return { every: 0 };
  const every = snapshot.every === undefined ? 0 : snapshot.every;
  if (!Number.isInteger(every) || every < 0) {
    throw new PersistenceError(`persistence.snapshot.every 必须是 >= 0 的整数（当前 ${String(every)}）`);
  }
  return { every };
}

/**
 * The kernel stays **format-agnostic**: it never parses an event envelope or a
 * snapshot header. It only calls these three optional hooks, so a data layer
 * can own the on-disk format without the kernel importing it.
 *
 *   upcast(raw)          events 模式：每条事件在 applyEvent 之前调用
 *   readLog(raws)        events 模式：**整段日志一起读**（升级 + 序号连续性检查）；重放优先用它，
 *                        因为"序号是否连续"只有看得到整段日志才能判断
 *   decodeSnapshot(raw)  snapshot 模式：读取快照时调用（版本校验/迁移在这里；抛错 = 拒绝启动）
 *   encodeSnapshot(state) snapshot 模式：写入快照时调用
 *
 * All of them must be **synchronous pure functions**; a Promise would be applied /
 * stored as an opaque object, which is a silent data corruption, so it is
 * rejected loudly instead.
 */
function resolveEvolution(evolution) {
  if (evolution === undefined || evolution === null) return null;
  if (typeof evolution !== 'object') {
    throw new PersistenceError('persistence.evolution must be an object with optional upcast/readLog/decodeSnapshot/encodeSnapshot');
  }
  const resolved = {};
  for (const key of ['upcast', 'readLog', 'decodeSnapshot', 'encodeSnapshot']) {
    const hook = evolution[key];
    if (hook === undefined) continue;
    if (typeof hook !== 'function') {
      throw new PersistenceError(`persistence.evolution.${key} must be a function`);
    }
    resolved[key] = hook;
  }
  return Object.keys(resolved).length > 0 ? resolved : null;
}

/**
 * Call an evolution hook, rejecting an async result (see resolveEvolution).
 *
 * Signature is `(hook, label, ...args)` on purpose: `(hook, value, label)` reads
 * naturally but invites passing an argument *array* as the value — which silently
 * calls the hook with one array instead of two arguments.
 */
function callEvolution(hook, label, ...args) {
  const result = hook(...args);
  if (result && typeof result.then === 'function') {
    throw new PersistenceError(`persistence.evolution.${label} must be synchronous (returned a Promise)`);
  }
  return result;
}

module.exports = {
  PersistenceAdapter,
  MemoryPersistence,
  FilePersistence,
  resolvePersistence,
  resolveEvolution,
  callEvolution,
};
