// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const EventEmitter = require('events');
const config = require('../config.ts');
const InlineScheduler = require('./scheduler.ts');
const ActorCell = require('./actor-cell.ts');
const ChildSupervisor = require('./guardian.ts');
const { defineActor } = require('./actor.ts');
const { FilePersistence, MemoryPersistence } = require('../store/persistence.ts');
const { Peer, createServerGateway, RemoteRef } = require('../cluster/remote.ts');
const { resolveClock } = require('../obs/clock.ts');
const { ActorNotFoundError, ActorStoppedError, DefinitionError, EscalationError } = require('./errors.ts');
const RestartStrategy = require('./restart-strategy.ts');

const { randomBytes } = require('node:crypto');

/** 生成 span/trace id（十六进制；OTLP 要的就是这种形式）。 */
function randomHex(bytes: number): string {
  return randomBytes(Math.ceil(bytes / 2)).toString('hex').slice(0, bytes);
}

const DEFAULT_ACTOR_OPTIONS = {
  mailbox: { maxSize: 1000, overflow: 'reject' },
  supervision: { strategy: RestartStrategy.ONE_FOR_ONE, maxRestarts: 3, withinSeconds: 5 },
  failure: 'crash',
  maxRetry: 3,
  retryBackoffMs: 50,
  maxRetryBackoffMs: 1000,
  persistence: 'none',
  askTimeoutMs: 5000,
};

/**
 * The actor system: root supervisor, registry, scheduler and defaults.
 *
 * A system is a self-contained world — nothing here is process-global, so two
 * systems can coexist in one process (which the previous env-driven singletons
 * made impossible).
 */
/** 可注入时钟（结构型：内核是 CJS，不能从 clock.ts 里 import 类型）。 */
interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number, options?: { unref?: boolean }): { id: number };
  clearTimeout(handle: { id: number } | null | undefined): void;
  setInterval(cb: () => void, ms: number, options?: { unref?: boolean }): { id: number };
  clearInterval(handle: { id: number } | null | undefined): void;
}

/** ActorCell 的结构视图：只声明系统真正用到的成员。 */
interface CellLike {
  readonly id: string;
  readonly path: string;
  readonly ref: unknown;
  stopped: boolean;
  running: boolean;
  readonly children: Map<string, unknown>;
  readonly mailbox: { size: number };
  readonly counters: Record<string, number>;
  readonly isolation?: string;
  readonly supervisor: { remove(childId: string): void };
  start(): Promise<void>;
  stop(timeoutMs?: number): Promise<void>;
  _runTurn(messagesPerTurn: number): Promise<void>;
  setParent(parent: unknown): void;
  _restart(reason: unknown): Promise<void>;
  readonly started: boolean;
  inspect(): Record<string, unknown>;
  [key: string]: unknown;
}

/** 插件契约（与 index.d.ts 的 Plugin 同形）。 */
interface PluginLike {
  name: string;
  setup?(system: ActorSystem): void | Promise<void>;
  teardown?(system: ActorSystem): void | Promise<void>;
}

/** 信封：调度器/邮箱里传递的那条消息。 */
interface EnvelopeLike {
  payload?: unknown;
  retryCount?: number;
  sender?: unknown;
  [key: string]: unknown;
}

/** span（M5 第 4 步）：处理一条消息的生命周期。 */
interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sampled: boolean;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status?: 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
}

/** 插件提供的服务（具体形状由各插件决定）。 */
interface PluginService {
  [key: string]: unknown;
}

interface ActorSystemOptions {
  logger?: ((event: string, meta?: Record<string, unknown>) => void) | false | null;
  name?: string;
  clock?: Clock;
  spanSink?: { onSpan(span: Span): void } | null;
  defaults?: Record<string, unknown>;
  messagesPerTurn?: number;
  cellsPerTurn?: number;
  persistence?: Record<string, unknown> | null;
  persistenceDir?: string;
  mailboxStore?: unknown;
  maxDeadLetters?: number;
  plugins?: PluginLike[];
  shutdownTimeoutMs?: number;
  /** 对等体数量上限（审计 F7），默认 128。 */
  maxPeers?: number;
}

