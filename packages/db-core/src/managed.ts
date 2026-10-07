import { createAppRequire, loadDriverModule, type DriverResolver } from './resolve.ts';
import { DbConfigError, DbUnavailableError } from './errors.ts';
import type { AdapterConnectInput, DatabaseAdapter, ManagedConnection } from './adapter.ts';
import type { BaseConnection, PoolOptions } from './pool.ts';

/**
 * 连接管控（设计见 docs/design/m7-multi-database.md §4.3）。
 *
 * 状态机：`idle → connecting → ready ⇄ degraded → draining → closed`（+ 连接失败回到 `idle`）。
 *
 * 四条纪律：
 *   1. 未就绪/已关闭时 `acquire()` **快速失败**（不排队等死）；
 *   2. 驱动自带重连 → 框架**只转发** `driver_event`，不自己重连；
 *   3. `stats` 如实（驱动没给池数字就不编造）；
 *   4. `close()` 幂等 + drain（等在途归零，超时则如实上报在途数）。
 */
export type SupervisorState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'draining' | 'closed';

export type SupervisionEvent =
  | { type: 'connecting'; kind: string }
  | { type: 'connected'; kind: string; durationMs: number }
  | { type: 'health_failed'; kind: string; error: string }
  | { type: 'driver_event'; kind: string; event: string; detail?: unknown }
  | { type: 'unavailable'; kind: string; reason: string }
  | { type: 'draining'; kind: string; inFlight: number }
  | { type: 'closed'; kind: string };

export interface SupervisionOptions<Conn extends BaseConnection = BaseConnection> {
  readonly connection: Conn;
  readonly pool?: PoolOptions;
  readonly logger?: (event: string, meta?: Record<string, unknown>) => void;
  readonly onEvent?: (event: SupervisionEvent) => void;
  /** 定时健康检查间隔；默认 0 = 不主动打扰（只在 `checkHealth()`/`acquire()` 时探活）。 */
  readonly healthCheckIntervalMs?: number;
  /** 可选空闲保活；驱动自带保活就别开（避免两套保活打架，纪律 2）。 */
  readonly keepAliveIntervalMs?: number;
  /** 停机 drain 超时（默认 10000ms）：等不到在途归零就强制关闭并如实上报。 */
  readonly drainTimeoutMs?: number;
  /** 驱动解析（默认从应用根解析）。测试/自定义布局可注入。 */
  readonly resolve?: DriverResolver;
}

export interface ManagedResourceStats {
  readonly state: SupervisorState;
  readonly inFlight: number;
  /** 驱动自报的统计；驱动没给就是 null（**不编造**，纪律 3）。 */
  readonly driver: Record<string, unknown> | null;
  /** 最近一次健康检查失败的原因（修复后清空）。 */
  readonly lastHealthError: string | null;
}

