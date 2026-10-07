import { DbConnectionError } from '@actor/resource';

import type { RedisConnectInput, RedisDriverHandle } from '../client.ts';

/**
 * **ioredis** 适配实现（与 node-redis 的差异都在这里吸收）。
 *
 * 差异：
 *   - 构造即自动连（`lazyConnect` 可选）；
 *   - 命令用 `call(cmd, ...args)`；
 *   - 订阅：`duplicate()` 一条独立连接，消息走 `message` 事件；
 *   - 事件名更多（`connect`/`ready`/`error`/`close`/`reconnecting`/`end`），全部转发给框架；
 *   - 优雅关闭 `quit()`（等未完成回复），失败兜底 `disconnect()`。
 */
interface IoredisClient {
  call(command: string, ...args: Array<string | number>): Promise<unknown>;
  ping(): Promise<string>;
  duplicate(): IoredisClient;
  subscribe(channel: string, listener: (err: unknown, count: number) => void): Promise<number>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
  status?: string;
}

type IoredisConstructor = new (url: string, options?: Record<string, unknown>) => IoredisClient;

interface IoredisModule {
  default?: IoredisConstructor;
  Redis?: IoredisConstructor;
}

const FORWARDED_EVENTS = ['connect', 'ready', 'error', 'close', 'reconnecting', 'end'] as const;

/** ioredis 是 CJS：`load()` 拿到的可能是模块对象（`default`）或类本身（打包差异）。 */
export function resolveIoredisConstructor(mod: IoredisModule | IoredisConstructor): IoredisConstructor {
  const candidate = mod as IoredisModule;
  const ctor = candidate.default ?? candidate.Redis ?? (typeof mod === 'function' ? (mod as IoredisConstructor) : undefined);
  if (typeof ctor !== 'function') {
    throw new DbConnectionError('the "ioredis" package did not expose a Redis constructor (default/Redis)');
  }
  return ctor;
}

export async function createIoredisHandle(input: RedisConnectInput): Promise<RedisDriverHandle> {
  const mod = input.load<IoredisModule>('ioredis');
  const Redis = resolveIoredisConstructor(mod);
  const client = new Redis(input.url, {
    ...(input.pool.connectionTimeoutMs === undefined ? {} : { connectTimeout: input.pool.connectionTimeoutMs }),
    ...(input.tls ? { tls: {} } : {}),
    ...(input.clientOptions ?? {}),
  });
  // 框架**不自己重连**：驱动的事件原样转发（决策 5）
  for (const event of FORWARDED_EVENTS) client.on(event, (detail: unknown) => input.emitDriverEvent?.(event, detail instanceof Error ? { message: detail.message } : detail));

  try {
    await client.ping(); // 自动连 + 探活
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    client.disconnect();
    throw new DbConnectionError(`cannot connect to redis (ioredis): ${error.message}`, error);
  }

  return {
    name: 'ioredis',
    raw: client,
    send: (args) => {
      const [command = '', ...rest] = args;
      return client.call(command, ...rest);
    },
    async subscribe(channel, handler) {
      const subscriber = client.duplicate(); // ★ 订阅必须独立连接
      for (const event of FORWARDED_EVENTS) {
        subscriber.on(event, (detail: unknown) => input.emitDriverEvent?.(`subscriber:${event}`, detail instanceof Error ? { message: detail.message } : detail));
      }
      subscriber.on('message', (...args: unknown[]) => {
        const [received, message] = args;
        handler(String(message ?? ''), String(received ?? channel));
      });
      await subscriber.subscribe(channel, () => undefined);
      return async () => {
        await subscriber.unsubscribe(channel).catch(() => undefined);
        subscriber.disconnect();
      };
    },
    async ping() {
      await client.ping();
    },
    async close() {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
    stats: () => ({ kind: 'ioredis', status: client.status ?? null }),
  };
}