class ActorSystem extends EventEmitter {
  name: string;
  logger: ((event: string, meta?: Record<string, unknown>) => void) | null;
  clock: Clock;
  spanSink: { onSpan(span: Span): void } | null;
  startedAt: number;
  stopped: boolean;
  actorDefaults: {
    mailbox: { maxSize: number; overflow: string };
    supervision: { strategy: string; maxRestarts: number; withinSeconds: number };
    failure: string;
    maxRetry: number;
    retryBackoffMs: number;
    maxRetryBackoffMs: number;
    persistence: string;
    askTimeoutMs: number;
    [key: string]: unknown;
  };
  scheduler: InstanceType<typeof InlineScheduler>;
  persistenceStore: unknown;
  mailboxStore: unknown;
  rootSupervisor: InstanceType<typeof ChildSupervisor>;
  /** 路径（或唯一 id）-> cell。 */
  cells: Map<string, CellLike>;
  deadLetters: unknown[];
  maxDeadLetters: number;
  _seq: number;
  /** 可选的 server gateway（`listen()` 之后存在）。 */
  server: {
    boundPort: number;
    listen(): Promise<void>;
    close?(): Promise<void>;
    on(event: string, handler: (...args: never[]) => void): void;
  } | null;
  /** nodeId / "host:port" -> peer 连接。 */
  peers: Map<
    string,
    {
      readonly nodeId: string;
      readonly host: string;
      readonly port: number;
      ref(path: string): unknown;
      close(): Promise<void>;
    }
  >;
  _plugins: PluginLike[];
  installed: Map<string, PluginLike>;
  _initPromise: Promise<void> | null;
  tracer: { buildContext(parent: unknown): unknown; child(parent: unknown): unknown } | null;
  rateLimitPolicy: { capacity: number; rate: number } | null;
  deadLetterStore: { init?(): Promise<void>; enqueue(entry: unknown): Promise<unknown>; readAll?(): Promise<unknown[]>; clear?(): Promise<unknown> } | null;
  deadLetterSink: ((entry: unknown) => Promise<unknown>) | null;
  cluster: PluginService | null;
  pubsub: PluginService | null;
  metrics: PluginService | null;
  metricsExporter: PluginService | null;
  shutdownTimeoutMs: number;
  /** 传输层默认 TLS 配置（插件可覆盖；listen/connect 未显式传时使用）。 */
  tls: unknown;

