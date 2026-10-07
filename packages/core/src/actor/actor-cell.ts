// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const Mailbox = require('./mailbox.ts');
const TokenBucket = require('./token-bucket.ts');
const ChildSupervisor = require('./guardian.ts');
const ActorContext = require('./actor-context.ts');
const { ActorRef } = require('./actor-ref.ts');
const { defineActor } = require('./actor.ts');
const { resolvePersistence, callEvolution } = require('../store/persistence.ts');

/** `events` 模式快照的外层包装：只有内核关心"恢复到第几条"，用户状态原样放在 `snapshot` 里。 */
function wrapEventsSnapshot(atSeq: number, snapshot: unknown): { __snapshotAtSeq: number; snapshot: unknown } {
  return { __snapshotAtSeq: atSeq, snapshot };
}

/** 解包 `events` 模式的快照；不是这个形状就返回 null（调用方按"没有快照"处理）。 */
function unwrapEventsSnapshot(raw: unknown): { atSeq: number; snapshot: unknown } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as { __snapshotAtSeq?: unknown; snapshot?: unknown };
  const atSeq = candidate.__snapshotAtSeq;
  if (!Number.isInteger(atSeq) || (atSeq as number) < 0 || !('snapshot' in candidate)) return null;
  return { atSeq: atSeq as number, snapshot: candidate.snapshot };
}
const { AskTimeoutError, MailboxFullError, ActorStoppedError, EscalationError, DefinitionError, PersistenceError } = require('./errors.ts');

/** 消息类型（`msg.type`）；非对象或没写 type 就是 'unknown'（span 名与属性都用它）。 */
function messageTypeOf(payload: unknown): string {
  if (payload !== null && typeof payload === 'object' && typeof (payload as { type?: unknown }).type === 'string') {
    return (payload as { type: string }).type;
  }
  return 'unknown';
}
const RestartStrategy = require('./restart-strategy.ts');

/**
 * 等待：**走系统的可注入时钟**（`system.clock`）。
 *
 * 为什么不能直接用全局 `setTimeout`：注入了虚拟时钟之后，"等 100ms"必须能被 `clock.advance(100)`
 * 推进；继续用真实定时器会让测试要么真的等、要么永远等不到（两者都不可接受）。
 */
const sleep = (clock: { setTimeout(cb: () => void, ms: number): unknown }, ms: number): Promise<void> =>
  new Promise((resolve) => {
    clock.setTimeout(resolve, Math.max(0, ms));
  });

/**
 * One actor instance plus its runtime.
 *
 * Guarantees:
 *  - one message is processed at a time, so actor state needs no locking;
 *  - the mailbox is bounded (backpressure policy is configurable);
 *  - a failure either crashes the actor (default, OTP style) or is retried
 *    inside the actor (opt-in durable mailbox) — never silently swallowed;
 *  - an actor that is stopped, or dies while a message is queued, always
 *    settles every pending `ask` instead of leaving it hanging.
 */
/** Actor 的运行期计数器（指标与诊断读它）。 */
interface ActorCounters {
  received: number;
  handled: number;
  failed: number;
  retries: number;
  deadLettered: number;
  crashed: number;
  restarted: number;
  recovered: number;
  throttled: number;
  batches: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  [field: string]: number;
}

/** 信箱信封（mailbox.ts 的 MailboxEnvelope 结构）。 */
interface CellEnvelope {
  payload?: unknown;
  /** 持久化邮箱里的消息 id（durable ack 用）。 */
  __msgId?: string | undefined;
  reply?: { resolve(value: unknown): void; reject(err: Error): void } | null;
  sender?: { path?: string } | null;
  retryCount?: number;
  ts?: number;
  trace?: unknown;
  priority?: number;
  system?: boolean;
  onDropped?: () => void;
  [key: string]: unknown;
}

/** cell 依赖的 system 视图（只列 cell 用到的成员）。 */
interface CellSystem {
  readonly name: string;
  readonly actorDefaults: {
    mailbox: { maxSize: number; overflow: string };
    supervision: { strategy: string; maxRestarts: number; withinSeconds: number };
    [key: string]: unknown;
  };
  readonly persistenceStore: unknown;
  readonly mailboxStore: unknown;
  readonly rateLimitPolicy: { capacity: number; rate: number } | null;
  readonly clock: { now(): number; setTimeout(cb: () => void, ms: number, options?: { unref?: boolean }): { id: number }; clearTimeout(h: { id: number } | null): void };
  readonly scheduler: { schedule(cell: unknown): void };
  readonly shutdownTimeoutMs: number;
  readonly cells: Map<string, unknown>;
  readonly ownership?: unknown;
  spanSink?: { onSpan(span: unknown): void } | null;
  tracer?: { buildContext(parent: unknown): unknown; child(parent: unknown): unknown } | null;
  _startSpan?(input: { name: string; trace?: unknown; attributes?: Record<string, string | number | boolean> }): Record<string, unknown> | null;
  _endSpan?(span: Record<string, unknown> | null, outcome: Record<string, unknown>): void;
  _log(event: string, meta?: Record<string, unknown>): void;
  _deadLetter(cell: unknown, envelope: unknown, err: unknown): void;
  _onMailboxRejected?(cell: unknown, envelope: unknown): void;
  _onRootCrash(cell: unknown, reason: unknown): Promise<void>;
  _onEscalation(cell: unknown, reason: unknown): Promise<void>;
  _nextChildSeq(): number;
  _register(cell: unknown): void;
  _unregister(cell: unknown): void;
  [key: string]: unknown;
}

/** Actor 定义（actor.ts 的 ActorDefinition 结构）。 */
interface CellDefinition {
  readonly name: string;
  readonly kind: string;
  readonly options: Record<string, unknown>;
  readonly unknownKeys?: string[];
  readonly modulePath?: string | null;
  readonly exportName?: string;
  create(): unknown;
}

