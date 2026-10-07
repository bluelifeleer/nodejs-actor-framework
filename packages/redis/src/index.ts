/**
 * `@actor/redis`：Redis 适配器（官方 `redis` 与 `ioredis` 双驱动）。
 *
 * 连接生命周期（建连/探活/保活/事件转发/drain/关闭）由 `@actor/db-core` 的 `supervise()` 统一提供：
 *
 * ```ts
 * import { redisAdapter } from '@actor/redis';
 * import { supervise } from '@actor/resource';
 *
 * const cache = supervise(redisAdapter({ driver: 'ioredis', prefix: 'app:' }), {
 *   connection: { url: 'redis://127.0.0.1:6379/0' },
 * });
 * await cache.connect();
 * const kv = await cache.acquire();
 * await kv.set('k', 'v', { ttlMs: 60_000 });
 * ```
 *
 * v1 明确**不做** Cluster / Sentinel 拓扑（两个驱动的 cluster API 差异大）；
 * 需要时用 `clientOptions` 透传，或走 `raw` 逃生通道。
 */
export {
  describeRedis,
  parseRedisUrl,
  redisAdapter,
  type RedisAdapterOptions,
  type RedisConnection,
} from './adapter.ts';

export {
  createKeyValueClient,
  type KeyValueClient,
  type KeyValueOptions,
  type KeyValuePipeline,
  type RedisConnectInput,
  type RedisDriverHandle,
} from './client.ts';

export { DEFAULT_REDIS_DRIVER, resolveRedisDriver, type RedisDriverName } from './adapters/index.ts';