  constructor(options: ActorSystemOptions = {}) {
    super();
    if (options.logger === false) this.logger = null;
    else this.logger = options.logger || null;

    this.name = options.name || 'actor-system';
    // 可注入时钟：默认真实时钟；测试注入虚拟时钟后，超时/限流/轮询全部可以"瞬时"推进
    this.clock = resolveClock(options.clock);
    /** span 出口（结构型）：插件或用户接上；没接就没有 span 开销。 */
    this.spanSink = options.spanSink || null;
    this.startedAt = this.clock.now();
    this.stopped = false;

    const defaults = (options.defaults ?? {}) as {
      mailbox?: Record<string, unknown>;
      supervision?: Record<string, unknown>;
    };
    this.actorDefaults = {
      ...DEFAULT_ACTOR_OPTIONS,
      ...defaults,
      mailbox: { ...DEFAULT_ACTOR_OPTIONS.mailbox, ...(defaults.mailbox ?? {}) },
      supervision: { ...DEFAULT_ACTOR_OPTIONS.supervision, ...(defaults.supervision ?? {}) },
    } as ActorSystem['actorDefaults'];

    this.scheduler = new InlineScheduler({
      messagesPerTurn: options.messagesPerTurn,
      cellsPerTurn: options.cellsPerTurn,
      onError: (err: Error, cell: { path?: string }) => this._log('scheduler_error', { path: cell.path, err: err.message }),
    });

    const persistenceSpec = options.persistence as
      | { loadSnapshot?: unknown; backend?: string; dir?: string }
      | null
      | undefined;
    if (persistenceSpec && typeof persistenceSpec === 'object' && typeof persistenceSpec.loadSnapshot === 'function') {
      this.persistenceStore = persistenceSpec; // an adapter instance
    } else if (persistenceSpec && typeof persistenceSpec === 'object' && persistenceSpec.backend === 'memory') {
      this.persistenceStore = new MemoryPersistence();
    } else {
      const baseDir = (persistenceSpec && persistenceSpec.dir) || options.persistenceDir;
      this.persistenceStore = baseDir ? new FilePersistence({ baseDir }) : null;
    }
    this.mailboxStore = options.mailboxStore || null;

    this.rootSupervisor = new ChildSupervisor({
      id: this.name,
      strategy: this.actorDefaults.supervision.strategy,
      maxRestarts: this.actorDefaults.supervision.maxRestarts,
      withinSeconds: this.actorDefaults.supervision.withinSeconds,
    });

    this.cells = new Map();
    this.deadLetters = [];
    this.maxDeadLetters = options.maxDeadLetters || 1000;
    this._seq = 0;
    /** Optional server gateway (system.listen) and connected peers. */
    this.server = null;
    this.peers = new Map();

    // --- plugin services ---------------------------------------------------
    this._plugins = [...(options.plugins ?? [])].filter(Boolean);
    this.installed = new Map();
    this._initPromise = null;
    /**
     * Hooks that plugins may fill in. Keeping them as plain fields means the
     * actor hot path stays branch-light when no plugin is installed.
     */
    this.tracer = null; // tracing plugin: Trace-like { buildContext, child }
    this.rateLimitPolicy = null; // rateLimit plugin: { capacity, ratePerSec }
    this.deadLetterStore = null; // deadLetters plugin: a DeadLetterQueue-like store
    this.deadLetterSink = null; // cluster/pubsub style async sink

    // Services attached by plugins. Declared so an absent service is a
    // documented `null` rather than `undefined`.
    this.cluster = null;
    this.pubsub = null;
    this.metrics = null;
    this.metricsExporter = null;

    /** How long a graceful actor stop may take before it is forced. */
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? (config.actor.shutdownTimeoutMs as number);
    this.maxPeers = options.maxPeers ?? 128;
    this.tls = config.tls;
  }

