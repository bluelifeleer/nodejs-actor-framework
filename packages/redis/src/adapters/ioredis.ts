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

  const subscriptions = new Set<() => Promise<void>>();
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
        try {
          handler(String(message ?? ''), String(received ?? channel));
        } catch (err) {
          // 回调抛错若逃进驱动的事件分发会变成 uncaughtException；这里转成可见事件
          input.emitDriverEvent?.('subscriber:handler_error', { message: err instanceof Error ? err.message : String(err) });
        }
      });
      try {
        await subscriber.subscribe(channel, () => undefined);
      } catch (err) {
        subscriber.disconnect();
        throw err;
      }
      const cleanup = async (): Promise<void> => {
        subscriptions.delete(cleanup);
        await subscriber.unsubscribe(channel).catch(() => undefined);
        subscriber.disconnect();
      };
      subscriptions.add(cleanup);
      return cleanup;
    },
    async ping() {
      await client.ping();
    },
    async close() {
      // 订阅连接不随主连接 quit：必须先逐个退订，否则进程会留下一条活连接
      for (const cleanup of [...subscriptions]) await cleanup().catch(() => undefined);
      subscriptions.clear();
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
    stats: () => ({ kind: 'ioredis', status: client.status ?? null }),
  };
}
