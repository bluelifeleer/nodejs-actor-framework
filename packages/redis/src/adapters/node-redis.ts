import { DbConnectionError } from '@actor/resource';

import type { RedisConnectInput, RedisDriverHandle } from '../client.ts';

/**
 * **node-redis（官方 `redis` 包）** 适配实现。
 *
 * 差异吸收（与 ioredis 的差别都在这里解决，上层 `KeyValueClient` 无感）：
 *   - 建连必须显式 `await client.connect()`（ioredis 是自动连）；
 *   - 订阅**必须 `duplicate()` 一条独立连接**（订阅态的连接不能再发普通命令）；
 *   - 事件名是 `ready`/`error`/`reconnecting`/`end`；
 *   - 优雅关闭用 `quit()`（失败兜底 `disconnect()`）。
 */

/** node-redis 的最小结构视图。 */
interface NodeRedisClient {
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  sendCommand(args: string[]): Promise<unknown>;
  duplicate(): NodeRedisClient;
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect?(): Promise<unknown> | void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  isReady?: boolean;
  isOpen?: boolean;
}

interface NodeRedisModule {
  createClient(options: Record<string, unknown>): NodeRedisClient;
}

/** node-redis 的事件名（驱动自带重连 → 框架只转发，不自己重连）。 */
const FORWARDED_EVENTS = ['error', 'ready', 'reconnecting', 'end'] as const;

function describeError(detail: unknown): unknown {
  return detail instanceof Error ? { message: detail.message } : detail;
}

export async function createNodeRedisHandle(input: RedisConnectInput): Promise<RedisDriverHandle> {
  const mod = input.load<NodeRedisModule>('redis');
  const client = mod.createClient({
    url: input.url,
    ...(input.pool.connectionTimeoutMs === undefined ? {} : { socket: { connectTimeout: input.pool.connectionTimeoutMs } }),
    ...(input.clientOptions ?? {}),
  });
  for (const event of FORWARDED_EVENTS) client.on(event, (detail: unknown) => input.emitDriverEvent?.(event, describeError(detail)));

  try {
    await client.connect();
    await client.ping(); // 建连即探活：连不上就在启动阶段失败
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await Promise.resolve(client.disconnect?.()).catch(() => undefined);
    throw new DbConnectionError(`cannot connect to redis: ${error.message}`, error);
  }

  return {
    name: 'redis',
    raw: client,
    send: (args) => client.sendCommand([...args]),
    async subscribe(channel, handler) {
      // ★ 订阅必须独立连接（订阅态的连接不能再发普通命令）
      const subscriber = client.duplicate();
      for (const event of FORWARDED_EVENTS) {
        subscriber.on(event, (detail: unknown) => input.emitDriverEvent?.(`subscriber:${event}`, describeError(detail)));
      }
      await subscriber.connect();
      await subscriber.subscribe(channel, (message: string, received: string) => handler(message, received));
      return async () => {
        await subscriber.unsubscribe(channel).catch(() => undefined);
        await subscriber.quit().catch(() => undefined);
      };
    },
    async ping() {
      await client.ping();
    },
    async close() {
      try {
        await client.quit();
      } catch {
        await Promise.resolve(client.disconnect?.()).catch(() => undefined);
      }
    },
    stats: () => ({ kind: 'redis', isReady: client.isReady === true, isOpen: client.isOpen === true }),
  };
}
