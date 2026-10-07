import { loadDriverModule, type DriverResolver } from './resolve.ts';
import type { DriverFactory, DriverPool, Row, Runner } from './types.ts';

/** `mysql2/promise` 的最小结构视图。 */
interface MysqlConnection {
  query(sql: string, params?: readonly unknown[]): Promise<[unknown, unknown]>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  release(): void;
}
interface MysqlPool extends MysqlConnection {
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
  pool?: { _allConnections?: { length: number }; _freeConnections?: { length: number } };
}
interface MysqlModule {
  createPool(config: Record<string, unknown>): MysqlPool;
}

const defaultLoader = async (resolve?: DriverResolver): Promise<MysqlModule> =>
  loadDriverModule<MysqlModule>('mysql2/promise', 'mysql', 'mysql2', resolve);

function rowsOf(result: unknown): Row[] {
  // mysql2 的 query 返回 [rows, fields]；run 的 rows 是 ResultSetHeader
  if (Array.isArray(result)) return result as Row[];
  return [];
}

function affectedOf(result: unknown): number {
  const header = result as { affectedRows?: number } | null;
  return header?.affectedRows === undefined ? 0 : Number(header.affectedRows);
}

/**
 * MySQL 驱动（懒加载 `mysql2/promise`）。
 *
 * 事务走 `getConnection()`（专用连接）+ `beginTransaction/commit/rollback`，并在 finally `release()`。
 */
export function createMysqlDriver(loadModule: (resolve?: DriverResolver) => Promise<MysqlModule> = defaultLoader): DriverFactory {
  return {
    name: 'mysql2',
    async create(connection, poolOptions = {}): Promise<DriverPool> {
      const mod = await loadModule();
      const config: Record<string, unknown> = {};
      if (connection.host !== undefined) config.host = connection.host;
      if (connection.port !== undefined) config.port = connection.port;
      if (connection.user !== undefined) config.user = connection.user;
      if (connection.password !== undefined) config.password = connection.password;
      if (connection.database !== undefined) config.database = connection.database;
      // mysql2 的字段名与框架统一形状不同：逐条映射（mysql2 没有 min 语义）
      if (poolOptions.max !== undefined) config.connectionLimit = poolOptions.max;
      if (poolOptions.idleTimeoutMs !== undefined) config.idleTimeout = poolOptions.idleTimeoutMs;
      if (poolOptions.connectionTimeoutMs !== undefined) config.connectTimeout = poolOptions.connectionTimeoutMs;
      return buildPool(mod.createPool(config));
    },
  };
}

/** 把 mysql2 池包成框架的 DriverPool。 */
export function buildPool(pool: MysqlPool): DriverPool {
  const runner: Runner = {
    async all(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return rowsOf(rows);
    },
    async run(sql, params = []) {
      const [result] = await pool.query(sql, params);
      return affectedOf(result);
    },
    async insertReturning(sql, params = []) {
      // MySQL 没有 RETURNING：用结果里的 insertId（仓储层会归一成主键值）
      const [result] = await pool.query(sql, params);
      const header = result as { insertId?: number | string } | null;
      return [{ insertId: header?.insertId ?? null }];
    },
    async transaction<R>(fn: (scoped: Runner) => Promise<R>): Promise<R> {
      const connection = await pool.getConnection();
      const scoped: Runner = {
        async all(sql, params = []) {
          const [rows] = await connection.query(sql, params);
          return rowsOf(rows);
        },
        async run(sql, params = []) {
          const [result] = await connection.query(sql, params);
          return affectedOf(result);
        },
      };
      try {
        if (typeof connection.beginTransaction === 'function') await connection.beginTransaction();
        const result = await fn(scoped);
        if (typeof connection.commit === 'function') await connection.commit();
        return result;
      } catch (err) {
        try {
          if (typeof connection.rollback === 'function') await connection.rollback();
        } catch {
          /* 连接可能已经坏了 */
        }
        throw err;
      } finally {
        connection.release();
      }
    },
  };
  let closed = false;
  return {
    ...runner,
    async healthCheck() {
      if (closed) throw new Error('mysql pool is closed');
      await pool.query('SELECT 1 AS ok');
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
    stats() {
      return {
        kind: 'mysql',
        all: pool.pool?._allConnections?.length ?? null,
        free: pool.pool?._freeConnections?.length ?? null,
      };
    },
  };
}
