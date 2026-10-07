import {
  DbConnectionError,
  DbError,
  type DatabaseAdapter,
  type ManagedConnection,
} from '@actor/db-core';

import { describeConnection, type Dialect, type NormalizedConnection } from './dialect.ts';
import { dialectSpec } from './dialects/index.ts';
import type { DriverFactory, DriverPool } from './drivers/types.ts';

/**
 * **SQL 适配器**：把既有的 `DriverFactory` 包成 core 的 `DatabaseAdapter`（设计 §4.2）。
 *
 * 这样 SQL 与 Redis/MongoDB/用户自装适配器走**同一条**连接生命周期（core 的 `supervise()`），
 * 而 SQL 侧原有的语义在这里被**原样保住**：
 *   - `DbError`（配置/驱动缺失等）原样抛出，信息更具体；
 *   - 其它错误包成 `DbConnectionError`；
 *   - 建连失败时把**半开的池**关掉（不泄漏连接）。
 */
export interface SqlAdapterOptions {
  dialect: Dialect;
  driver: DriverFactory;
}

export function createSqlAdapter(options: SqlAdapterOptions): DatabaseAdapter<DriverPool, NormalizedConnection> {
  const { dialect, driver } = options;
  const impl = dialectSpec(dialect); // 能力位从方言描述符取（不要在这里点名方言 —— 门禁盯着）
  return {
    kind: 'sql',
    driverPackage: impl.driverPackage,
    connectionKind: impl.connectionKind,
    describe: (connection) => describeConnection(connection),

    async connect({ connection, pool }): Promise<ManagedConnection<DriverPool>> {
      let created: DriverPool | null = null;
      try {
        created = await driver.create(connection, pool, dialect);
        await created.healthCheck(); // 建池后立刻探活：连不上就在启动阶段失败，不静默降级
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (created !== null) await created.close().catch(() => undefined);
        if (error instanceof DbError) throw error; // 配置类/驱动缺失：原样抛
        throw new DbConnectionError(`cannot connect to ${describeConnection(connection)}: ${error.message}`, error);
      }
      const current = created;
      return {
        client: current,
        healthCheck: () => current.healthCheck(),
        close: () => current.close(),
        stats: () => current.stats?.() ?? null, // 驱动没给统计就是 null（不编造）
      };
    },
  };
}