  /**
   * Install plugins. Idempotent, and called automatically by spawn()/listen()
   * so plugins work without an explicit bootstrap step.
   */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      for (const plugin of this._plugins) {
        if (typeof plugin.setup === 'function') await plugin.setup(this);
        this.installed.set(plugin.name || `plugin-${this.installed.size}`, plugin);
        this._log('plugin_installed', { plugin: plugin.name });
      }
    })();
    return this._initPromise;
  }

  /**
   * 遥测监听器抛错**不能影响内核**（审计 F2）。
   *
   * 为什么在 `emit` 上兜：`logger` 与 `spanSink` 各自有 try/catch，但 `system.emit(...)` 是
   * 文档化的遥测接缝，任何一条 `on('actor_stopped'|'log'|'dead_letter'|…)` 抛错都会沿着
   * 调用栈炸回去——`_unregister` 在 `cell.stop()` 的 resolve **之前**，于是停机永久挂住；
   * `_log('actor_crash')` 抛错则让 `crashing` 永久为 true、该 Actor 再也不重启。
   *
   * 这里只用一个**不会递归**的兜底（直接调 logger，而不是再走 `_log`），并如实记一条事件：
   * 监听器坏了要看得见，而不是把内核拖下水。
   */
  emit(event: string | symbol, ...args: unknown[]): boolean {
    try {
      return super.emit(event, ...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        if (this.logger) this.logger('event_listener_failed', { event: String(event), err: message });
      } catch {
        /* 坏日志器同样不能影响内核 */
      }
      return false;
    }
  }

  /** The installed plugin with that name, or null. */
  plugin(name: string): PluginLike | null {
    return this.installed.get(name) || null;
  }

  // --- spawning ------------------------------------------------------------

  /**
   * Spawn a top-level actor.
   * @param {Function|object} definition class, handler, or handler bag
   * @param {{id?:string}} [options]
   * @returns {Promise<import('./actor-ref').ActorRef>}
   */
  /**
   * 开始一个 span（M5 第 4 步）。没有 sink 时返回 `null`（热路径零开销）。
   *
   * `system.spanSink` 是**结构型**接缝：任何 `{ onSpan(span) }` 都能接（内核不依赖 OTel SDK）。
   * 内置的 `plugins.otlp()` 就是一个 sink；想接官方 SDK 就自己实现 onSpan。
   */
  _startSpan(input: { name: string; trace?: unknown; attributes?: Record<string, string | number | boolean> }): Span | null {
    if (!this.spanSink) return null;
    const parent = (input.trace ?? null) as { traceId?: unknown; spanId?: unknown; sampled?: unknown } | null;
    return {
      name: String(input.name),
      traceId: parent !== null && typeof parent.traceId === 'string' ? parent.traceId : randomHex(32),
      spanId: randomHex(16),
      parentSpanId: parent !== null && typeof parent.spanId === 'string' ? parent.spanId : null,
      sampled: parent === null ? true : parent.sampled !== false,
      startTimeMs: this.clock.now(),
      attributes: { ...(input.attributes ?? {}) },
    };
  }

  /** 结束 span 并交给 sink；sink 抛错不能影响 Actor（只记日志）。 */
  _endSpan(span: Span | null, outcome: { status?: string; durationMs?: number; error?: unknown; at?: number }): void {
    if (span === null || !this.spanSink) return;
    span.status = outcome.status === 'error' ? 'error' : 'ok';
    span.endTimeMs = typeof outcome.at === 'number' ? outcome.at : span.startTimeMs + (outcome.durationMs ?? 0);
    span.durationMs = Number(outcome.durationMs) || 0;
    const error = outcome.error;
    if (error !== null && error !== undefined) {
      span.attributes['error.type'] = error instanceof Error ? error.name : 'Error';
      span.attributes['error.message'] = error instanceof Error ? error.message : String(error);
    }
    try {
      this.spanSink.onSpan(span);
    } catch (err) {
      this._log('span_sink_failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  async spawn(definition: unknown, options: { id?: string; isolation?: string; [key: string]: unknown } = {}): Promise<unknown> {
    if (this.stopped) throw new ActorStoppedError('actor system is stopped');
    await this.init();
    const defn = options.isolation === 'worker'
      ? require('../worker/worker-delegate.ts').defineWorkerActor(definition, options)
      : defineActor(definition);
    const id = options.id ? String(options.id) : `${defn.name}-${(this._seq += 1)}`;
    if (this.cells.has(id)) throw new DefinitionError(`actor "${id}" already exists`);

    const cell = new ActorCell({
      system: this,
      definition: defn,
      id,
      parent: null,
      options: { ...defn.options, ...options },
    });
    this.rootSupervisor.add(id);
    this._register(cell);

    try {
      await cell._init();
    } catch (err) {
      this._log('actor_init_failed', { path: cell.path, err: err instanceof Error ? err.message : String(err) });
      const decision = this.rootSupervisor.decide(id, this.clock.now());
      if (decision.action === 'escalate') {
        await this._onEscalation(cell, err);
        throw err;
      }
      let recovered = false;
      for (const targetId of decision.targets) {
        const target = this.cells.get(targetId);
        if (!target) continue;
        try {
          await target._restart(err);
          recovered = target.started;
        } catch (retryErr) {
          this._log('actor_init_retry_failed', { path: target.path, err: retryErr instanceof Error ? retryErr.message : String(retryErr) });
        }
      }
      if (!recovered) {
        // 审计 F6：失败的 spawn 不能留在注册表里。否则 `listActors()`/`resolve()` 会把它当正常
        // Actor（半初始化的实例还能收消息、id 被永久占用），而调用方已经拿到"spawn 失败"。
        this._abandon(cell);
        throw err;
      }
    }

    this.emit('actor_started', cell.ref);
    return cell.ref;
  }

  /** Spawn and await readiness in one call (alias with a friendlier name). */
  async start(definition: unknown, options?: Record<string, unknown>): Promise<unknown> {
    return this.spawn(definition, options);
  }

  // --- lookup --------------------------------------------------------------

  /** 解析出 ActorRef（本地唯一 id / 路径，或集群插件给出的远端引用）。 */
  resolve(idOrPath: string): unknown | null {
    const key = String(idOrPath);
    const direct = this.cells.get(key);
    if (direct && !direct.stopped) return direct.ref;
    // Convenience fallback for a bare id, but only when it is unambiguous:
    // "alice" may exist under several parents, and guessing would be wrong.
    let match: CellLike | null = null;
    for (const cell of this.cells.values()) {
      if (cell.stopped || cell.id !== key) continue;
      if (match) return null; // ambiguous
      match = cell;
    }
    if (match) return match.ref;

    // Cluster plugin: a path that is not local may live on a known peer.
    const remoteResolve = this.cluster?.resolveRemote;
    if (typeof remoteResolve === 'function') {
      return (remoteResolve as (target: string) => unknown)(key);
    }
    return null;
  }

  /** Like resolve(), but throws when the actor is unknown. */
  ref(idOrPath: string): unknown {
    const found = this.resolve(idOrPath);
    if (!found) throw new ActorNotFoundError(`no actor registered as "${idOrPath}"`);
    return found;
  }

  /** Introspection for one actor (works for stopped-but-remembered ids too). */
  inspect(idOrPath: string): Record<string, unknown> {
    const key = String(idOrPath);
    const cell = this.cells.get(key);
    if (cell) return cell.inspect();
    const found = this.resolve(key);
    if (found) {
      for (const candidate of this.cells.values()) {
        if (candidate.ref === found) return candidate.inspect();
      }
    }
    throw new ActorNotFoundError(`no actor registered as "${idOrPath}"`);
  }

  /** Every live actor path, depth-first. */
  listActors(): string[] {
    return [...this.cells.keys()].sort();
  }

  get size() {
    return this.cells.size;
  }

  // --- clustering (location transparency) ----------------------------------

  /**
   * Serve this node's actors to peers. Returns the bound port, so passing
   * `port: 0` is a convenient way to get an ephemeral port in tests.
   */
  async listen(options: Record<string, unknown> = {}): Promise<unknown> {
    if (this.stopped) throw new ActorStoppedError('actor system is stopped');
    // Match the documented contract above: listen() bootstraps plugins too, not
    // just spawn(). A pure gateway node has no actors, yet the cluster plugin
    // must be installed *before* the 'listening' event so it can advertise the
    // gateway port it just bound.
    await this.init();
    if (this.server) return this.server.boundPort;
    const server = createServerGateway(this, { ...options, tls: options.tls ?? this.tls });
    server.on('tell_error', ((err: Error, target: string) => this._log('remote_tell_failed', { target, err: err.message })) as (...args: never[]) => void);
    try {
      await server.listen();
    } catch (err) {
      this.server = null;
      throw err;
    }
    this.server = server;
    this.emit('listening', server.boundPort);
    return server.boundPort;
  }

  get port(): number | null {
    return this.server ? this.server.boundPort : null;
  }

  /**
   * 持久化后端能保证什么（见 store/persistence.ts 的 DEFAULT_CAPABILITIES）。
   *
   * 存在的理由：没有它时，"以为有乐观并发保护、其实没有"是最危险的状态——
   * `file` 后端只能保证**同进程**，两个进程写同一目录不会被拦住。
   */
  persistenceCapabilities(): Record<string, unknown> {
    const store = this.persistenceStore;
    const candidate = store as { capabilities?: () => Record<string, unknown> } | null;
    const reported = candidate !== null && typeof candidate.capabilities === 'function' ? candidate.capabilities() : null;
    // 默认值就是"什么都不保证"：自定义适配器不实现 capabilities() 时不会让人误以为有保护
    return { conditionalAppend: false, batchAppend: false, ...(reported || {}) };
  }

  /** Connect to a peer node and get a handle that hands out remote ActorRefs. */
  async connect(options: Record<string, unknown> = {}): Promise<unknown> {
    if (!options.host || options.port === undefined) {
      throw new TypeError('connect({ host, port }) is required');
    }
    const key = `${options.host}:${options.port}`;
    const existing = this.peers.get(key);
    if (existing) return existing;

    /**
     * 审计 F7：`peers` 过去只有 `stop()` 一条清理路径，而集群会用**入站帧里的 sender 地址**
     * 调 `connect()`（`cluster/remote.ts`）——对端每次换地址，本节点就多一个永不释放的
     * Peer+Gateway，并主动向该地址发起连接。这里给一个界：满了就**明确拒绝**（可见），
     * 而不是无声增长。
     */
    if (this.peers.size >= this.maxPeers) {
      this._log('peer_limit_reached', { limit: this.maxPeers, key });
      throw new Error(
        `peer limit reached (${this.maxPeers}); refusing to add ${key}. ` +
          'Raise maxPeers if this is legitimate fan-out.',
      );
    }

    const peer = new Peer({
      system: this,
      host: options.host,
      port: options.port,
      nodeId: options.nodeId,
      tls: options.tls || this.tls,
    });
    // Learning the peer's id is best effort: a node may not answer yet.
    await peer.handshake(options.timeoutMs || 3000).catch(() => null);
    this.peers.set(key, peer);
    this.emit('peer_connected', key, peer.nodeId);
    return peer;
  }

  /**
   * Shortcut for `"actorPath@host:port"` (or a bare path when exactly one peer
   * is connected), so call sites stay close to local code.
   * @returns {import('./remote').RemoteRef}
   */
  remote(spec: string): unknown {
    const text = String(spec);
    const at = text.lastIndexOf('@');
    if (at < 0) {
      const only = [...this.peers.values()][0];
      if (this.peers.size === 1 && only !== undefined) return only.ref(text);
      throw new ActorNotFoundError(
        `remote("${spec}") needs "path@host:port" when ${this.peers.size} peers are connected`,
      );
    }
    const path = text.slice(0, at);
    const target = text.slice(at + 1);
    const peer = this.peers.get(target) ?? [...this.peers.values()].find((candidate) => candidate.nodeId === target);
    if (peer === undefined) throw new ActorNotFoundError(`no peer "${target}" is connected; call connect() first`);
    return peer.ref(path);
  }

  /** Connected peers, for introspection. */
  listPeers(): { key: string; nodeId: string }[] {
    return [...this.peers.values()].map((peer) => ({ key: `${peer.host}:${peer.port}`, nodeId: peer.nodeId }));
  }

  // --- system-level supervision -------------------------------------------

  async _onRootCrash(cell: CellLike, reason: unknown): Promise<void> {
    const decision = this.rootSupervisor.decide(cell.id, this.clock.now());
    if (decision.action === 'escalate') {
      await this._onEscalation(cell, reason);
      return;
    }
    if (decision.action !== 'restart') return;
    for (const id of decision.targets) {
      const target = this.cells.get(id);
      if (!target) continue;
      try {
        await target._restart(reason);
      } catch (err) {
        await this._onRootCrash(target, err);
      }
    }
  }

  /**
   * A top-level actor (or its subtree) exhausted its restart intensity. There
   * is no parent left to escalate to, so the system reports the failure, stops
   * everything and emits `system_failure` — a silent give-up would hide a
   * permanent fault.
   */
  async _onEscalation(cell: CellLike, reason: unknown): Promise<void> {    const error = reason instanceof EscalationError
      ? reason
      : new EscalationError(`actor ${cell ? cell.path : '(unknown)'} failed and could not be restarted`, {
        cause: reason,
      });
    this._log('system_failure', { path: cell && cell.path, err: error.message });
    this.emit('system_failure', error, cell && cell.ref);
    // Shut down asynchronously: this runs inside the failing actor's turn, and
    // awaiting its own stop here would deadlock (the stop envelope can only be
    // processed once the current turn returns).
    setImmediate(() => {
      this.stop().catch((err) => this._log('system_stop_failed', { err: err.message }));
    });
  }

  // --- bookkeeping ---------------------------------------------------------

  _register(cell: CellLike): void {
    // Paths are the unique address; a parent's local id is not globally unique,
    // so only paths are indexed (resolve() still accepts an unambiguous id).
    this.cells.set(cell.path, cell);
    this.emit('actor_registered', cell.ref);
  }

  /**
   * 丢弃一个从未成功启动的 cell（审计 F6）。
   *
   * 与 `_unregister` 的区别：这里还要把半初始化的实例置空（它的 `receive` 仍可被调用），
   * 并把 id 从根监督者里摘掉，这样 id 可以被重新使用、`listActors()` 也不会报出一个不存在的 Actor。
   */
  _abandon(cell: CellLike): void {
    cell.instance = null;
    cell.stopped = true;
    this.rootSupervisor.remove(cell.id);
    this._unregister(cell);
  }

  _unregister(cell: CellLike): void {
    if (this.cells.get(cell.path) === cell) this.cells.delete(cell.path);
    this.emit('actor_stopped', cell.path);
  }

  _onMailboxRejected(cell: CellLike, envelope: EnvelopeLike): void {
    this.emit('mailbox_full', cell.ref, envelope.payload);
  }

  _deadLetter(cell: CellLike, envelope: EnvelopeLike, err: unknown): Promise<void> | void {
    const entry = {
      ts: this.clock.now(),
      path: cell.path,
      payload: envelope.payload,
      retryCount: envelope.retryCount ?? 0,
      error: err instanceof Error ? err.message : err === undefined ? undefined : String(err),
    };
    this.deadLetters.push(entry);
    if (this.deadLetters.length > this.maxDeadLetters) this.deadLetters.shift();

    // Durable dead letters (deadLetters plugin): the in-memory ring stays a
    // fast view, the store is the durable record.
    if (this.deadLetterStore) {
      Promise.resolve(
        this.deadLetterStore.enqueue({ actorId: cell.path, msg: envelope.payload, reason: entry.error, retryCount: entry.retryCount }),
      ).catch((storeErr: unknown) => this._log('dead_letter_persist_failed', { err: storeErr instanceof Error ? storeErr.message : String(storeErr) }));
    }
    this._log('dead_letter', entry);
    this.emit('dead_letter', entry);
  }

  /** Dead letters: from the durable store when one is installed, else memory. */
  async readDeadLetters(): Promise<unknown[]> {
    const readAll = this.deadLetterStore?.readAll;
    if (typeof readAll === 'function') return readAll.call(this.deadLetterStore);
    return [...this.deadLetters];
  }

  /** 清空死信（内存视图 + 落盘的那个），返回清掉的条数。 */
  async clearDeadLetters(): Promise<number> {
    const removed = this.deadLetters.length;
    this.deadLetters.length = 0;
    const clear = this.deadLetterStore?.clear;
    if (typeof clear === 'function') await clear.call(this.deadLetterStore);
    return removed;
  }

  _nextChildSeq(): number {
    this._seq += 1;
    return this._seq;
  }

  _log(event: string, meta?: Record<string, unknown>): void {
    if (this.logger) {
      try {
        this.logger(event, meta);
      } catch {
        /* a broken logger must never break an actor */
      }
    }
    this.emit('log', event, meta);
  }

  // --- shutdown ------------------------------------------------------------

  /** Stop every actor gracefully and wait for the scheduler to settle. */
  /**
   * 优雅停机。
   *
   * 审计 F12：`@actor/app` 的 `Application.stop({ timeoutMs })` 会传给这里，但本方法**不接受参数**，
   * 于是调用方请求 10s、实际用的是 `config.actor.shutdownTimeoutMs`（默认 2s）—— 静默降级正是
   * 这个仓库反复强调要避免的。现在接受并按"每个 Actor 的停机预算"应用它。
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : this.shutdownTimeoutMs;
    if (this.stopped) {
      await this.scheduler.drain();
      return;
    }
    this.stopped = true;
    // Snapshot who is mid-handler *before* stopping: a forced termination
    // unregisters the cell, so it would be invisible afterwards.
    const wasBusy = [...this.cells.values()].filter((cell) => cell.running).map((cell) => cell.path);
    const cells = [...this.cells.values()].filter((cell) => !cell.parent);
    await Promise.all(cells.map((cell) => cell.stop(timeoutMs).catch(() => {})));

    // Bounded: a handler that never resolves must not make shutdown hang.
    const drainResult = await this.scheduler.drain(timeoutMs);
    if (drainResult.timedOut || wasBusy.length > 0) {
      this._log('system_stop_timeout', {
        timeoutMs,
        timedOut: drainResult.timedOut,
        busyActors: wasBusy,
        hint: 'these actors were still inside a handler; shutdown continued anyway',
      });
    }
    this.scheduler.stop();

    // Close the transports last: actors may still have been exchanging
    // messages while they drained.
    const server = this.server;
    if (server !== null) {
      const close = server.close?.bind(server);
      if (close !== undefined) await close().catch(() => undefined);
      this.server = null;
    }
    for (const peer of this.peers.values()) await peer.close().catch(() => {});
    this.peers.clear();

    // Plugins tear down in reverse install order.
    const installed = [...this.installed.values()].reverse();
    for (const plugin of installed) {
      if (typeof plugin.teardown !== 'function') continue;
      try {
        // `await` also covers synchronous teardown functions.
        await plugin.teardown(this);
      } catch (err) {
        this._log('plugin_teardown_failed', { plugin: plugin.name, err: err instanceof Error ? err.message : String(err) });
      }
    }
    this.installed.clear();
    this.emit('stopped');
  }

  /** Statistics for dashboards/metrics. */
  stats(): Record<string, unknown> {
    let mailboxDepth = 0;
    let deadLettered = 0;
    for (const cell of this.cells.values()) {
      mailboxDepth += cell.mailbox.size;
      deadLettered += cell.counters.deadLettered ?? 0;
    }
    return {
      name: this.name,
      actors: this.cells.size,
      mailboxDepth,
      deadLettered,
      deadLetters: this.deadLetters.length,
      scheduled: this.scheduler.pending,
      ticks: this.scheduler.ticks,
      uptimeMs: this.clock.now() - this.startedAt,
      rootSupervisor: this.rootSupervisor.info(),
      plugins: [...this.installed.keys()],
      peers: this.peers.size,
    };
  }
}

/**
 * Create an actor system.
 * @param {{name?:string, logger?:Function|false, defaults?:object,
 *          persistence?:object|string, persistenceDir?:string,
 *          mailboxStore?:object, messagesPerTurn?:number, cellsPerTurn?:number}} [options]
 */
function createSystem(options = {}) {
  return new ActorSystem(options);
}

module.exports = { ActorSystem, createSystem, DEFAULT_ACTOR_OPTIONS };
