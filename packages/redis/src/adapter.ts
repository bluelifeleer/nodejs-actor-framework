import {
  DbConfigError,
  type BaseConnection,
  type DatabaseAdapter,
  type ManagedConnection,
} from '@actor/resource';

import { DEFAULT_REDIS_DRIVER, resolveRedisDriver, type RedisDriverName } from './adapters/index.ts';
import { createKeyValueClient, type KeyValueClient, type KeyValueOptions } from './client.ts';

/** Redis 连接配置：core 的通用形状 + Redis 自己的两点（TLS、驱动名）。 */
export interface RedisConnection extends BaseConnection {
  /** `rediss://` → TLS。 */
  tls?: boolean;
  /** 用哪个驱动（`redis` / `ioredis`）。 */
  driver?: string;
}

export interface RedisAdapterOptions extends KeyValueOptions {
  /** 驱动：官方 `redis`（默认）或 `ioredis`。 */
  driver?: RedisDriverName;
  /** 直接透传给驱动的额外选项（逃生通道，例如 `socket`/`tls`/哨兵配置）。 */
  clientOptions?: Record<string, unknown>;
}

/**
 * 解析 Redis DSN：支持 `redis://` 与 `rediss://`（TLS），路径是**库索引**（`/0`、`/1`）。
 *
 * 为什么不复用 SQL 的 `parseConnection`：那是按"host + database 名"建模的，而 Redis 的 path 是数字库索引、
 * 还有 TLS 这个维度 —— 硬套会让语义含糊（宁可各写各的，也不假装统一）。
 */
export function parseRedisUrl(url: string): RedisConnection {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(url))?.[1]?.toLowerCase();
  if (scheme !== 'redis' && scheme !== 'rediss') {
    throw new DbConfigError(`redis connection url must start with redis:// or rediss:// (got "${String(url)}")`);
  }
  const parsed = new URL(url);
  const db = parsed.pathname.replace(/^\//, '');
  return {
    kind: 'redis',
    url,
    tls: scheme === 'rediss',
    ...(parsed.hostname === '' ? {} : { host: parsed.hostname }),
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    ...(parsed.username === '' ? {} : { user: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    database: db === '' ? '0' : db,
  };
}

/** 只用于日志/错误：**永不含密码**。 */
export function describeRedis(connection: RedisConnection): string {
  const scheme = connection.tls === true ? 'rediss' : 'redis';
  return `${scheme}://${connection.host ?? 'localhost'}:${String(connection.port ?? 6379)}/${String(connection.database ?? '0')}`;
}

/**
 * **Redis 适配器**：连接管控交给 `@actor/db-core` 的 `supervise()`，
 * 能力面是 `KeyValueClient`（常用语义 + `command()`/`raw` 逃生通道）。
 *
 * 两个驱动（node-redis / ioredis）的差异由 `src/adapters/` 内部吸收，使用方无感。
 */
export function redisAdapter(options: RedisAdapterOptions = {}): DatabaseAdapter<KeyValueClient, RedisConnection> {
  return {
    kind: 'redis',
    driverPackage: resolveRedisDriver(options.driver ?? DEFAULT_REDIS_DRIVER).packageName,
    connectionKind: 'host',
    config: {
      driver: { type: 'string' as const, default: options.driver ?? DEFAULT_REDIS_DRIVER },
      url: { type: 'string' as const, default: '' },
      prefix: { type: 'string' as const, default: options.prefix ?? '' },
      connectTimeoutMs: { type: 'number' as const, default: 10_000 },
    },
    connectionFromUrl: (url) => parseRedisUrl(url),
    describe: (connection) => describeRedis(connection),

    async connect({ connection, pool, load, emitDriverEvent }): Promise<ManagedConnection<KeyValueClient>> {
      const impl = resolveRedisDriver(options.driver ?? DEFAULT_REDIS_DRIVER);
      const url =
        connection.url ??
        `${connection.tls === true ? 'rediss' : 'redis'}://${connection.host ?? 'localhost'}:${String(connection.port ?? 6379)}/${String(connection.database ?? '0')}`;
      const handle = await impl.create({
        load,
        url,
        tls: connection.tls === true,
        pool,
        ...(options.clientOptions === undefined ? {} : { clientOptions: options.clientOptions }),
        ...(emitDriverEvent === undefined ? {} : { emitDriverEvent }),
      });
      const client = createKeyValueClient(handle, {
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.serialize === undefined ? {} : { serialize: options.serialize }),
        ...(options.parse === undefined ? {} : { parse: options.parse }),
      });
      return {
        client,
        healthCheck: () => handle.ping(),
        keepAlive: () => handle.ping(),
        close: () => handle.close(),
        stats: () => handle.stats(),
      };
    },
  };
}
