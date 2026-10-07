import {
  DbConfigError,
  type BaseConnection,
  type DatabaseAdapter,
  type ManagedConnection,
} from '@actor/db-core';

import { DEFAULT_MONGO_DRIVER, resolveMongoDriver, type MongoDriverName } from './adapters/index.ts';
import { createDocumentClient, type DocumentClient } from './client.ts';
import { syncCollections, type CollectionModel } from './collection-model.ts';

/** MongoDB 连接配置：core 的通用形状 + Mongo 自己的两点（TLS、authSource）。 */
export interface MongoConnection extends BaseConnection {
  /** `mongodb+srv://` 或 `?tls=true` → TLS。 */
  tls?: boolean;
  /** 认证库（`?authSource=admin`）。 */
  authSource?: string;
}

export interface MongoAdapterOptions {
  /** 驱动（v1 只有官方 `mongodb`）。 */
  driver?: MongoDriverName;
  /** 库名（不给则从 DSN 的 path 取，再默认 `test`）。 */
  database?: string;
  /** 要 `sync()` 的集合声明（建集合/索引；validator 变更需显式 `auto`）。 */
  collections?: readonly CollectionModel[];
  /** 允许 `sync()` 应用 validator 变更（`collMod`）；默认 false（只检测并报漂移）。 */
  auto?: boolean;
  /** 直接透传给驱动的额外选项（逃生通道）。 */
  clientOptions?: Record<string, unknown>;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

/**
 * 解析 MongoDB DSN：`mongodb://` 与 `mongodb+srv://`（SRV 即 TLS），支持 `?authSource=`、`?tls=true`。
 *
 * 与 Redis 侧同理：**不复用 SQL 的 `parseConnection`**（那是 host+database 名的模型，
 * 而 Mongo 有 SRV/TLS/authSource 这些维度，硬套会把语义搞含糊）。
 */
export function parseMongoUrl(url: string): MongoConnection {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(url))?.[1]?.toLowerCase();
  if (scheme !== 'mongodb' && scheme !== 'mongodb+srv') {
    throw new DbConfigError(`mongodb connection url must start with mongodb:// or mongodb+srv:// (got "${String(url)}")`);
  }
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');
  const authSource = parsed.searchParams.get('authSource');
  const tlsParam = parsed.searchParams.get('tls');
  return {
    kind: 'mongodb',
    url,
    tls: scheme === 'mongodb+srv' || tlsParam === 'true',
    ...(parsed.hostname === '' ? {} : { host: parsed.hostname }),
    ...(parsed.port === '' ? {} : { port: Number(parsed.port) }),
    ...(parsed.username === '' ? {} : { user: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(database === '' ? {} : { database }),
    ...(authSource === null ? {} : { authSource }),
  };
}

/** 只用于日志/错误：**永不含密码**。 */
export function describeMongo(connection: MongoConnection): string {
  const scheme = connection.tls === true ? 'mongodb+srv' : 'mongodb';
  const host = connection.host ?? 'localhost';
  const port = connection.port === undefined ? '' : `:${String(connection.port)}`;
  const auth = connection.authSource === undefined ? '' : `?authSource=${connection.authSource}`;
  return `${scheme}://${host}${port}/${String(connection.database ?? '')}${auth}`;
}

/**
 * **MongoDB 适配器**：连接管控交给 `@actor/db-core` 的 `supervise()`；
 * 能力面是 `DocumentClient`（集合薄封装 + 事务 + `withDb`/`raw` 逃生通道）。
 */
export function mongoAdapter(options: MongoAdapterOptions = {}): DatabaseAdapter<DocumentClient, MongoConnection> {
  const driverName = options.driver ?? DEFAULT_MONGO_DRIVER;
  return {
    kind: 'mongodb',
    driverPackage: resolveMongoDriver(driverName).packageName,
    connectionKind: 'host',
    config: {
      driver: { type: 'string' as const, default: driverName },
      url: { type: 'string' as const, default: '' },
      database: { type: 'string' as const, default: options.database ?? '' },
      connectTimeoutMs: { type: 'number' as const, default: 10_000 },
    },
    connectionFromUrl: (url) => parseMongoUrl(url),
    describe: (connection) => describeMongo(connection),

    async connect({ connection, pool, load, emitDriverEvent, logger }): Promise<ManagedConnection<DocumentClient>> {
      const impl = resolveMongoDriver(driverName);
      const database = options.database ?? connection.database ?? 'test';
      const url =
        connection.url ??
        `mongodb://${connection.host ?? 'localhost'}${connection.port === undefined ? '' : `:${String(connection.port)}`}/${database}`;
      const handle = await impl.create({
        load,
        url,
        database,
        pool,
        ...(options.clientOptions === undefined ? {} : { clientOptions: options.clientOptions }),
        ...(emitDriverEvent === undefined ? {} : { emitDriverEvent }),
      });

      // 声明式集合：sync 建集合/索引；validator 变更只在显式 auto 时才应用（与 SQL 侧同一纪律）
      if (options.collections !== undefined && options.collections.length > 0) {
        const report = await syncCollections(handle.db, options.collections, {
          auto: options.auto === true,
          ...(options.logger === undefined ? (logger === undefined ? {} : { logger }) : { logger: options.logger }),
        });
        if (report.drift.length > 0) {
          throw new DbConfigError(
            `mongodb collections drifted from the declarations: ${report.drift.map((item) => `${item.collection}:${item.kind}`).join(', ')}; ` +
              'pass { auto: true } to apply validator changes explicitly.',
          );
        }
      }

      return {
        client: createDocumentClient(handle),
        healthCheck: () => handle.ping(),
        keepAlive: () => handle.ping(),
        close: () => handle.close(),
        stats: () => handle.stats(),
      };
    },
  };
}