export interface ManagedResource<C = unknown> {
  readonly kind: string;
  readonly state: SupervisorState;
  connect(): Promise<void>;
  /** 取客户端；未就绪时抛 `DbUnavailableError`（快速失败）。 */
  acquire(): Promise<C>;
  /** 背景**保活**（`keepAlive()`）。 */
  keepAlive(): Promise<void>;
  checkHealth(): Promise<void>;
  /** 把一个在途工作登记进来：`close()` 会等它结束（drain）。 */
  track<R>(work: Promise<R>): Promise<R>;
  stats(): ManagedResourceStats;
  close(): Promise<void>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/** 把一个适配器变成**受管资源**。 */
export function supervise<C = unknown, Conn extends BaseConnection = BaseConnection>(
  adapter: DatabaseAdapter<C, Conn>,
  options: SupervisionOptions<Conn>,
): ManagedResource<C> {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const resolve = options.resolve ?? createAppRequire();

  let state: SupervisorState = 'idle';
  let connection: ManagedConnection<C> | null = null;
  let lastHealthError: string | null = null;
  let inFlight = 0;
  const idleWaiters: Array<() => void> = [];
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const emit = (event: SupervisionEvent): void => {
    options.onEvent?.(event);
  };
  const log = (event: string, meta?: Record<string, unknown>): void => {
    options.logger?.(event, meta);
  };

  const stopTimers = (): void => {
    if (healthTimer !== null) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };

  const settleIdle = (): void => {
    if (inFlight > 0) return;
    const waiters = idleWaiters.splice(0, idleWaiters.length);
    for (const waiter of waiters) waiter();
  };

  const checkHealth = async (): Promise<void> => {
    const current = connection;
    if (current === null) {
      throw new DbUnavailableError(adapter.kind, state);
    }
    try {
      await current.healthCheck();
      if (lastHealthError !== null) {
        log('health_recovered', { kind: adapter.kind });
        lastHealthError = null;
        if (state === 'degraded') state = 'ready';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wasHealthy = lastHealthError === null;
      lastHealthError = message;
      if (state === 'ready' || state === 'degraded') state = 'degraded';
      // 只在"从健康变不健康"时发事件（避免抖动期刷屏）；原因始终可从 stats() 查到
      if (wasHealthy) {
        emit({ type: 'health_failed', kind: adapter.kind, error: message });
        log('health_failed', { kind: adapter.kind, error: message });
      }
      throw err;
    }
  };

  const resource: ManagedResource<C> = {
    kind: adapter.kind,
    get state() {
      return state;
    },

    async connect(): Promise<void> {
      if (state === 'ready' || state === 'degraded') return; // 幂等
      if (state === 'draining' || state === 'closed') {
        throw new DbUnavailableError(adapter.kind, state, 'resource was closed');
      }
      state = 'connecting';
      emit({ type: 'connecting', kind: adapter.kind });
      const started = Date.now();
      try {
        const input: AdapterConnectInput<Conn> = {
          connection: options.connection,
          pool: options.pool ?? {},
          ...(options.logger === undefined ? {} : { logger: options.logger }),
          load: <T>(specifier: string, packageName?: string): T =>
            loadDriverModule<T>(specifier, adapter.kind, packageName ?? adapter.driverPackage, resolve),
          emitDriverEvent: (event: string, detail?: unknown) => {
            emit({ type: 'driver_event', kind: adapter.kind, event, ...(detail === undefined ? {} : { detail }) });
          },
        };
        connection = await adapter.connect(input);
        state = 'ready';
        const durationMs = Date.now() - started;
        emit({ type: 'connected', kind: adapter.kind, durationMs });
        log('connected', { kind: adapter.kind, durationMs });

        // 定时健康检查 / 保活（可选；驱动自带重连的只转发事件，纪律 2）
        const healthInterval = options.healthCheckIntervalMs ?? 0;
        if (healthInterval > 0) {
          healthTimer = setInterval(() => {
            void checkHealth().catch(() => {
              /* 失败已在 checkHealth 里发事件 */
            });
          }, healthInterval);
          healthTimer.unref?.();
        }
        const keepAliveInterval = options.keepAliveIntervalMs ?? 0;
        if (keepAliveInterval > 0) {
          keepAliveTimer = setInterval(() => {
            void resource.keepAlive().catch(() => {
              /* 保活失败不致命：下次健康检查会如实反映 */
            });
          }, keepAliveInterval);
          keepAliveTimer.unref?.();
        }
      } catch (err) {
        state = 'idle'; // 不假装 ready
        connection = null;
        stopTimers();
        throw err;
      }
    },

    async acquire(): Promise<C> {
      if (state !== 'ready' && state !== 'degraded') {
        throw new DbUnavailableError(adapter.kind, state, 'resource is not connected');
      }
      const current = connection;
      if (current === null) throw new DbUnavailableError(adapter.kind, state, 'resource is not connected');
      return current.client;
    },

    async keepAlive(): Promise<void> {
      await connection?.keepAlive?.();
    },

    checkHealth,

    async track<R>(work: Promise<R>): Promise<R> {
      inFlight += 1;
      try {
        return await work;
      } finally {
        inFlight -= 1;
        settleIdle();
      }
    },

    stats(): ManagedResourceStats {
      return {
        state,
        inFlight,
        driver: connection?.stats?.() ?? null,
        lastHealthError,
      };
    },

    async close(): Promise<void> {
      if (state === 'closed' || state === 'draining') return; // 幂等
      const current = connection;
      if (current === null) {
        state = 'closed';
        emit({ type: 'closed', kind: adapter.kind });
        return;
      }
      state = 'draining';
      stopTimers();
      emit({ type: 'draining', kind: adapter.kind, inFlight });
      log('draining', { kind: adapter.kind, inFlight });

      if (inFlight > 0) {
        await new Promise<void>((resolveIdle) => {
          idleWaiters.push(resolveIdle);
          const timer = setTimeout(() => {
            // 超时也如实上报：还有几个在途没结束
            log('drain_timeout', { kind: adapter.kind, inFlight });
            resolveIdle();
          }, drainTimeoutMs);
          timer.unref?.();
        });
      }

      try {
        await current.close();
      } finally {
        connection = null;
        state = 'closed';
        emit({ type: 'closed', kind: adapter.kind });
      }
    },
  };

  void DbConfigError; // 保留导入以便后续校验扩展（当前由 defineDatabaseAdapter 负责）
  return resource;
}
