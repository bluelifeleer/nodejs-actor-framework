import {
  DbConfigError,
  DbConnectionError,
  DbError,
  DbNotConnectedError,
} from './errors.ts';
import {
  DEFAULT_PORTS,
  describeConnection,
  dialectFor,
  parseConnection,
  type Dialect,
  type NormalizedConnection,
} from './dialect.ts';
import { createMysqlDriver } from './drivers/mysql.ts';
import { createPgDriver } from './drivers/pg.ts';
import { createSqliteDriver } from './drivers/sqlite.ts';
import type { DriverFactory, DriverPool, PoolOptions, Row, Runner } from './drivers/types.ts';

export interface DatabaseOptions {
  /** 方言；不写时按 connection.url 推断，字段式则默认 `pgsql`。 */
  dialect?: Dialect;
  /** `{ url }` 或 `{ host, port, user, password, database }`（sqlite 用 `{ filename }`）。 */
  connection: ({ url: string } | Record<string, unknown>) & { dialect?: Dialect };
  /** 池参数（框架统一形状，驱动负责映射成真实字段）。 */
  pool?: PoolOptions;
  /** 注入驱动（测试/自定义连接实现）。不写则按方言懒加载用户安装的驱动。 */
  driver?: DriverFactory;
  /** 诊断日志接缝（与内核同形状：`(event, meta) => void`）。密码不会进日志。 */
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

/** 池参数的默认值（写在一处，文档与实现不会漂移）。 */
export const DEFAULT_POOL: Required<PoolOptions> = {
  min: 0,
  max: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
};

export interface HealthReport {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /** 便于测/日志：目标连接（**不含密码**）。 */
  target: string;
}

export interface Database {
  readonly dialect: Dialect;
  readonly connection: NormalizedConnection;
  readonly driverName: string;
  /** 建池 + 一次健康检查；失败即抛（不静默降级）。幂等。 */
  connect(): Promise<void>;
  /** 优雅关闭；幂等。关闭后 `healthCheck()` 返回 ok:false。 */
  close(): Promise<void>;
  healthCheck(): Promise<HealthReport>;
  /** 与 `@actor/data` 的 `SqlRunner` 结构兼容（`createSqlRepository({ runner: db.runner() })`）。 */
  runner(): Runner;
  /** 逃生通道：手写 SQL，仍然是**参数化**的。 */
  raw<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  rawRun(sql: string, params?: readonly unknown[]): Promise<number>;
  /** 池的只读统计（驱动不给就返回 null）。 */
  stats(): Record<string, unknown> | null;
}

function defaultDriverFor(dialect: Dialect): DriverFactory {
  switch (dialect) {
    case 'pgsql':
      return createPgDriver();
    case 'mysql':
      return createMysqlDriver();
    case 'sqlite':
      return createSqliteDriver();
    default:
      throw new DbConfigError(`no driver for dialect "${String(dialect)}"`);
  }
}

/**
 * 建一个数据库句柄（**此刻还不连接**）。
 *
 * 分工：用户给连接配置 + 装驱动；框架负责建池、探活、事务连接归还、优雅关闭。
 */
export function createDatabase(options: DatabaseOptions): Database {
  if (options === null || typeof options !== 'object' || options.connection === undefined) {
    throw new DbConfigError('createDatabase requires { connection }（DSN 或字段式都行）');
  }
  // 严格模式：不能把 undefined 塞进可选字段，所以条件构造
  const dialect = dialectFor({
    ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
    connection: options.connection as { url?: string },
  });
  const connection = parseConnection({
    ...(options.connection as Record<string, unknown>),
    ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
  });
  const poolOptions: PoolOptions = { ...DEFAULT_POOL, ...(options.pool ?? {}) };
  if (poolOptions.max !== undefined && poolOptions.min !== undefined && poolOptions.min > poolOptions.max) {
    throw new DbConfigError(`pool.min (${poolOptions.min}) cannot be greater than pool.max (${poolOptions.max})`);
  }
  const driver = options.driver ?? defaultDriverFor(dialect);
  const target = describeConnection(connection);
  const log = options.logger;

  let pool: DriverPool | null = null;
  let closed = false;
  let lastError: Error | null = null;
  let connected = false;

  const requirePool = (): DriverPool => {
    if (pool === null || !connected) throw new DbNotConnectedError(`database ${target}`);
    return pool;
  };

  const api: Database = {
    dialect,
    connection,
    driverName: driver.name,

    async connect(): Promise<void> {
      if (connected && pool !== null) return; // 幂等
      if (closed) throw new DbNotConnectedError(`database ${target} (already closed)`);
      try {
        pool = await driver.create(connection, poolOptions, dialect);
        await pool.healthCheck();
        connected = true;
        lastError = null;
        log?.('db_connected', { target, driver: driver.name, pool: poolOptions });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        // 驱动缺失等**配置类**错误原样抛（信息更具体）；其它包成连接错误
        connected = false;
        if (pool !== null) {
          await pool.close().catch(() => undefined);
          pool = null;
        }
        if (error instanceof DbError) throw error;
        throw new DbConnectionError(`cannot connect to ${target}: ${error.message}`, error);
      }
    },

    async close(): Promise<void> {
      closed = true;
      connected = false;
      const current = pool;
      pool = null;
      if (current !== null) {
        await current.close().catch((err: unknown) => {
          log?.('db_close_failed', { target, err: err instanceof Error ? err.message : String(err) });
        });
        log?.('db_closed', { target });
      }
    },

    async healthCheck(): Promise<HealthReport> {
      if (closed) return { ok: false, error: 'database is closed', target };
      if (pool === null || !connected) {
        const reason = lastError === null ? 'database is not connected' : lastError.message;
        return { ok: false, error: reason, target };
      }
      const startedAt = Date.now();
      try {
        await pool.healthCheck();
        return { ok: true, latencyMs: Date.now() - startedAt, target };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = new Error(message);
        return { ok: false, error: message, target };
      }
    },

    runner(): Runner {
      return {
        async all(sql, params) {
          return requirePool().all(sql, params);
        },
        async run(sql, params) {
          return requirePool().run(sql, params);
        },
        async transaction<R>(fn: (scoped: Runner) => Promise<R>): Promise<R> {
          const current = requirePool();
          if (typeof current.transaction !== 'function') {
            throw new DbConfigError(`driver ${driver.name} does not support transactions`);
          }
          return current.transaction(fn);
        },
      };
    },

    async raw<T = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return requirePool().all(sql, params) as Promise<T[]>;
    },

    async rawRun(sql: string, params: readonly unknown[] = []): Promise<number> {
      return requirePool().run(sql, params);
    },

    stats(): Record<string, unknown> | null {
      if (pool === null || typeof pool.stats !== 'function') return null;
      return pool.stats();
    },
  };
  return api;
}

/** 便于诊断：方言默认端口（`doctor`/文档都用它，不写死两份）。 */
export function defaultPortFor(dialect: Dialect): number | null {
  return DEFAULT_PORTS[dialect];
}
