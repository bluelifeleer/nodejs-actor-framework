import { loadDriverModule, type DriverResolver } from '@actor/db-core';
import type { DriverFactory, DriverPool, Row, Runner } from './types.ts';

/** `mssql`（node-mssql）的最小结构视图。 */
interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query(sql: string): Promise<MssqlResult>;
}
interface MssqlResult {
  recordset?: Row[];
  recordsets?: Row[][];
  rowsAffected?: number[];
}
interface MssqlTransaction {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  request(): MssqlRequest;
}
interface MssqlPool {
  connect(): Promise<MssqlPool>;
  request(): MssqlRequest;
  transaction(): MssqlTransaction;
  close(): Promise<void>;
  size?: number;
  available?: number;
  pending?: number;
}
interface MssqlModule {
  ConnectionPool: new (config: Record<string, unknown>) => MssqlPool;
}

const defaultLoader = async (resolve?: DriverResolver): Promise<MssqlModule> =>
  loadDriverModule<MssqlModule>('mssql', 'mssql', 'mssql', resolve);

/**
 * 把 SQL 里的 `@p1…@pN` 位置参数绑定到 node-mssql 的命名参数上。
 *
 * 为什么这样：node-mssql 只认命名参数（`request.input('p1', …)`），没有位置参数数组；
 * 而框架统一形状是 `(sql, params[])`。占位符由方言描述符给出（`@pN`），这里按序号绑定。
 */
function bind(request: MssqlRequest, params: readonly unknown[]): MssqlRequest {
  let bound = request;
  params.forEach((value, index) => {
    bound = bound.input(`p${index + 1}`, value);
  });
  return bound;
}

function affectedOf(result: MssqlResult): number {
  const rows = result.rowsAffected;
  return rows === undefined || rows.length === 0 ? 0 : Number(rows[0]);
}

/** SQL Server 驱动（懒加载 `mssql`；事务走 `pool.transaction()` 并保证 rollback/commit）。 */
export function createMssqlDriver(loadModule: (resolve?: DriverResolver) => Promise<MssqlModule> = defaultLoader): DriverFactory {
  return {
    name: 'mssql',
    async create(connection, poolOptions = {}): Promise<DriverPool> {
      const mod = await loadModule();
      const config: Record<string, unknown> = {};
      if (connection.host !== undefined) config.server = connection.host;
      if (connection.port !== undefined) config.port = connection.port;
      if (connection.user !== undefined) config.user = connection.user;
      if (connection.password !== undefined) config.password = connection.password;
      if (connection.database !== undefined) config.database = connection.database;
      // node-mssql 的池参数在 pool.* 下（名字与框架统一形状不同，逐条映射）
      const poolConfig: Record<string, unknown> = {};
      if (poolOptions.min !== undefined) poolConfig.min = poolOptions.min;
      if (poolOptions.max !== undefined) poolConfig.max = poolOptions.max;
      if (poolOptions.idleTimeoutMs !== undefined) poolConfig.idleTimeoutMillis = poolOptions.idleTimeoutMs;
      if (Object.keys(poolConfig).length > 0) config.pool = poolConfig;
      if (poolOptions.connectionTimeoutMs !== undefined) config.connectionTimeout = poolOptions.connectionTimeoutMs;

      const pool = new mod.ConnectionPool(config);
      await pool.connect();
      return buildPool(pool);
    },
  };
}

/** 把 node-mssql 的池包成框架的 DriverPool。 */
export function buildPool(pool: MssqlPool): DriverPool {
  const runOn = (makeRequest: () => MssqlRequest): Runner => ({
    async all(sql, params = []) {
      const result = await bind(makeRequest(), params).query(sql);
      return result.recordset ?? [];
    },
    async run(sql, params = []) {
      const result = await bind(makeRequest(), params).query(sql);
      return affectedOf(result);
    },
    async insertReturning(sql, params = []) {
      // T-SQL 没有 RETURNING：把 SCOPE_IDENTITY() 拼成同批次的第二条语句，取最后一个结果集
      const result = await bind(makeRequest(), params).query(`${sql}; SELECT SCOPE_IDENTITY() AS insertId`);
      const sets = result.recordsets ?? [];
      const last = sets.length > 0 ? sets[sets.length - 1] : undefined;
      return last ?? [{ insertId: null }];
    },
  });

  const runner = runOn(() => pool.request());
  let closed = false;
  return {
    ...runner,
    async transaction<R>(fn: (scoped: Runner) => Promise<R>): Promise<R> {
      const tx = pool.transaction();
      await tx.begin();
      try {
        const result = await fn(runOn(() => tx.request()));
        await tx.commit();
        return result;
      } catch (err) {
        try {
          await tx.rollback();
        } catch {
          /* 连接可能已经坏了 */
        }
        throw err;
      }
    },
    async healthCheck() {
      if (closed) throw new Error('mssql pool is closed');
      await pool.request().query('SELECT 1 AS ok');
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.close();
    },
    stats() {
      return { kind: 'mssql', size: pool.size ?? null, available: pool.available ?? null, pending: pool.pending ?? null };
    },
  };
}