class ActorCell {
  readonly system: CellSystem;
  readonly definition: CellDefinition;
  readonly id: string;
  readonly parent:
    | {
        readonly path: string;
        readonly children: Map<string, ActorCell>;
        readonly childSupervisor: InstanceType<typeof ChildSupervisor>;
        _onChildCrash(child: ActorCell, reason: unknown): Promise<void>;
      }
    | null;
  readonly path: string;
  readonly options: {
    mailbox: { maxSize: number; overflow: string };
    supervision: { strategy: string; maxRestarts: number; withinSeconds: number };
    isolation?: string;
    transferable?: boolean;
    rateLimit?: { capacity: number; rate: number } | null;
    retryBackoffMs?: number;
    maxRetryBackoffMs?: number;
    maxRetry?: number;
    askTimeoutMs?: number;
    persistence?: unknown;
    failure?: string;
    [key: string]: unknown;
  };
  readonly mailbox: InstanceType<typeof Mailbox>;
  readonly children: Map<string, ActorCell>;
  readonly childSupervisor: InstanceType<typeof ChildSupervisor>;
  readonly persistence: {
    mode: string;
    /** 存储适配器（内核只调用这几个方法；具体后端由数据层决定）。 */
    store: {
      loadEvents?(id: string): Promise<unknown[]>;
      appendEvent?(id: string, event: unknown, options?: { expectedVersion?: number }): Promise<void>;
      appendEvents?(id: string, events: unknown[], options?: { expectedVersion?: number }): Promise<number>;
      loadSnapshot?(id: string): Promise<unknown>;
      saveSnapshot?(id: string, state: unknown): Promise<void>;
      deleteSnapshot?(id: string): Promise<void>;
      capabilities?(): { conditionalAppend: 'atomic' | 'in-process' | false; batchAppend: 'atomic' | 'in-process' | false };
      [key: string]: unknown;
    } | null;
    /** 持久化邮箱的后端（内核只调用 append/load/ack）。 */
    mailboxStore: {
      append?(id: string, msg: unknown): Promise<{ __msgId?: string; [key: string]: unknown }>;
      load?(id: string): Promise<unknown[]>;
      ack?(id: string, msgIds: string | string[]): Promise<unknown>;
      clear?(id: string): Promise<unknown>;
      pendingCount?(id: string): Promise<number>;
      [key: string]: unknown;
    } | null;
    events?: unknown;
    /** events 模式的快照缓存策略：`{ every: N }` 或 null（不启用）。 */
    snapshot?: { every: number } | null;
    evolution?: Record<string, (...args: unknown[]) => unknown> | null;
    [key: string]: unknown;
  };
  /** 事件日志的"已写入版本"（条件写用）；恢复前是 null。 */
  _eventVersion: number | null;
  _concurrencyWarned: boolean;
  readonly isolation: string;
  readonly transferable: boolean;
  delegate: {
    invoke(payload: unknown, senderPath: string | null, trace: unknown): Promise<unknown>;
    stop(): Promise<void>;
    getState?(timeoutMs?: number): Promise<unknown>;
    readonly pid?: number | null;
    start?(options?: { snapshot?: unknown }): Promise<unknown>;
  } | null;
  readonly bucket: InstanceType<typeof TokenBucket> | null;
  currentTrace: unknown;
  readonly _incarnationWaiters: (() => void)[];
  readonly context: InstanceType<typeof ActorContext>;
  instance: {
    id?: string;
    path?: string;
    state?: unknown;
    receive(msg: unknown, ctx: unknown): unknown;
    preStart?(ctx: unknown): void | Promise<void>;
    postRecover?(ctx: unknown): void | Promise<void>;
    postStop?(ctx: unknown): void | Promise<void>;
    preRestart?(reason: unknown, msg: unknown, ctx: unknown): void | Promise<void>;
    applyEvent?(event: unknown): void;
    [key: string]: unknown;
  } | null;
  started: boolean;
  stopped: boolean;
  crashing: boolean;
  handling: boolean;
  running: boolean;
  currentSender: { path?: string } | null;
  restarts: number;
  readonly counters: ActorCounters;
  readonly ref: InstanceType<typeof ActorRef>;
  supervision?: unknown;
  _snapshotDirty?: boolean;
  _stopPromise?: Promise<void> | null;
  _warned?: Set<string>;

