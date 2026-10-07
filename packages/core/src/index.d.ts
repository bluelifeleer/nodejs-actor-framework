/**
 * Type definitions for nodejs-actor-framework.
 *
 * The public surface is `index.js`: Actor, createSystem, ActorRef and the
 * adapters. Anything under lib/ is internal.
 */

// ---------------------------------------------------------------------------
// Messages, refs, context
// ---------------------------------------------------------------------------

export type ActorId = string;
export type ActorPath = string;

/** Anything that identifies a target actor: a ref, a path, or "path@host:port". */
export interface Tellable<M = unknown> {
  readonly id: string | null;
  readonly path: string | null;
  readonly isLocal?: boolean;
  tell(msg: M): boolean;
  ask(msg: M, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
}

export interface MailboxStats {
  size: number;
  maxSize: number;
  overflow: OverflowPolicy;
  dropped: number;
  rejected: number;
}

export interface ActorCounters {
  received: number;
  handled: number;
  failed: number;
  retries: number;
  deadLettered: number;
  crashed: number;
  restarted: number;
  recovered: number;
}

export interface SupervisorInfo {
  id: string;
  strategy: RestartStrategyName;
  children: string[];
  restartsInWindow: number;
  maxRestarts: number;
  withinSeconds: number;
  escalations: number;
}

export interface ActorInspection {
  id: string;
  path: string;
  definition: string;
  isolation: IsolationMode;
  worker: { pid: number | null } | null;
  started: boolean;
  stopped: boolean;
  restarts: number;
  mailbox: MailboxStats;
  counters: ActorCounters;
  /** Local actors only; worker-isolated actors report `stateLocation: 'worker'`. */
  state?: unknown;
  stateLocation?: 'worker';
  children: string[];
  supervision: SupervisorInfo;
  persistence: { mode: PersistenceMode; restored: boolean };
}

/** Reference to an actor (local or remote). Identical API either way. */
export interface ActorRef<M = unknown, R = unknown> {
  readonly id: string;
  readonly path: ActorPath;
  readonly isLocal: boolean;
  /** Fire and forget. Returns false when the mailbox refused the message. */
  tell(msg: M): boolean;
  /** Send and wait for the value returned by receive(). */
  ask(msg: M, timeoutMs?: number): Promise<R>;
  /** Graceful stop (runs postStop). */
  stop(): Promise<void>;
  /** Introspection; throws for remote actors. */
  inspect(): ActorInspection;
  /** Current state: a clone locally, fetched over the worker protocol if isolated. */
  state(): Promise<unknown>;
}

export interface ActorContext<S = unknown> {
  readonly self: ActorRef;
  /** The sender of the message being handled, or null when it came from outside. */
  readonly sender: Tellable | null;
  readonly system: ActorSystem;
  readonly id: ActorId;
  readonly path: ActorPath;
  readonly children: ActorId[];
  /** True when a snapshot or replayed events were applied (meaningful in postRecover). */
  readonly restored: boolean;
  spawn<M = unknown, R = unknown>(
    definition: ActorDefinitionInput<M, R> | string,
    options?: ActorOptions,
  ): Promise<ActorRef<M, R>>;
  tell<M>(target: Tellable<M> | string, msg: M): boolean;
  ask<M, R = unknown>(target: Tellable<M> | string, msg: M, timeoutMs?: number): Promise<R>;
  stop(target?: Tellable | string): Promise<void>;
  stopSelf(): Promise<void>;
  /** Append a domain event (persistence: 'events'). */
  persist(event: unknown): Promise<unknown>;
  /** Store the current state (persistence: 'snapshot'). */
  saveSnapshot(): Promise<S | undefined>;
  log(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Defining actors
// ---------------------------------------------------------------------------

export type IsolationMode = 'inline' | 'worker';
export type FailureMode = 'crash' | 'retry';
export type PersistenceMode = 'none' | 'snapshot' | 'events' | 'mailbox';
export type OverflowPolicy = 'reject' | 'drop-oldest' | 'drop-newest';
export type RestartStrategyName = 'one_for_one' | 'rest_for_one' | 'one_for_all';

export interface ActorOptions {
  id?: ActorId;
  isolation?: IsolationMode;
  /** Only for `isolation: 'worker'`: which export of the module is the actor. */
  exportName?: string;
  mailbox?: { maxSize?: number; overflow?: OverflowPolicy };
  supervision?: { strategy?: RestartStrategyName; maxRestarts?: number; withinSeconds?: number };
  failure?: FailureMode;
  maxRetry?: number;
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  persistence?: PersistenceMode | PersistenceSpec;
  askTimeoutMs?: number;
  /** Stop children when this actor stops (default true). */
  stopChildrenOnStop?: boolean;
}

export interface PersistenceSpec {
  mode: PersistenceMode;
  store?: PersistenceAdapter;
  mailboxStore?: MailboxStore;
  onStop?: boolean;
}

/** Base class for user actors. */
export abstract class Actor<M = unknown, R = unknown, S = any> {
  state: S;
  id: ActorId | null;
  path: ActorPath | null;
  /** Runs before recovery: establish initial state here. */
  preStart(ctx: ActorContext<S>): void | Promise<void>;
  /** Runs after a snapshot or replayed events were applied. */
  postRecover(ctx: ActorContext<S>): void | Promise<void>;
  /** Handle one message. Return a value to answer an ask(). */
  abstract receive(msg: M, ctx: ActorContext<S>): R | Promise<R>;
  postStop(ctx: ActorContext<S>): void | Promise<void>;
  preRestart(reason: Error, msg: M | null, ctx: ActorContext<S>): void | Promise<void>;
  /** Apply a persisted event to this.state (persistence: 'events'). */
  applyEvent(event: unknown): void;
}

/** Handler-bag form: `onMessage`/`receive`, `onStart`/`preStart`, ... */
export interface HandlerActorShape<M = unknown, R = unknown, S = any> {
  state?: S | (() => S);
  preStart?: (this: Actor<M, R, S>, ctx: ActorContext<S>) => void | Promise<void>;
  onStart?: (this: Actor<M, R, S>, ctx: ActorContext<S>) => void | Promise<void>;
  receive?: (this: Actor<M, R, S>, msg: M, ctx: ActorContext<S>) => R | Promise<R>;
  onMessage?: (this: Actor<M, R, S>, msg: M, ctx: ActorContext<S>) => R | Promise<R>;
  postStop?: (this: Actor<M, R, S>, ctx: ActorContext<S>) => void | Promise<void>;
  onStop?: (this: Actor<M, R, S>, ctx: ActorContext<S>) => void | Promise<void>;
  postRecover?: (this: Actor<M, R, S>, ctx: ActorContext<S>) => void | Promise<void>;
  preRestart?: (this: Actor<M, R, S>, reason: Error, msg: M | null, ctx: ActorContext<S>) => void | Promise<void>;
  applyEvent?: (this: Actor<M, R, S>, event: unknown) => void;
}

export type MessageHandler<M = unknown, R = unknown> = (
  msg: M,
  ctx: ActorContext,
) => R | Promise<R>;

export type ActorDefinitionInput<M = unknown, R = unknown, S = any> =
  | (new () => Actor<M, R, S>)
  | MessageHandler<M, R>
  | HandlerActorShape<M, R, S>;

export interface ActorDefinition<M = unknown, R = unknown, S = any> {
  readonly name: string;
  readonly kind: 'class' | 'handler' | 'instance' | 'worker';
  readonly options: ActorOptions;
  readonly modulePath: string | null;
  readonly exportName: string;
  create(): Actor<M, R, S>;
}

export function defineActor<M = unknown, R = unknown, S = any>(
  input: ActorDefinitionInput<M, R, S> | Actor<M, R, S>,
  defaults?: ActorOptions,
): ActorDefinition<M, R, S>;

// ---------------------------------------------------------------------------
// Persistence adapters
// ---------------------------------------------------------------------------

export interface PersistenceCapabilities {
  conditionalAppend: 'atomic' | 'in-process' | false;
  batchAppend: 'atomic' | 'in-process' | false;
}

export interface PersistenceAdapter {
  /**
   * What this backend can actually guarantee. Both fields are three-valued:
   * `'atomic'` (safe across processes) / `'in-process'` (this process only) / `false`.
   * Read it before assuming a conditional write protects you from another process.
   */
  capabilities?(): PersistenceCapabilities;
  loadSnapshot(id: ActorPath): Promise<unknown>;
  saveSnapshot(id: ActorPath, state: unknown): Promise<void>;
  deleteSnapshot(id: ActorPath): Promise<unknown>;
  appendEvent(id: ActorPath, event: unknown): Promise<void>;
  loadEvents(id: ActorPath): Promise<unknown[]>;
  deleteEvents(id: ActorPath): Promise<unknown>;
}

/** Durable mailbox backend (see message-store.js). */
export interface MailboxStore {
  append(actorId: string, msg: unknown): Promise<{ __msgId: string }>;
  ack(actorId: string, msgIds: string | string[]): Promise<number>;
  load(actorId: string): Promise<Array<Record<string, unknown>>>;
  clear(actorId: string): Promise<void>;
  pendingCount(actorId: string): Promise<number>;
}

export class MemoryPersistence implements PersistenceAdapter {
  constructor();
  loadSnapshot(id: ActorPath): Promise<unknown>;
  saveSnapshot(id: ActorPath, state: unknown): Promise<void>;
  deleteSnapshot(id: ActorPath): Promise<unknown>;
  appendEvent(id: ActorPath, event: unknown): Promise<void>;
  loadEvents(id: ActorPath): Promise<unknown[]>;
  deleteEvents(id: ActorPath): Promise<unknown>;
}

export class FilePersistence implements PersistenceAdapter {
  constructor(options?: { baseDir?: string; deferDirs?: boolean });
  readonly baseDir: string;
  loadSnapshot(id: ActorPath): Promise<unknown>;
  saveSnapshot(id: ActorPath, state: unknown): Promise<void>;
  deleteSnapshot(id: ActorPath): Promise<unknown>;
  appendEvent(id: ActorPath, event: unknown): Promise<void>;
  loadEvents(id: ActorPath): Promise<unknown[]>;
  deleteEvents(id: ActorPath): Promise<unknown>;
  stats(): Promise<{ backend: 'file'; baseDir: string; snapshots: number; eventLogs: number }>;
}

// ---------------------------------------------------------------------------
// Remote nodes
// ---------------------------------------------------------------------------

export interface RemoteRef<M = unknown, R = unknown> extends ActorRef<M, R> {
  readonly isLocal: false;
  readonly peer: Peer;
}

export interface Peer {
  readonly host: string;
  readonly port: number;
  readonly nodeId: string | null;
  describe(): string;
  ref<M = unknown, R = unknown>(path: ActorPath): RemoteRef<M, R>;
  tell(path: ActorPath, msg: unknown): boolean;
  ask<R = unknown>(path: ActorPath, msg: unknown, timeoutMs?: number): Promise<R>;
  stop(path: ActorPath): Promise<boolean>;
  ping(): Promise<boolean>;
  handshake(timeoutMs?: number): Promise<string | null>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export interface SystemOptions {
  name?: string;
  /** A log sink, or false to disable logging. */
  logger?: ((event: string, meta?: Record<string, unknown>) => void) | false | null;
  defaults?: ActorOptions;
  /** A persistence adapter instance, or `{ dir }` / `{ backend: 'memory' }`. */
  persistence?: PersistenceAdapter | { dir?: string; backend?: 'memory' };
  persistenceDir?: string;
  mailboxStore?: MailboxStore;
  /** Optional capabilities: see the plugin factories. */
  plugins?: Plugin[];
  messagesPerTurn?: number;
  cellsPerTurn?: number;
  /** How long a graceful actor stop may take before it is forced (default 2000ms). */
  shutdownTimeoutMs?: number;
  maxDeadLetters?: number;
  /**
   * Injectable clock (defaults to the real one). Tests pass a virtual clock
   * (`@actor/testkit` 的 `createVirtualClock().clock`) so timeouts, rate limits and
   * `ctx.sleep()` can be advanced instantly and deterministically.
   */
  clock?: Clock;
  /** Span sink: receives one span per handled message. Without it no spans are created. */
  spanSink?: SpanSink;
  /** 对等体数量上限（审计 F7），默认 128。 */
  maxPeers?: number;
}

export interface DeadLetter {
  ts: number;
  path: ActorPath;
  payload: unknown;
  retryCount: number;
  error?: string;
}

export interface SystemStats {
  name: string;
  actors: number;
  mailboxDepth: number;
  deadLettered: number;
  deadLetters: number;
  scheduled: number;
  ticks: number;
  uptimeMs: number;
  rootSupervisor: SupervisorInfo;
}

export interface PeerSummary {
  key: string;
  nodeId: string | null;
}

export interface ListenOptions {
  host?: string;
  port?: number;
  nodeId?: string;
  tls?: unknown;
  codec?: string;
}

export interface ConnectOptions {
  host: string;
  port: number;
  nodeId?: string;
  tls?: unknown;
  timeoutMs?: number;
}

export class ActorSystem {
  constructor(options?: SystemOptions);
  readonly name: string;
  readonly stopped: boolean;
  readonly size: number;
  readonly port: number | null;
  readonly deadLetters: DeadLetter[];
  readonly rootSupervisor: unknown;

  spawn<M = unknown, R = unknown, S = any>(
    definition: ActorDefinitionInput<M, R, S> | string,
    options?: ActorOptions,
  ): Promise<ActorRef<M, R>>;
  start<M = unknown, R = unknown, S = any>(
    definition: ActorDefinitionInput<M, R, S> | string,
    options?: ActorOptions,
  ): Promise<ActorRef<M, R>>;

  resolve(idOrPath: string): ActorRef | null;
  ref<M = unknown, R = unknown>(idOrPath: string): ActorRef<M, R>;
  inspect(idOrPath: string): ActorInspection;
  listActors(): ActorPath[];

  /** Serve this node's actors to peers; resolves to the bound port. */
  /** Install plugins; called automatically by spawn()/listen(). */
  init(): Promise<void>;
  /** The installed plugin with that name. */
  plugin(name: string): Plugin | null;
  /** Attached by the corresponding plugin, when installed. */
  cluster: ClusterService | null;
  pubsub: PubSubService | null;
  metrics: unknown;
  metricsExporter: MetricsExporterHandle | null;
  tracer: unknown;
  rateLimitPolicy: { capacity: number; rate: number } | null;
  deadLetterStore: unknown;
  readonly installed: Map<string, Plugin>;
  readDeadLetters(): Promise<unknown[]>;
  clearDeadLetters(): Promise<void>;

  listen(options?: ListenOptions): Promise<number>;
  connect(options: ConnectOptions): Promise<Peer>;
  /** `remote('path@host:port')`, or a bare path when exactly one peer is connected. */
  remote<M = unknown, R = unknown>(spec: string): RemoteRef<M, R>;
  listPeers(): PeerSummary[];

  stats(): SystemStats;
  stop(): Promise<void>;

  on(event: 'actor_registered' | 'actor_started' | 'actor_stopped', listener: (ref: ActorRef) => void): this;
  on(event: 'system_failure', listener: (error: Error, ref?: ActorRef) => void): this;
  on(event: 'dead_letter', listener: (entry: DeadLetter) => void): this;
  on(event: 'mailbox_full', listener: (ref: ActorRef, payload: unknown) => void): this;
  on(event: 'log', listener: (event: string, meta?: Record<string, unknown>) => void): this;
  on(event: 'peer_connected', listener: (key: string, nodeId: string | null) => void): this;
  on(event: 'listening' | 'stopped', listener: (value?: number) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export function createSystem(options?: SystemOptions): ActorSystem;

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface Plugin {
  readonly name: string;
  setup?(system: ActorSystem): void | Promise<void>;
  teardown?(system: ActorSystem): void | Promise<void>;
}

export interface ClusterOptions {
  nodeId?: string;
  host?: string;
  port?: number;
  advertiseHost?: string;
  seeds?: Array<string | { host: string; port: number }>;
  intervalMs?: number;
  peerTimeoutMs?: number;
  tls?: unknown;
  codec?: string;
  /** Port to advertise when the gateway is not (yet) listening. */
  gatewayPort?: number;
}

/** A remote actor found through gossip; the connection is made on first use. */
export interface DiscoveredRef<M = unknown, R = unknown> extends ActorRef<M, R> {
  readonly isLocal: false;
  readonly host: string;
  readonly gatewayPort: number;
  readonly nodeId: string | null;
}

export interface ClusterService {
  readonly gossip: unknown;
  readonly port: number;
  peers(): Array<{ host: string; port: number; lastSeen: number; failures: number }>;
  nodes(): string[];
  lookup(path: string): { host: string; gatewayPort: number; nodeId: string } | null;
  remoteActors(): string[];
  resolveRemote<M = unknown, R = unknown>(path: string): DiscoveredRef<M, R> | null;
  waitFor(path: string, timeoutMs?: number): Promise<{ host: string; gatewayPort: number; nodeId: string }>;
}

export interface PubSubService {
  subscribe(topic: string, target: string | ActorRef): boolean;
  unsubscribe(topic: string, target: string | ActorRef): boolean;
  topics(): string[];
  subscribers(topic: string): string[];
  localSubscriptions(): Record<string, string[]>;
  publish(topic: string, msg: unknown): Promise<Array<{ path: string; ok: boolean; err?: string }>>;
}

export interface MetricsExporterHandle {
  readonly boundPort: number;
  close(): Promise<void>;
}

export interface MetricsPluginOptions {
  metrics?: unknown;
  logDir?: string;
  intervalMs?: number;
  storeBackend?: string;
  exporter?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    path?: string;
    maxPerActorSeries?: number;
  };
}

export interface DeadLettersPluginOptions {
  store?: MailboxStore | unknown;
  path?: string;
  baseDir?: string;
  maxEntries?: number;
}

export function cluster(options?: ClusterOptions): Plugin;
export function pubsub(options?: { nodeId?: string }): Plugin;
export function metrics(options?: MetricsPluginOptions): Plugin;
export function tracing(options?: { sampleRate?: number }): Plugin;
export function deadLetters(options?: DeadLettersPluginOptions): Plugin;
export function rateLimit(options?: { capacity?: number; rate?: number; ratePerSec?: number }): Plugin;

export function otlp(options?: OtlpOptions): OtlpExporter;

export const plugins: {
  cluster: typeof cluster;
  pubsub: typeof pubsub;
  metrics: typeof metrics;
  tracing: typeof tracing;
  deadLetters: typeof deadLetters;
  rateLimit: typeof rateLimit;
  /** OTLP/HTTP JSON export (zero dependency): POST <endpoint>/v1/traces. */
  otlp: typeof otlp;
};

// ---------------------------------------------------------------------------
// Enums and errors
// ---------------------------------------------------------------------------

export const RestartStrategy: {
  readonly ONE_FOR_ONE: 'one_for_one';
  readonly REST_FOR_ONE: 'rest_for_one';
  readonly ONE_FOR_ALL: 'one_for_all';
};

export const Overflow: {
  readonly REJECT: 'reject';
  readonly DROP_OLDEST: 'drop-oldest';
  readonly DROP_NEWEST: 'drop-newest';
};

export class ActorFrameworkError extends Error {}
export class DefinitionError extends ActorFrameworkError {}
export class MailboxFullError extends ActorFrameworkError {}
export class AskTimeoutError extends ActorFrameworkError {}
export class ActorStoppedError extends ActorFrameworkError {}
export class ActorNotFoundError extends ActorFrameworkError {}
export class PersistenceError extends ActorFrameworkError {}
export class EscalationError extends ActorFrameworkError {}

/** A non-replyable placeholder sender. */
export interface DeadLetterRef extends Tellable { readonly id: null; readonly path: null; }

// ---------------------------------------------------------------------------
// Injectable clock (M5): timeouts, rate limits and sleeps go through this seam
// ---------------------------------------------------------------------------

export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  /** Current time in milliseconds — use this instead of `Date.now()` in logic. */
  now(): number;
  setTimeout(callback: () => void, ms: number, options?: { unref?: boolean }): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
  setInterval(callback: () => void, ms: number, options?: { unref?: boolean }): TimerHandle;
  clearInterval(handle: TimerHandle | null | undefined): void;
}

/** The default clock: wraps the global timers. */
export function createRealClock(): Clock;

// ---------------------------------------------------------------------------
// Spans and OTLP export (M5)
// ---------------------------------------------------------------------------

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sampled: boolean;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
}

export interface SpanSink {
  onSpan(span: Span): void;
}

export interface OtlpOptions {
  /** Collector base URL (the exporter POSTs to `<endpoint>/v1/traces`). */
  endpoint?: string;
  serviceName?: string;
  headers?: Record<string, string>;
  resource?: Record<string, string>;
  /** Flush when this many spans are buffered (default 512). */
  maxBatch?: number;
  /** Periodic flush interval in ms (default 5000; 0 disables). */
  flushIntervalMs?: number;
  /** Custom fetch, for tests. */
  fetch?: typeof fetch;
}

export interface OtlpExporter extends Plugin {
  /** Send whatever is buffered now. */
  flush(): Promise<{ sent: number; error?: string }>;
  /** Export counters — failures are visible here, never silent. */
  stats(): { exported: number; failed: number; batches: number; dropped: number; lastError: string | null; buffered: number };
  readonly endpoint: string;
}

// ---------------------------------------------------------------------------
// Log adapter (M5): bridge pino/winston/console to the `(event, meta)` seam
// ---------------------------------------------------------------------------

export interface LogTarget {
  debug?(line: string): void;
  info?(line: string): void;
  warn?(line: string): void;
  error?(line: string): void;
}

export function createLogAdapter(
  target: LogTarget,
  options?: {
    level?: (event: string, meta?: unknown) => 'debug' | 'info' | 'warn' | 'error';
    message?: (event: string, meta?: unknown) => string;
  },
): (event: string, meta?: unknown) => void;

// ---------------------------------------------------------------------------
// Cluster governance primitives (M4): ring + ownership guard
// ---------------------------------------------------------------------------

export interface RingToken {
  token: number;
  nodeId: string;
}

export interface Ring {
  virtualNodes: number;
  tokens: readonly RingToken[];
}

export const ring: {
  readonly DEFAULT_VIRTUAL_NODES: number;
  /** Stable 32-bit hash (sha1 前 4 字节). */
  hash32(value: unknown): number;
  /** Build a ring from a **set** of node ids (order and duplicates do not matter). */
  createRing(members: readonly string[], options?: { virtualNodes?: number }): Ring;
  /** First member clockwise from the key（空环返回 null）。 */
  ownerOf(ring: Ring, key: string): string | null;
  /** Which shard an actor path belongs to（对路径哈希：同一实体永远同一个 shard）。 */
  shardOf(actorPath: string, shardCount: number): number;
  ownerOfShard(ring: Ring, shard: number): string | null;
  shardOwners(ring: Ring, shardCount: number): (string | null)[];
  /** Shards whose owner changed between two rings. */
  changedShards(before: Ring, after: Ring, shardCount: number): number[];
  /** Fraction of shards that changed owner (0..1). */
  migrationRatio(before: Ring, after: Ring, shardCount: number): number;
  moduloOwners(members: readonly string[], shardCount: number): (string | null)[];
  moduloMigrationRatio(before: readonly string[], after: readonly string[], shardCount: number): number;
};

export interface ShardClaim {
  shard: number;
  ownerNodeId: string;
  epoch: number;
  at: number;
}

export interface OwnershipGuard {
  readonly nodeId: string;
  readonly shardCount: number;
  updateRing(members: readonly string[]): Ring;
  ring(): Ring | null;
  ownerOf(shard: number): string | null;
  ownsShard(shard: number): boolean;
  /** 本节点对某 shard 的声明；只有它确实是 owner 时才给出（不自封）。 */
  claimFor(shard: number): ShardClaim | null;
  /** 学习一条声明：更高 epoch 换代；同 epoch 换人 = 双主声明，拒绝。 */
  observe(claim: ShardClaim): { accepted: boolean; reason?: string; learned?: ShardClaim };
  /** 接收端判决（见 docs/design/m4-cluster-governance.md §3.3）。 */
  verify(incoming: { shard: number; ownerNodeId: string; epoch: number }): { ok: boolean; reason?: string };
  isMember(nodeId: string): boolean;
  bestClaim(shard: number): ShardClaim | null;
  claims(): ShardClaim[];
  stats(): { nodeId: string; shards: number; owned: number; claims: number };
}

export const ownership: {
  createOwnershipGuard(options: { nodeId: string; shardCount: number; virtualNodes?: number; now?: () => number }): OwnershipGuard;
};

// ---------------------------------------------------------------------------
// Internals that are exported for tooling/tests
// ---------------------------------------------------------------------------

export class Mailbox<E = unknown> {
  constructor(options?: { maxSize?: number; overflow?: 'reject' | 'drop-oldest' | 'drop-newest' });
  readonly maxSize: number;
  readonly size: number;
  push(envelope: E, opts?: { priority?: number }): boolean;
  shift(): E | undefined;
  pushFront(envelope: E): void;
  drain(): E[];
  clear(): void;
}

export class ChildSupervisor {
  constructor(options: { id: string; strategy?: string; maxRestarts?: number; withinSeconds?: number });
  add(childId: string): void;
  remove(childId: string): void;
  has(childId: string): boolean;
  decide(crashedId: string, now?: number): { action: string; targets: string[] };
  info(): Record<string, unknown>;
}
