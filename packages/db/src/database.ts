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
import { checkDrift, inspectTable, syncModels, type DriftReport, type SyncReport, type SyncOptions, type TableInfo } from './schema.ts';
import type { Model } from './model.ts';
import { createRepository, type Repository, type RepositoryOptions } from './repository.ts';

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
  /**
   * schema 自动迁移开关。
   *
   * 默认 `auto: false`：`sync()` 只建表、**不改表**；发现漂移就抛错。
   * `auto: true` 时只做**安全**操作（加可空列 / 有默认值的列 / 建索引），
   * 删列、改类型、加 NOT NULL 无默认值的列一律拒绝并说明原因。
   */
  migrations?: {
    auto?: boolean;
    /**
     * 注释策略（默认 `create`）：只在建表时写注释；已存在的表**不会**被自动更新，
     * 想每次同步就显式写 `'always'`。
     */
    comments?: import('./schema.ts').CommentMode;
  };
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
  /** 按 model 建表/建索引（`migrations.auto` 时才做安全加列）；漂移且不允许改时抛 `DbSchemaDriftError`。 */
  sync(models: readonly Model[] | Model, options?: SyncOptions): Promise<SyncReport>;
  /** 读一张表的实况（表不存在时 `exists: false`）。 */
  inspectTable(table: string): Promise<TableInfo>;
  /** 只比不改：model 与库里实况的差异。 */
  checkDrift(model: Model): Promise<DriftReport>;
  /** 已注册的 model（`sync()` 会自动注册；关联解析也用它）。 */
  models(): ReadonlyMap<string, Model>;
  /** 取一个 model 的仓储（ORM 映射层：实体 ↔ 行、乐观锁、关联）。 */
  repository<M extends Model>(
    model: M,
    options?: { models?: readonly Model[]; generateId?: () => string },
  ): Repository<M>;
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
  /** model 注册表：`sync()` 会注册，`repository()` 与关联解析用它。 */
  const registry = new Map<string, Model>();

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

    async sync(models: readonly Model[] | Model, syncOptions: SyncOptions = {}): Promise<SyncReport> {
      const list = Array.isArray(models) ? models : [models as Model];
      // 先注册：这样 sync 之后的 repository() 与关联解析都能按名字找到 model
      for (const model of list) registry.set(model.name, model);
      return syncModels(dialect, requirePool(), list, {
        auto: syncOptions.auto ?? options.migrations?.auto === true,
        ...(syncOptions.comments === undefined
          ? options.migrations?.comments === undefined
            ? {}
            : { comments: options.migrations.comments }
          : { comments: syncOptions.comments }),
        ...(syncOptions.logger === undefined ? (log === undefined ? {} : { logger: log }) : { logger: syncOptions.logger }),
      });
    },

    async inspectTable(table: string): Promise<TableInfo> {
      return inspectTable(dialect, requirePool(), table);
    },

    async checkDrift(model: Model): Promise<DriftReport> {
      const info = await inspectTable(dialect, requirePool(), model.table);
      return checkDrift(dialect, model, info);
    },

    models(): ReadonlyMap<string, Model> {
      return registry;
    },

    repository<M extends Model>(
      model: M,
      repositoryOptions: { models?: readonly Model[]; generateId?: () => string } = {},
    ): Repository<M> {
      for (const extra of repositoryOptions.models ?? []) registry.set(extra.name, extra);
      registry.set(model.name, model);
      /**
       * 惰性 runner：`db.repository(M)` 可以在 `connect()` 之前拿（拿的时候不查库），
       * 真发查询时才要求已连接（否则抛 DbNotConnectedError，而不是悄悄对着空池跑）。
       */
      const lazy: Runner = {
        all: (sql, params) => requirePool().all(sql, params),
        run: (sql, params) => requirePool().run(sql, params),
        insertReturning: (sql, params) => {
          const current = requirePool();
          if (typeof current.insertReturning !== 'function') {
            throw new DbConfigError(`driver ${driver.name} cannot read back generated ids (no insertReturning)`);
          }
          return current.insertReturning(sql, params);
        },
        transaction: (fn) => {
          const current = requirePool();
          if (typeof current.transaction !== 'function') throw new DbConfigError(`driver ${driver.name} does not support transactions`);
          return current.transaction(fn);
        },
      };
      const repoOptions: RepositoryOptions = {
        dialect,
        runner: lazy,
        models: registry,
        ...(repositoryOptions.generateId === undefined ? {} : { generateId: repositoryOptions.generateId }),
      };
      return createRepository(model, repoOptions);
    },
  };
  return api;
}

/** 便于诊断：方言默认端口（`doctor`/文档都用它，不写死两份）。 */
export function defaultPortFor(dialect: Dialect): number | null {
  return DEFAULT_PORTS[dialect];
}