  constructor({
    system,
    definition,
    id,
    parent = null,
    options = {},
  }: {
    system: CellSystem;
    definition: CellDefinition;
    id: string;
    parent?: ActorCell['parent'];
    options?: Record<string, unknown>;
  }) {
    this.system = system;
    this.definition = definition;
    this.id = String(id);
    this.parent = parent;
    this.path = parent ? `${parent.path}/${this.id}` : this.id;

    // A handler bag with stray keys is almost always a typo (`_helper()` instead
    // of `receive()`), and the framework only forwards known handler names —
    // so say something instead of silently dropping the method.
    if (definition.unknownKeys && definition.unknownKeys.length > 0) {
      system._log('actor_definition_unknown_keys', {
        actor: this.path,
        definition: definition.name,
        keys: definition.unknownKeys,
        hint: 'only receive/onMessage, preStart/onStart, postStop/onStop, postRecover, preRestart, applyEvent and state are forwarded',
      });
    }

    this.options = {
      ...system.actorDefaults,
      ...options,
      mailbox: { ...system.actorDefaults.mailbox, ...(options.mailbox || {}) },
      supervision: { ...system.actorDefaults.supervision, ...(options.supervision || {}) },
    };

    this.mailbox = new Mailbox(this.options.mailbox);
    this.children = new Map();
    this.childSupervisor = new ChildSupervisor({
      id: this.path,
      strategy: this.options.supervision.strategy || RestartStrategy.ONE_FOR_ONE,
      maxRestarts: this.options.supervision.maxRestarts,
      withinSeconds: this.options.supervision.withinSeconds,
    });

    this.persistence = resolvePersistence(this.options.persistence, system.persistenceStore);
    /**
     * 事件日志的"已写入版本"（= 条数；数据层有 seq 时就是最后一条的 seq）。
     * 恢复时由 `_restore` 填上，之后每次成功追加 +1 —— 用它做**条件写**（乐观并发）。
     */
    this._eventVersion = null;
    this._concurrencyWarned = false;
    // A durable mailbox is a system-level capability; fall back to it, and fail
    // loudly if the strategy cannot actually persist anything.
    if (this.persistence.mailboxStore === null) {
      this.persistence.mailboxStore = (system.mailboxStore ?? null) as ActorCell['persistence']['mailboxStore'];
    }
    if (this.persistence.mode === 'mailbox' && !this.persistence.mailboxStore) {
      throw new PersistenceError(
        `actor "${this.path}" uses persistence mode "mailbox" but no mailboxStore was configured ` +
          '(pass createSystem({ mailboxStore }))',
      );
    }
    if ((this.persistence.mode === 'snapshot' || this.persistence.mode === 'events') && !this.persistence.store) {
      throw new PersistenceError(
        `actor "${this.path}" uses persistence mode "${this.persistence.mode}" but no store was configured ` +
          '(pass createSystem({ persistenceDir }) or persistence: adapter)',
      );
    }

    // --- isolation ---------------------------------------------------------
    this.isolation = this.options.isolation || 'inline';
    /**
     * 可迁移性（M4 第 6 步）：持有 socket / 文件句柄 / 定时器的 Actor 声明 `transferable: false`，
     * 交接时**明确失败**而不是假装能迁移（doc 05 §1.3：客户端重连才是正确语义）。
     * 默认 true：纯状态 Actor 可以靠"快照 + 事件"在别处重建。
     */
    this.transferable = this.options.transferable !== false;
    if (!['inline', 'worker'].includes(this.isolation)) {
      throw new DefinitionError(`unknown isolation "${this.isolation}" (expected inline|worker)`);
    }
    if (this.isolation === 'worker') {
      if (definition.kind !== 'worker') {
        throw new DefinitionError(
          `actor "${this.path}" uses isolation: 'worker' but was defined inline; ` +
            "pass a module path, e.g. spawn('./actors/player.js', { isolation: 'worker' })",
        );
      }
      if (!['none', 'snapshot'].includes(this.persistence.mode)) {
        throw new PersistenceError(
          `isolation: 'worker' supports persistence 'none' or 'snapshot', got "${this.persistence.mode}"`,
        );
      }
    }
    /** @type {import('./worker-delegate').WorkerDelegate|null} */
    this.delegate = null;

    // Optional per-actor rate limit (rateLimit plugin / { rateLimit } option).
    const limit = this.options.rateLimit || system.rateLimitPolicy || null;
    // 时间来源只能有一个：桶的起点也来自系统时钟
    this.bucket = limit ? new TokenBucket(limit.capacity, limit.rate, this.system.clock.now()) : null;
    /** Trace context of the message being handled (tracing plugin). */
    this.currentTrace = null;
    /**
     * 崩溃/重启窗口内既没有 `instance` 也没有 `delegate`。此时若有外部调用
     * 读取状态（`ref.state()`、`saveSnapshot()`），旧行为是静默返回
     * `undefined`——调用方会以为"这个 Actor 没有状态"，甚至把空状态写进快照。
     * 这里改成等新 incarnation 就位（有界），而不是装作没有状态。
     */
    this._incarnationWaiters = [];
    this.context = new ActorContext(this);
    this.instance = null;
    this.started = false;
    this.stopped = false;
    this.crashing = false;
    this.handling = false;
    /** True while a turn is executing; guards against concurrent re-entry. */
    this.running = false;
    this.currentSender = null;
    this.restarts = 0;
    this.counters = {
      received: 0,
      handled: 0,
      failed: 0,
      retries: 0,
      deadLettered: 0,
      crashed: 0,
      restarted: 0,
      recovered: 0,
      throttled: 0,
      batches: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
    };

    this.ref = new ActorRef({
      id: this.id,
      path: this.path,
      // Forward every argument: the sender and trace must survive the ref
      // boundary so the callee can see who sent the message.
      tell: (msg: unknown, sender?: unknown, trace?: unknown) =>
        this.tell(msg, sender as { path?: string } | null | undefined, trace),
      ask: (msg: unknown, timeoutMs?: number, sender?: unknown, trace?: unknown) =>
        this.ask(msg, timeoutMs, sender as { path?: string } | null | undefined, trace),
      stop: () => this.stop(),
      inspect: () => this.inspect(),
      state: () => this.fetchState(),
    });
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Create the instance, run preStart, then recover persisted state.
   *
   * preStart runs first so it can establish initial state unconditionally;
   * a snapshot or replayed events are applied on top of it (see postRecover).
   */
  async _init(): Promise<void> {
    this.stopped = false;
    this.context.restored = false;
    if (this.isolation === 'worker') return this._initWorker();

    this.instance = this.definition.create() as ActorCell['instance'];
    if (this.instance === null || typeof this.instance.receive !== 'function') {
      throw new DefinitionError(`definition "${this.definition.name}" did not produce an actor with receive()`);
    }
    this.instance.id = this.id;
    this.instance.path = this.path;
    const instance = this.instance;
    await instance.preStart?.(this.context);
    await this._restore();
    if (typeof instance.postRecover === 'function') {
      await instance.postRecover(this.context);
    }
    this.started = true;
    this._markIncarnation();
  }

  /**
   * Worker isolation: the actor's code lives in its own thread. The cell keeps
   * the mailbox, supervision and persistence; only execution is delegated.
   */
  async _initWorker(): Promise<void> {
    const { WorkerDelegate } = require('../worker/worker-delegate.ts');
    let snapshot;
    if (this.persistence.mode === 'snapshot' && this.persistence.store) {
      snapshot = await this._loadSnapshotForRestore();
      if (snapshot !== undefined) this.context.restored = true;
    }
    const delegate = new WorkerDelegate({
      cell: this,
      modulePath: this.definition.modulePath,
      exportName: this.definition.exportName,
    });
    await delegate.start({ snapshot });
    this.delegate = delegate;
    this.started = true;
    this._markIncarnation();
  }

  async _restore(): Promise<void> {
    const { mode, store, mailboxStore } = this.persistence;
    if (mode === 'snapshot' && store !== null) {
      const restoredState = await this._loadSnapshotForRestore();
      if (restoredState !== undefined) {
        if (this.instance !== null) {
          this.instance.state =
            restoredState !== null && typeof restoredState === 'object'
              ? { ...(restoredState as Record<string, unknown>) }
              : restoredState;
        }
        this.context.restored = true;
      }
    } else if (mode === 'events' && store !== null) {
      const loadEvents = store.loadEvents;
      if (typeof loadEvents !== 'function') throw new PersistenceError('persistence store does not implement loadEvents()');
      const raw = await loadEvents.call(store, this.path);
      // The log is the truth; a snapshot (if any) is only a cache that lets us skip
      // the prefix we already folded into the saved state. See _restoreSnapshotCache.
      const snapshotCacheEnabled = this.persistence.snapshot !== null;
      const cached = snapshotCacheEnabled ? await this._restoreSnapshotCache(raw.length > 0) : null;
      const fromSeq = cached !== null ? cached.atSeq + 1 : null;
      // Structure evolution happens **on read**: the stored log is never rewritten,
      // so an upgrade is rollback-able and replays stay reproducible.
      // Prefer the batch hook: sequence continuity can only be checked when the
      // whole log is visible at once (a gap means events were lost).
      const { events, lastVersion } = this._evolveLog(raw, fromSeq);
      this._eventVersion = lastVersion;
      this._warnIfConcurrencyUnsupported();
      for (const event of events) this.instance?.applyEvent?.(event);
      if (events.length > 0) this.context.restored = true;
      this.counters.recovered += events.length;
    } else if (mode === 'mailbox' && mailboxStore !== null) {
      const load = (mailboxStore as { load?(id: string): Promise<unknown[]> }).load;
      if (typeof load !== 'function') throw new PersistenceError('mailboxStore does not implement load()');
      const records = await load.call(mailboxStore, this.path);
      for (const record of records) {
        const payload =
          record !== null && typeof record === 'object' && Object.prototype.hasOwnProperty.call(record, 'payload')
            ? (record as { payload: unknown }).payload
            : record;
        const envelope = this._envelope(payload, null);
        envelope.__msgId = (record as { __msgId?: string }).__msgId;
        this.mailbox.push(envelope);
      }
      this.counters.recovered += records.length;
      if (records.length > 0) this.system.scheduler.schedule(this);
    }
  }

  /** 是否有可用的 incarnation（内联实例或 worker 代理）。 */
  get _hasIncarnation() {
    return Boolean(this.instance || this.delegate);
  }

  _markIncarnation(): void {
    const waiters = this._incarnationWaiters.splice(0);
    for (const w of waiters) w();
  }

  /** 等新 incarnation 就位；已就位或已停止则立即返回。有界，避免永久挂起。 */
  _awaitIncarnation(timeoutMs: number = this.system.shutdownTimeoutMs || 5000): Promise<void> {
    if (this._hasIncarnation || this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: { id: number } | null = null;
      const waiter = (): void => {
        if (timer !== null) this.system.clock.clearTimeout(timer);
        resolve();
      };
      timer = this.system.clock.setTimeout(
        () => {
          const idx = this._incarnationWaiters.indexOf(waiter);
          if (idx >= 0) this._incarnationWaiters.splice(idx, 1);
          resolve(); // 超时后由调用方按"当前确实没有状态"处理
        },
        timeoutMs,
        { unref: true },
      );
      this._incarnationWaiters.push(waiter);
    });
  }

