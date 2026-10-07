import { loadDriverModule, type DriverResolver } from './resolve.ts';
import type { DriverFactory, DriverPool, Row, Runner } from './types.ts';

/** `pg` 的最小结构视图。 */
interface PgQueryResult {
  rows: Row[];
  rowCount: number | null;
}
interface PgClient {
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPool {
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}
interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool;
}

/**
 * 默认加载器：从**应用根**解析用户装的 `pg`（不是从 `@actor/db` 自己的 node_modules）。
 * 测试与自定义场景可以注入自己的解析器/模块，所以真实驱动不需要出现在本仓库的依赖里。
 */
const defaultLoader = async (resolve?: DriverResolver): Promise<PgModule> =>
  loadDriverModule<PgModule>('pg', 'pgsql', 'pg', resolve);

/**
 * PostgreSQL 驱动（**默认方言**）。
 *
 * 事务必须走 `pool.connect()` 拿到的**专用 client**：用 `pool.query` 发 BEGIN 会落到别的连接上，
 * 那样"数据库事务"就是假的（`@actor/data` 的 `SqlRunner` 文档里也专门写了这一点）。
 */
export function createPgDriver(loadModule: (resolve?: DriverResolver) => Promise<PgModule> = defaultLoader): DriverFactory {
  return {
    name: 'pg',
    async create(connection, poolOptions = {}): Promise<DriverPool> {
      const mod = await loadModule();
      const config: Record<string, unknown> = {};
      if (connection.host !== undefined) config.host = connection.host;
      if (connection.port !== undefined) config.port = connection.port;
      if (connection.user !== undefined) config.user = connection.user;
      if (connection.password !== undefined) config.password = connection.password;
      if (connection.database !== undefined) config.database = connection.database;
      // 框架统一的池参数 → pg.Pool 的真实字段名（逐条映射，不做同名假设）
      if (poolOptions.min !== undefined) config.min = poolOptions.min;
      if (poolOptions.max !== undefined) config.max = poolOptions.max;
      if (poolOptions.idleTimeoutMs !== undefined) config.idleTimeoutMillis = poolOptions.idleTimeoutMs;
      if (poolOptions.connectionTimeoutMs !== undefined) config.connectionTimeoutMillis = poolOptions.connectionTimeoutMs;
      return buildPool(new mod.Pool(config));
    },
  };
}

/** 把 pg 池包成框架的 DriverPool（也供 createDatabase 注入池参数时复用）。 */
export function buildPool(pool: PgPool): DriverPool {
  const runner: Runner = {
    async all(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    async run(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rowCount === null ? 0 : Number(result.rowCount);
    },
    async transaction<R>(fn: (scoped: Runner) => Promise<R>): Promise<R> {
      const client = await pool.connect();
      const scoped: Runner = {
        async all(sql, params = []) {
          const result = await client.query(sql, params);
          return result.rows;
        },
        async run(sql, params = []) {
          const result = await client.query(sql, params);
          return result.rowCount === null ? 0 : Number(result.rowCount);
        },
      };
      try {
        await client.query('BEGIN');
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* 连接可能已经坏了 */
        }
        throw err;
      } finally {
        // 无论成功/失败/回滚失败都要还连接，否则池会被耗干
        client.release();
      }
    },
  };
  let closed = false;
  return {
    ...runner,
    async healthCheck() {
      if (closed) throw new Error('pg pool is closed');
      await pool.query('SELECT 1 AS ok');
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
    stats() {
      return {
        kind: 'pg',
        total: pool.totalCount ?? null,
        idle: pool.idleCount ?? null,
        waiting: pool.waitingCount ?? null,
      };
    },
  };
}
