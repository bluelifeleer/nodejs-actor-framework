import { DbConnectionError, type PoolOptions } from '@actor/db-core';

import type { MongoDriverHandle, MongoNativeDb } from '../client.ts';

/**
 * **官方 `mongodb` 驱动**适配：把一个 `MongoClient` 包成 core 的 `MongoDriverHandle`。
 *
 * 差异吸收点：
 *   - 池参数：框架统一 `PoolOptions` → `maxPoolSize`/`minPoolSize`/`maxIdleTimeMS`/`serverSelectionTimeoutMS`；
 *   - 事件（`open`/`close`/`error`/`serverHeartbeatFailed`/`topologyDescriptionChanged`）**只转发**
 *     （MongoClient 自带重连与服务发现，框架不自己重连）；
 *   - 事务：`startSession()` + `session.withTransaction()`，结束时 `endSession()`；
 *   - `stats` 如实：只报连接/拓扑状态，**不编造池数字**。
 */
interface MongoSession {
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  endSession(): Promise<void>;
}

interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name?: string): MongoNativeDb;
  close(force?: boolean): Promise<void>;
  startSession(options?: Record<string, unknown>): MongoSession;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  topology?: { isConnected?: () => boolean; s?: { pool?: { totalConnectionCount?: number; availableConnectionCount?: number } } };
}

interface MongoModule {
  MongoClient: new (url: string, options?: Record<string, unknown>) => MongoClientLike;
}

export interface MongoConnectInput {
  load: <T>(specifier: string, packageName?: string) => T;
  url: string;
  database: string;
  pool: PoolOptions;
  clientOptions?: Record<string, unknown>;
  emitDriverEvent?: (event: string, detail?: unknown) => void;
}

/** 转发给框架的驱动事件（只转发，不解释）。 */
const FORWARDED_EVENTS = [
  'open',
  'close',
  'error',
  'timeout',
  'serverHeartbeatFailed',
  'serverHeartbeatSucceeded',
  'topologyDescriptionChanged',
  'serverDescriptionChanged',
] as const;

/** 框架统一池参数 → MongoDB 官方选项名（映射写在明面上，便于对照）。 */
export function mongoPoolOptions(pool: PoolOptions): Record<string, unknown> {
  return {
    ...(pool.max === undefined ? {} : { maxPoolSize: pool.max }),
    ...(pool.min === undefined ? {} : { minPoolSize: pool.min }),
    ...(pool.idleTimeoutMs === undefined ? {} : { maxIdleTimeMS: pool.idleTimeoutMs }),
    ...(pool.connectionTimeoutMs === undefined ? {} : { serverSelectionTimeoutMS: pool.connectionTimeoutMs }),
  };
}

export async function createMongoHandle(input: MongoConnectInput): Promise<MongoDriverHandle> {
  const mod = input.load<MongoModule>('mongodb');
  const client = new mod.MongoClient(input.url, { ...mongoPoolOptions(input.pool), ...(input.clientOptions ?? {}) });
  for (const event of FORWARDED_EVENTS) {
    client.on(event, (detail: unknown) => {
      input.emitDriverEvent?.(event, detail instanceof Error ? { message: detail.message } : detail);
    });
  }

  try {
    await client.connect();
    await client.db(input.database).command({ ping: 1 }); // 建连即探活
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await client.close(true).catch(() => undefined);
    throw new DbConnectionError(`cannot connect to mongodb: ${error.message}`, error);
  }

  const db = client.db(input.database);
  return {
    name: 'mongodb',
    db,
    raw: client,
    async transaction<T>(fn: (scoped: MongoNativeDb) => Promise<T>): Promise<T> {
      const session = client.startSession();
      try {
        return await session.withTransaction(() => fn(db));
      } finally {
        await session.endSession().catch(() => undefined);
      }
    },
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
    stats: () => {
      const pool = client.topology?.s?.pool;
      return {
        kind: 'mongodb',
        connected: client.topology?.isConnected?.() ?? null,
        // 官方驱动没有公开的池统计就报 null（不编造数字）
        totalConnections: pool?.totalConnectionCount ?? null,
        availableConnections: pool?.availableConnectionCount ?? null,
      };
    },
  };
}