  /** preRestart + postStop for the current incarnation (idempotent). */
  async _teardown(reason: unknown, msg: unknown): Promise<void> {
    // Worker-isolated actors run their hooks inside the worker.
    const delegate = this.delegate;
    if (delegate !== null) {
      this.delegate = null;
      this.started = false;
      try {
        await delegate.stop();
      } catch (err) {
        this.system._log('worker_stop_error', { path: this.path, err: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (!this.instance) return;
    const instance = this.instance;
    this.instance = null;
    this.started = false;
    try {
      if (reason && typeof instance.preRestart === 'function') {
        await instance.preRestart(reason, msg, this.context);
      }
    } catch (err) {
      this.system._log('actor_hook_error', { path: this.path, hook: 'preRestart', err: err instanceof Error ? err.message : String(err) });
    }
    try {
      if (typeof instance.postStop === 'function') await instance.postStop(this.context);
    } catch (err) {
      this.system._log('actor_hook_error', { path: this.path, hook: 'postStop', err: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Stop every child of this actor.
   *
   * `graceful` runs each child's own stop path, which means it executes
   * `postStop` **and persists its snapshot** — hard-terminating instead would
   * silently drop a child's state whenever a parent stops. Each child stop is
   * bounded so one stuck child cannot hang the parent's shutdown.
   */
  async _stopChildren(graceful = true): Promise<void> {
    const children = [...this.children.values()];
    this.children.clear();
    for (const child of children) {
      this.childSupervisor.remove(child.id);
      try {
        if (graceful) await child.stop(this.system.shutdownTimeoutMs);
        else await child._terminate('parent');
      } catch (err) {
        this.system._log('child_stop_error', { path: child.path, err: err instanceof Error ? err.message : String(err) });
        await child._terminate('parent').catch(() => {});
      }
    }
  }

  // --- messaging -----------------------------------------------------------

  _envelope(payload: unknown, reply: CellEnvelope['reply'] = null, sender: { path?: string } | null = null, parentTrace: unknown = null): CellEnvelope {
    const trace = this.system.tracer && this.system.tracer.buildContext
      ? this.system.tracer.buildContext(parentTrace)
      : null;
    return { payload, reply, sender, retryCount: 0, ts: this.system.clock.now(), trace };
  }

  /** Fire and forget. Returns false when the mailbox refused the message. */
  tell(payload: unknown, sender: { path?: string } | null = null, parentTrace: unknown = null): boolean {
    if (this.stopped) return false;
    if (payload === undefined) throw new TypeError('tell(payload): payload is required');
    const envelope = this._envelope(payload, null, sender, parentTrace);
    return this._enqueue(envelope);
  }

  /** Send and wait for the value returned by `receive`. */
  ask(payload: unknown, timeoutMs?: number, sender: { path?: string } | null = null, parentTrace: unknown = null): Promise<unknown> {
    if (this.stopped) return Promise.reject(new ActorStoppedError(`actor ${this.path} is stopped`));
    if (payload === undefined) return Promise.reject(new TypeError('ask(payload): payload is required'));
    const timeout = timeoutMs ?? this.options.askTimeoutMs ?? 5000;

    return new Promise((resolve, reject) => {
      let timer: { id: number } | null = null;
      const reply = {
        resolve: (value: unknown) => {
          if (timer !== null) this.system.clock.clearTimeout(timer);
          resolve(value);
        },
        reject: (err: Error) => {
          if (timer !== null) this.system.clock.clearTimeout(timer);
          reject(err);
        },
      };
      if (Number.isFinite(timeout) && timeout > 0) {
        // 超时定时器也走系统时钟：注入虚拟时钟后，`clock.advance(timeoutMs)` 就能确定性地触发超时
        // （unref 的语义由时钟实现保留：真实时钟下它不钉住进程）
        timer = this.system.clock.setTimeout(() => {
          reply.reject(new AskTimeoutError(`ask to ${this.path} timed out after ${timeout}ms`, { actorId: this.path }));
        }, timeout, { unref: true });
      }
      const envelope = this._envelope(payload, reply, sender, parentTrace);
      if (!this._enqueue(envelope)) {
        reply.reject(new MailboxFullError(`mailbox of ${this.path} is full (${this.mailbox.maxSize})`, { actorId: this.path }));
      }
    });
  }

  _enqueue(envelope: CellEnvelope): boolean {
    const accepted = this.mailbox.push(envelope);
    if (!accepted) {
      this.counters.failed += 0; // backpressure is reported through the return value / rejection
      this.system._onMailboxRejected?.(this, envelope);
      return false;
    }
    if (this.persistence.mode === 'mailbox' && this.persistence.mailboxStore) {
      // Durability is best-effort at enqueue time: a failure here surfaces as
      // a rejection rather than losing the message silently.
      const append = this.persistence.mailboxStore?.append;
      if (typeof append === 'function') {
        append
          .call(this.persistence.mailboxStore, this.path, { payload: envelope.payload })
          .then((record: { __msgId?: string }) => {
            envelope.__msgId = record.__msgId;
          })
          .catch((err: unknown) =>
            this.system._log('durable_enqueue_failed', { path: this.path, err: err instanceof Error ? err.message : String(err) }),
          );
      }
    }
    this.system.scheduler.schedule(this);
    return true;
  }

  /** Process at most `max` messages, then yield to the scheduler. */
  async _runTurn(max: number): Promise<void> {
    // An actor must never process two messages at once. Without this guard a
    // message arriving while receive() is awaiting would start a second turn
    // and re-enter receive() concurrently — a data race on actor state.
    if (this.running) return;
    this.running = true;
    let processed = 0;
    try {
      while (processed < max && !this.stopped) {
        // Per-actor token bucket: wait for a token without reordering the
        // mailbox (the message stays at the head until it is admitted).
        if (this.bucket) {
          const wait = this.bucket.msUntil(1, this.system.clock.now());
          if (wait > 0) {
            this.counters.throttled += 1;
            await sleep(this.system.clock, Math.min(wait, 100));
            continue;
          }
          this.bucket.tryConsume(1, this.system.clock.now()); // 与 msUntil 用同一个时间来源
        }
        const envelope = this.mailbox.shift();
        if (!envelope) break;
        processed += 1;
        if (envelope.kind === 'stop') {
          await this._handleStop(envelope);
          break;
        }
        await this._handleMessage(envelope);
      }
    } finally {
      // One turn = one batch of messages drained in this slice of the loop.
      if (processed > 0) this.counters.batches += 1;
      this.running = false;
      if (!this.stopped && this.mailbox.size > 0) this.system.scheduler.schedule(this);
    }
  }

  async _handleMessage(envelope: CellEnvelope): Promise<void> {
    this.counters.received += 1;
    this.currentSender = envelope.sender || null;
    this.currentTrace = envelope.trace || null;
    this.handling = true;
    const startedAt = this.system.clock.now();
    /**
     * Span 生命周期（M5 第 4 步）。
     *
     * 之前框架只传播 traceId/spanId（上下文），**没有任何"span 开始/结束"** —— 于是"导出到 OTel"
     * 无从谈起（没有东西可导）。这里在处理一条消息的边界上开一个 span：名字是 `path:type`，
     * 属性带 actor 路径、消息类型与结果，结束时交给 `system.spanSink`（如果有）。
     * 没装 sink 时开销只有两个函数调用，热路径不受影响。
     */
    const span =
      typeof this.system._startSpan === 'function'
        ? this.system._startSpan?.({
            name: `${this.path}:${messageTypeOf(envelope.payload)}`,
            trace: envelope.trace || null,
            attributes: {
              'actor.path': this.path,
              'actor.message_type': messageTypeOf(envelope.payload),
            },
          })
        : null;
    let spanStatus = 'ok';
    let spanError = null;
    try {
      const result = this.delegate
        ? await this.delegate.invoke(envelope.payload, envelope.sender ? (envelope.sender.path ?? null) : null, envelope.trace)
        : await this.instance?.receive(envelope.payload, this.context);
      this.counters.handled += 1;
      await this._acknowledge(envelope);
      if (envelope.reply) envelope.reply.resolve(result);
    } catch (err) {
      spanStatus = 'error';
      spanError = err;
      await this._onFailure(err, envelope);
    } finally {
      const elapsed = this.system.clock.now() - startedAt;
      this.counters.totalLatencyMs += elapsed;
      if (elapsed > this.counters.maxLatencyMs) this.counters.maxLatencyMs = elapsed;
      this.handling = false;
      this.currentSender = null;
      this.currentTrace = null;
      if (span !== null) {
        this.system._endSpan?.(span, { status: spanStatus, durationMs: elapsed, error: spanError, at: startedAt + elapsed });
      }
    }
  }

  async _acknowledge(envelope: CellEnvelope): Promise<void> {
    if (this.persistence.mode !== 'mailbox' || !this.persistence.mailboxStore) return;
    if (!envelope.__msgId) return;
    const ack = this.persistence.mailboxStore?.ack;
    if (typeof ack !== 'function') return;
    try {
      await ack.call(this.persistence.mailboxStore, this.path, envelope.__msgId ?? '');
    } catch (err) {
      this.system._log('durable_ack_failed', { path: this.path, err: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Failure semantics, chosen per actor:
   *  - 'crash' (default): the actor fails, the supervisor decides; the message
   *    is dropped and any pending ask is rejected with the real error.
   *  - 'retry': the message is retried with backoff and finally dead-lettered
   *    while the actor keeps running (durable mailbox / queue semantics).
   */
  async _onFailure(err: unknown, envelope: CellEnvelope): Promise<void> {
    this.counters.failed += 1;
    const failure = this.options.failure ?? 'crash';
    const maxRetry = this.options.maxRetry ?? 3;
    const retryBackoffMs = this.options.retryBackoffMs ?? 50;
    const maxRetryBackoffMs = this.options.maxRetryBackoffMs ?? 1000;

    if (failure === 'retry' && (envelope.retryCount ?? 0) < maxRetry) {
      envelope.retryCount = (envelope.retryCount ?? 0) + 1;
      this.counters.retries += 1;
      const backoff = Math.min(retryBackoffMs * 2 ** (envelope.retryCount - 1), maxRetryBackoffMs);
      this.system._log('actor_message_retry', { path: this.path, attempt: envelope.retryCount, err: err instanceof Error ? err.message : String(err) });
      if (backoff > 0) await sleep(this.system.clock, backoff);
      this.mailbox.pushFront(envelope);
      return;
    }

    if (failure === 'retry') {
      this.counters.deadLettered += 1;
      await this._acknowledge(envelope);
      this.system._deadLetter(this, envelope, err);
      if (envelope.reply) envelope.reply.reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Crash semantics: settle the caller, then fail the actor.
    if (envelope.reply) envelope.reply.reject(err instanceof Error ? err : new Error(String(err)));
    await this._acknowledge(envelope);
    await this._crash(err, envelope.payload);
  }

  // --- failure / restart ---------------------------------------------------

  async _crash(reason: unknown, msg: unknown): Promise<void> {
    if (this.crashing || this.stopped) return;
    this.crashing = true;
    this.counters.crashed += 1;
    try {
      // 日志与 teardown 都在 try 内：任何一环抛错都不许把 crashing 永久留在 true
      this.system._log('actor_crash', { path: this.path, err: reason instanceof Error ? reason.message : String(reason) });
      await this._teardown(reason, msg);
      await this._stopChildren();
    } finally {
      this.crashing = false;
    }
    if (this.parent) await this.parent._onChildCrash(this, reason);
    else await this.system._onRootCrash(this, reason);
  }

  /** Bring a crashed (or whole-group-restarted) actor back up. */
  async _restart(reason: unknown): Promise<void> {
    this.restarts += 1;
    this.counters.restarted += 1;
    await this._teardown(reason === undefined ? null : reason, undefined);
    await this._stopChildren();
    await this._init();
    this.system._log('actor_restart', { path: this.path, restarts: this.restarts });
    if (this.mailbox.size > 0) this.system.scheduler.schedule(this);
  }

  async _onChildCrash(child: ActorCell, reason: unknown): Promise<void> {
    const decision = this.childSupervisor.decide(child.id);
    if (decision.action === 'escalate') {
      this.system._log('supervisor_escalate', {
        path: this.path,
        child: child.path,
        reason: decision.reason,
      });
      await this._crash(
        new EscalationError(`child ${child.path} exceeded its restart intensity (${decision.reason})`),
        null,
      );
      return;
    }
    if (decision.action !== 'restart') return;

    for (const id of decision.targets) {
      const target = this.children.get(id);
      if (!target) continue;
      try {
        await target._restart(reason);
      } catch (err) {
        // A restart that fails is itself a failure of that child.
        await this._onChildCrash(target, err);
      }
    }
  }

  // --- stopping ------------------------------------------------------------

  /**
   * Stop this actor and its children after the current message.
   *
   * Bounded by `shutdownTimeoutMs`: an actor stuck in an endless `await`
   * cannot pick up its stop envelope, and without the bound a single stuck
   * actor would hang `system.stop()` (i.e. the whole process shutdown).
   */
  stop(timeoutMs: number = this.system.shutdownTimeoutMs): Promise<void> {
    if (this._stopPromise) return this._stopPromise;

    let resolveStop: () => void = () => {};
    this._stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
      this.mailbox.push({ kind: 'stop', resolve }, { system: true });
      this.system.scheduler.schedule(this);
    });

    const bounded = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    if (bounded === 0) return this._stopPromise;

    const timer = this.system.clock.setTimeout(async () => {
      if (this.stopped) return;
      this.system._log('actor_stop_timeout', {
        path: this.path,
        timeoutMs: bounded,
        hint: 'the actor was busy; forcing termination',
      });
      try {
        await this._terminate('stop_timeout');
      } catch (err) {
        this.system._log('actor_terminate_failed', { path: this.path, err: err instanceof Error ? err.message : String(err) });
      }
      resolveStop();
    }, bounded, { unref: true });

    return this._stopPromise.finally(() => this.system.clock.clearTimeout(timer));
  }

  /** Stop without running the graceful path (parent already gone, or forced). */
  async _terminate(reasonTag = 'forced'): Promise<void> {
    if (this.stopped) return;
    this.system._log('actor_terminate', { path: this.path, reason: reasonTag });
    this._rejectPending();
    await this._teardown(null, undefined);
    await this._stopChildren(false); // forced path: do not wait for graceful child stops
    this._finishStop();
  }

  async _handleStop(envelope: CellEnvelope): Promise<void> {
    // Persist ourselves before taking the children down: a parent's snapshot is
    // usually what makes its children reconstructable at all.
    // `instance` is null for worker-isolated actors (the actor lives in the
    // worker), so check for either incarnation owner — otherwise an isolated
    // actor with snapshot persistence would silently lose its state on stop.
    //
    // `started` matters for data safety: an actor whose `_init` threw (e.g. a
    // snapshot that refuses to migrate) never recovered anything, so persisting
    // its preStart defaults here would **overwrite the very data the error was
    // protecting**. Only a successfully started incarnation may write.
    const wantsStopSnapshot =
      this.persistence.mode === 'snapshot' ||
      (this.persistence.mode === 'events' && this.persistence.snapshot !== null);
    if (wantsStopSnapshot && this.persistence.onStop && this.started && (this.instance || this.delegate)) {
      try {
        await this.saveSnapshot();
      } catch (err) {
        this.system._log('snapshot_on_stop_failed', { path: this.path, err: err instanceof Error ? err.message : String(err) });
      }
    }
    // Graceful: children run postStop and persist their own snapshots.
    if (this.options.stopChildrenOnStop !== false) await this._stopChildren(true);
    await this._teardown(null, undefined);
    this._finishStop();
    if (typeof envelope.resolve === 'function') envelope.resolve();
  }

  _finishStop(): void {
    const wasStopped = this.stopped;
    this.stopped = true;
    this.started = false;
    this._markIncarnation(); // 叫醒等待者：已停止，别等下去了
    // _rejectPending() drains the mailbox: clearing it first would silently
    // drop queued messages whose callers are still awaiting a reply.
    this._rejectPending();
    if (!wasStopped) {
      this.system._unregister(this);
      if (this.parent) {
        this.parent.children.delete(this.id);
        this.parent.childSupervisor.remove(this.id);
      }
    }
  }

  /** Never leave an `ask` hanging because the actor went away. */
  _rejectPending(): void {
    const leftover = this.mailbox.drain();
    for (const envelope of leftover) {
      if (envelope.reply) envelope.reply.reject(new ActorStoppedError(`actor ${this.path} stopped before replying`));
    }
  }

  // --- children ------------------------------------------------------------

  async spawnChild(definition: unknown, options: Record<string, unknown> = {}): Promise<ActorCell> {
    if (this.stopped) throw new ActorStoppedError(`cannot spawn from stopped actor ${this.path}`);
    const defn = options.isolation === 'worker'
      ? require('../worker/worker-delegate.ts').defineWorkerActor(definition, options)
      : defineActor(definition);
    const id = options.id ? String(options.id) : `${defn.name}-${this.system._nextChildSeq()}`;
    if (this.children.has(id)) throw new DefinitionError(`child "${id}" already exists under ${this.path}`);

    const child = new ActorCell({
      system: this.system,
      definition: defn,
      id,
      parent: this,
      options: { ...defn.options, ...options },
    });
    this.children.set(id, child);
    this.childSupervisor.add(id);
    this.system._register(child);

    try {
      await child._init();
    } catch (err) {
      this.system._log('actor_init_failed', { path: child.path, err: err instanceof Error ? err.message : String(err) });
      const decision = this.childSupervisor.decide(id);
      if (decision.action === 'escalate') {
        this.system._log('supervisor_escalate', { path: this.path, child: child.path, reason: decision.reason });
        throw err;
      }
      for (const targetId of decision.targets) {
        const target = this.children.get(targetId);
        if (!target) continue;
        try {
          await target._restart(err);
        } catch (retryErr) {
          this.system._log('actor_init_retry_failed', { path: target.path, err: retryErr instanceof Error ? retryErr.message : String(retryErr) });
        }
      }
      if (!child.started) throw err;
    }
    return child.ref;
  }

  // --- persistence hooks ---------------------------------------------------

  /**
   * `events` 模式下的快照缓存恢复。
   *
   * 三种结果：
   *   - 没有快照 / 不是内核写的缓存 → `null`（老老实实全量重放）；
   *   - 快照可用 → 把状态装上、返回 `{ atSeq }`，调用方只重放 `seq > atSeq` 的增量；
   *   - 快照**不可用**（结构版本对不上等）→ 有事件日志就**丢弃快照、从 0 全量重放**
   *     （doc 04 §4.2 规则 2：日志是真相，快照只是缓存）；没有日志可重建时**拒绝启动**
   *     （规则 3：宁可不启动，也不拿错结构凑合）。
   */
  async _restoreSnapshotCache(hasEventLog: boolean): Promise<{ atSeq: number } | null> {
    const store = this.persistence.store;
    if (store === null) return null;
    const loadSnapshot = store.loadSnapshot;
    if (typeof loadSnapshot !== 'function') return null;
    const raw = await loadSnapshot.call(store, this.path);
    if (raw === undefined) return null;
    const cached = unwrapEventsSnapshot(raw);
    if (!cached) return null; // 旧数据 / 外来文件：当作没有缓存
    try {
      const state = this._decodeSnapshotPayload(cached.snapshot);
      if (state === undefined) return null;
      if (this.instance !== null) {
        this.instance.state = state !== null && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : state;
      }
      this.context.restored = true;
      return { atSeq: cached.atSeq };
    } catch (err) {
      if (!hasEventLog) throw err; // 无日志可重建 → 明确拒绝启动
      this.system._log('snapshot_unusable', {
        path: this.path,
        atSeq: cached.atSeq,
        err: err instanceof Error ? err.message : String(err),
        action: 'rebuild_from_events',
      });
      return null;
    }
  }

  /** 快照里那层用户状态：交给数据层的 decodeSnapshot（版本校验/迁移在这里）。 */
  _decodeSnapshotPayload(payload: unknown): unknown {
    const evolution = this.persistence.evolution;
    const decode = evolution?.decodeSnapshot;
    if (decode === undefined) return payload;
    return callEvolution(decode, 'decodeSnapshot', payload);
  }

  /**
   * Load a snapshot and run it through the evolution hook.
   *
   * `decodeSnapshot` may:
   *   - return state     → used as-is;
   *   - return undefined → "no usable snapshot" (recovery simply continues);
   *   - throw            → the actor **refuses to start** (a wrong structure is
   *                        never silently applied).
   */
  async _loadSnapshotForRestore(): Promise<unknown> {
    const store = this.persistence.store;
    const evolution = this.persistence.evolution;
    if (store === null) return undefined;
    const loadSnapshot = store.loadSnapshot;
    if (typeof loadSnapshot !== 'function') return undefined;
    const raw = await loadSnapshot.call(store, this.path);
    if (raw === undefined || raw === null) return undefined;
    const decode = evolution?.decodeSnapshot;
    // 交给数据层的 decodeSnapshot（版本校验/迁移在这里；抛错 = 拒绝启动）。
    // 返回值就是"快照里那个值"：snapshot 模式是裸状态，events 模式是 { __snapshotAtSeq, snapshot }。
    return decode === undefined ? raw : callEvolution(decode, 'decodeSnapshot', raw);
  }

  /**
   * Turn the stored records into the events to apply.
   *
   * `readLog` (batch) is preferred over `upcast` (per event) because sequence
   * continuity — "no event was lost" — can only be established with the whole log
   * in hand. A data layer that only provides `upcast` keeps working unchanged.
   */
  _evolveLog(raw: unknown, fromSeq: number | null = null): { events: unknown[]; lastVersion: number } {
    const evolution = this.persistence.evolution;
    const records = Array.isArray(raw) ? raw : [];
    // 没有批量 hook 的路径按**条数**切增量：内核记的 atSeq 就是"日志版本 = 条数"
    const slice = (list: unknown[]): unknown[] => (fromSeq === null ? list : list.slice(Math.max(0, fromSeq - 1)));
    const readLog = evolution?.readLog;
    if (readLog === undefined) {
      const upcast = evolution?.upcast;
      if (upcast === undefined) return { events: slice(records), lastVersion: records.length };
      return { events: slice(records).map((item) => callEvolution(upcast, 'upcast', item)), lastVersion: records.length };
    }
    const result = callEvolution(readLog, 'readLog', records, fromSeq === null ? {} : { fromSeq }) as
      | { events?: unknown; lastSeq?: unknown }
      | null
      | undefined;
    if (result === null || result === undefined || !Array.isArray(result.events)) {
      throw new PersistenceError('persistence.evolution.readLog must return { events: [...] }');
    }
    const lastSeq = Number.isInteger(result.lastSeq) ? (result.lastSeq as number) : null;
    // 数据层跟踪 seq 时以它为准；否则退回"记录条数"（后端只认条数，格式无关）
    return { events: result.events, lastVersion: lastSeq ?? records.length };
  }

  /** 后端不支持条件写时说一次（而不是让用户"以为有乐观并发保护"）。 */
  _warnIfConcurrencyUnsupported(): void {
    if (this._concurrencyWarned || this.persistence.mode !== 'events') return;
    this._concurrencyWarned = true;
    if (this._conditionalAppend()) return;
    this.system._log('persistence_concurrency_unsupported', {
      path: this.path,
      hint: '该后端不支持条件写（capabilities().conditionalAppend === false）：并发写入不会被拦住',
    });
  }

  /** 后端是否支持条件写（'atomic' 或 'in-process' 都算；默认 false）。 */
  _conditionalAppend(): boolean {
    const store = this.persistence.store;
    if (!store || typeof store.capabilities !== 'function') return false;
    const capability = (store.capabilities() || {}).conditionalAppend;
    return capability === 'atomic' || capability === 'in-process';
  }

  /**
   * 一次写入**一批**事件（一条命令产出的多个事件）。
   *
   * 与 `persistEvent` 的区别只有一处，但很关键：**版本检查覆盖整批**。逐条写的坏处是
   * "第二条撞车时第一条已经落盘"——日志自洽，但一条命令只写了一半。后端不支持批量时
   * 退回逐条（并记一条日志，不假装原子）。
   */
  async persistEvents(events: unknown[]): Promise<number> {
    const list = [...events];
    if (list.length === 0) return 0;
    const { mode, store, evolution } = this.persistence;

    if (mode === 'events' && store !== null) {
      const version = this._eventVersion;
      const canBatch = this._conditionalAppend() && this._batchAppend();
      if (list.length > 1 && !canBatch) {
        this._warnOnce('batch', 'persistence_batch_unsupported', {
          path: this.path,
          events: list.length,
          hint: '该后端没有批量条件写：一条命令的多条事件会逐条写入（可能只写进去一半）',
        });
      }
      const appendEvents = store.appendEvents;
      const appendEvent = store.appendEvent;
      if (canBatch && version !== null && typeof appendEvents === 'function') {
        await appendEvents.call(store, this.path, list, { expectedVersion: version });
        this._eventVersion = version + list.length;
      } else {
        if (typeof appendEvent !== 'function') {
          throw new PersistenceError('persistence store does not implement appendEvent()');
        }
        for (const event of list) {
          const current = this._eventVersion;
          const options = this._conditionalAppend() && current !== null ? { expectedVersion: current } : {};
          await appendEvent.call(store, this.path, event, options);
          this._eventVersion = (current ?? 0) + 1;
        }
      }
    }
    if (mode === 'snapshot') this._snapshotDirty = true;

    // Apply **exactly what a replay would apply**（与 persistEvent 同一条管线）
    const upcast = evolution?.upcast;
    for (const event of list) {
      const applied = upcast === undefined ? event : callEvolution(upcast, 'upcast', event);
      this.instance?.applyEvent?.(applied);
    }
    // 状态已更新，这时存缓存才是安全的（见 _autoSnapshotIfDue）
    if (mode === 'events') await this._autoSnapshotIfDue();
    return list.length;
  }

  /** 写一条事件；返回写入后的日志版本（= 条数）。 */
  async persistEvent(event: unknown): Promise<number> {
    await this.persistEvents([event]);
    return this._eventVersion ?? 0;
  }

  /** 后端是否支持**批量**条件写（能力默认 false）。 */
  _batchAppend(): boolean {
    const store = this.persistence.store;
    if (!store || typeof store.capabilities !== 'function') return false;
    const capability = (store.capabilities() || {}).batchAppend;
    return capability === 'atomic' || capability === 'in-process';
  }

  /** 同一类日志只记一次（避免刷屏）。 */
  _warnOnce(kind: string, event: string, meta?: Record<string, unknown>): void {
    this._warned ??= new Set();
    if (this._warned.has(kind)) return;
    this._warned.add(kind);
    this.system._log(event, meta);
  }

  async saveSnapshot(): Promise<void> {
    const store = this.persistence.store;
    const evolution = this.persistence.evolution;
    const mode = this.persistence.mode;
    if (store === null) return;
    const saveSnapshot = store.saveSnapshot;
    if (typeof saveSnapshot !== 'function') return;
    const state = await this.fetchState();
    if (state === undefined) return;
    // The caller gets the live state back; only what lands on disk goes through
    // encodeSnapshot (headers, version markers, …).
    const payload = evolution && evolution.encodeSnapshot
      ? callEvolution(evolution.encodeSnapshot, 'encodeSnapshot', state)
      : state;
    // 启用了快照缓存的事件溯源模式：快照必须记住"这是重放到第几条时的状态"，
    // 否则恢复时无法只重放增量（甚至会把状态套错位置）。
    // 没启用时保持与 M3 之前**逐字节一致**（裸状态），这样"可选"是真的可选。
    const stored =
      mode === 'events' && this.persistence.snapshot !== null
        ? wrapEventsSnapshot(this._eventVersion ?? 0, payload)
        : payload;
    await saveSnapshot.call(store, this.path, stored);
    this._snapshotDirty = false;
  }

  /**
   * 每写 N 条事件自动存一次缓存。
   *
   * 时机很关键：必须在**事件应用到内存状态之后**调用，否则快照会记下"atSeq 已包含这条"
   * 却存着不含它的状态，恢复时就会丢状态。失败只记日志——事件已经 durable，快照只是缓存。
   */
  async _autoSnapshotIfDue(): Promise<void> {
    const mode = this.persistence.mode;
    const snapshot = this.persistence.snapshot;
    if (mode !== 'events' || snapshot === null || snapshot === undefined || snapshot.every <= 0) return;
    if (!this.instance) return; // worker 隔离不支持 events 模式
    if ((this._eventVersion ?? 0) % snapshot.every !== 0) return;
    try {
      await this.saveSnapshot();
    } catch (err) {
      this.system._log('snapshot_auto_failed', { path: this.path, err: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * The actor's current state: local for inline actors, fetched over the worker
   * protocol for isolated ones. Always a clone, never the live object.
   */
  async fetchState(): Promise<unknown> {
    // 重启窗口内先等新 incarnation，别把"暂时没有"当成"没有状态"。
    if (!this._hasIncarnation && !this.stopped) await this._awaitIncarnation();
    const delegate = this.delegate;
    if (delegate !== null) {
      const getState = delegate.getState;
      return typeof getState === 'function' ? getState.call(delegate) : undefined;
    }
    if (!this.instance) return undefined;
    const state = this.instance.state;
    if (state === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(state));
    } catch {
      return state;
    }
  }

  /** Synchronous best-effort view for inspect(); worker state is not fetched. */
  _statePreview(): Record<string, unknown> {
    if (this.delegate) return { stateLocation: 'worker', state: '[isolated]' };
    const state = this.instance ? this.instance.state : undefined;
    try {
      return { state: state === undefined ? undefined : JSON.parse(JSON.stringify(state)) };
    } catch {
      return { state: '[unserialisable]' };
    }
  }

  // --- introspection -------------------------------------------------------

  inspect(): Record<string, unknown> {
    const preview = this._statePreview();
    return {
      id: this.id,
      path: this.path,
      definition: this.definition.name,
      isolation: this.isolation,
      worker: this.delegate ? { pid: this.delegate.pid } : null,
      started: this.started,
      stopped: this.stopped,
      restarts: this.restarts,
      mailbox: {
        size: this.mailbox.size,
        maxSize: this.mailbox.maxSize,
        overflow: this.mailbox.overflow,
        dropped: this.mailbox.dropped,
        rejected: this.mailbox.rejected,
      },
      counters: { ...this.counters },
      ...preview,
      children: [...this.children.keys()],
      supervision: this.childSupervisor.info(),
      persistence: { mode: this.persistence.mode, restored: this.context.restored },
    };
  }
}

module.exports = ActorCell;
