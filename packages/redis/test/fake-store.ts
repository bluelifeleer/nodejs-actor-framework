import type { RedisDriverHandle } from '../src/client.ts';

/**
 * 内存版 Redis：**一份命令实现**，套上三种形状（core 的 handle、node-redis 客户端、ioredis 客户端）。
 *
 * 为什么不 mock 方法而要真的执行命令：`KeyValueClient` 的本质是"领域方法 → Redis 命令"的映射，
 * 只有让假驱动真的解析命令，才能验证参数顺序、前缀、`HGETALL` 的扁平数组这类真正容易错的地方。
 */
export interface FakeStore {
  /** core 的驱动句柄形状（测 `KeyValueClient` 用）。 */
  readonly handle: RedisDriverHandle;
  /** 收到的全部命令（含命令名）。 */
  readonly commands: string[][];
  /** 驱动发出的重连/错误事件（框架只转发）。 */
  readonly emitted: Array<{ event: string; detail?: unknown }>;
  /** 建了几条连接（`duplicate()` 计数 → 证明"订阅另开连接"）。 */
  readonly connections: { raw: number; duplicates: number };
  closed: number;
  /** 往订阅通道推消息（模拟别的进程 PUBLISH）。 */
  deliver(channel: string, message: string): void;
  /** 切开/恢复健康（`ping` 抛错）—— 契约套件的 setHealthy 用它。 */
  setHealthy(healthy: boolean): void;
  /** 模拟驱动自己发事件（例如断线重连）—— 框架应当只转发。 */
  fire(event: string, detail?: unknown): void;
  /** 长得像 node-redis 的客户端。 */
  nodeRedisClient(): unknown;
  /** 长得像 ioredis 的客户端。 */
  ioredisClient(): unknown;
  /** 假模块：`await import('redis')` 的形状。 */
  nodeRedisModule(): { createClient(options: unknown): unknown };
  /** 假模块：`await import('ioredis')` 的形状（默认导出是类）。 */
  ioredisModule(): { default: new (url: string, options?: unknown) => unknown };
}

export function createFakeStore(): FakeStore {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
  const expiries = new Map<string, number>();
  const subscribers = new Map<string, Array<(message: string, channel: string) => void>>();
  const messageHandlers: Array<(channel: string, message: string) => void> = [];
  let healthy = true;
  let closed = 0;

  const commands: string[][] = [];
  const emitted: Array<{ event: string; detail?: unknown }> = [];
  const connections = { raw: 0, duplicates: 0 };

  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  /** 记录**并通知监听器**（只记录不通知的话，"框架只转发驱动事件"就永远测不到）。 */
  function emit(event: string, detail?: unknown): void {
    emitted.push({ event, ...(detail === undefined ? {} : { detail }) });
    for (const listener of listeners.get(event) ?? []) listener(detail);
  }
  function on(event: string, listener: (...args: unknown[]) => void): void {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
  }

  function deliver(channel: string, message: string): void {
    for (const handler of subscribers.get(channel) ?? []) handler(message, channel);
    for (const handler of messageHandlers) handler(channel, message);
  }

  function subscribe(channel: string, handler: (message: string, channel: string) => void): () => void {
    const list = subscribers.get(channel) ?? [];
    list.push(handler);
    subscribers.set(channel, list);
    return () => {
      subscribers.set(
        channel,
        (subscribers.get(channel) ?? []).filter((item) => item !== handler),
      );
    };
  }

  async function dispatch(args: readonly string[]): Promise<unknown> {
    const [command = '', ...rest] = args;
    commands.push([...args]);
    switch (command.toUpperCase()) {
      case 'PING':
        if (!healthy) throw new Error('redis 探活失败（假 store 被切成不健康）');
        return 'PONG';
      case 'GET':
        return strings.get(rest[0]) ?? null;
      case 'SET': {
        const [key, value, ...flags] = rest;
        if (flags.some((flag) => flag.toUpperCase() === 'NX') && strings.has(key)) return null;
        strings.set(key, value);
        const px = flags.findIndex((flag) => flag.toUpperCase() === 'PX');
        if (px >= 0) expiries.set(key, Number(flags[px + 1]));
        return 'OK';
      }
      case 'DEL': {
        let removed = 0;
        for (const key of rest) {
          if (strings.delete(key) || hashes.delete(key) || lists.delete(key) || sets.delete(key)) removed += 1;
        }
        return removed;
      }
      case 'EXISTS':
        return rest.filter((key) => strings.has(key)).length;
      case 'INCR':
        strings.set(rest[0], String(Number(strings.get(rest[0]) ?? '0') + 1));
        return Number(strings.get(rest[0]));
      case 'INCRBY':
        strings.set(rest[0], String(Number(strings.get(rest[0]) ?? '0') + Number(rest[1])));
        return Number(strings.get(rest[0]));
      case 'PEXPIRE':
        expiries.set(rest[0], Number(rest[1]));
        return 1;
      case 'PTTL':
        return expiries.get(rest[0]) ?? -1;
      case 'MGET':
        return rest.map((key) => strings.get(key) ?? null);
      case 'MSET':
        for (let index = 0; index + 1 < rest.length; index += 2) strings.set(rest[index], rest[index + 1]);
        return 'OK';
      case 'HGET':
        return hashes.get(rest[0])?.get(rest[1]) ?? null;
      case 'HSET': {
        const map = hashes.get(rest[0]) ?? new Map<string, string>();
        map.set(rest[1], rest[2]);
        hashes.set(rest[0], map);
        return 1;
      }
      case 'HGETALL':
        return [...(hashes.get(rest[0]) ?? new Map<string, string>()).entries()].flat(); // RESP2 扁平数组
      case 'LPUSH': {
        const list = lists.get(rest[0]) ?? [];
        // Redis 是**逐个**压入头部：LPUSH l a b → [b, a]
        for (const value of rest.slice(1)) list.unshift(value);
        lists.set(rest[0], list);
        return list.length;
      }
      case 'LRANGE': {
        const list = lists.get(rest[0]) ?? [];
        const start = Number(rest[1]);
        const stop = Number(rest[2]) === -1 ? list.length : Number(rest[2]) + 1;
        return list.slice(start, stop);
      }
      case 'SADD': {
        const set = sets.get(rest[0]) ?? new Set<string>();
        for (const member of rest.slice(1)) set.add(member);
        sets.set(rest[0], set);
        return set.size;
      }
      case 'SMEMBERS':
        return [...(sets.get(rest[0]) ?? new Set<string>())];
      case 'SCAN': {
        const matchIndex = rest.findIndex((flag) => flag.toUpperCase() === 'MATCH');
        const match = matchIndex >= 0 ? rest[matchIndex + 1] : '*';
        const pattern = new RegExp(`^${match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        return ['0', [...strings.keys()].filter((key) => pattern.test(key))];
      }
      case 'PUBLISH':
        deliver(rest[0], rest[1]);
        return (subscribers.get(rest[0]) ?? []).length;
      default:
        return null;
    }
  }

  const handle: RedisDriverHandle = {
    name: 'fake-redis',
    raw: { note: '原生客户端在这里（逃生通道）' },
    send: dispatch,
    async subscribe(channel, handler) {
      const unsubscribe = subscribe(channel, handler);
      return async () => unsubscribe();
    },
    async ping() {
      await dispatch(['PING']);
    },
    async close() {
      closed += 1;
    },
    stats: () => ({ kind: 'fake-redis', connections: { ...connections } }),
  };

  const makeClient = (kind: 'node' | 'ioredis'): Record<string, unknown> => {
    const client: Record<string, unknown> = {
      status: 'ready',
      isReady: true,
      isOpen: true,
      async connect() {
        emit('ready'); // node-redis：显式 connect 成功后驱动会发 ready
        return undefined;
      },
      async ping() {
        await dispatch(['PING']);
        return 'PONG';
      },
      async sendCommand(args: string[]) {
        return dispatch(args);
      },
      async call(command: string, ...args: Array<string | number>) {
        return dispatch([command, ...args.map(String)]);
      },
      duplicate() {
        connections.duplicates += 1;
        connections.raw += 1;
        return makeClient(kind);
      },
      async subscribe(channel: string, listener: (...args: unknown[]) => void) {
        if (kind === 'node') {
          const unsubscribe = subscribe(channel, (message, received) => {
            (listener as (message: string, channel: string) => void)(message, received);
          });
          return () => unsubscribe();
        }
        subscribe(channel, () => undefined);
        (listener as (err: unknown, count: number) => void)(null, 1);
        return 1;
      },
      async unsubscribe() {
        return 1;
      },
      async quit() {
        closed += 1;
        return 'OK';
      },
      disconnect() {
        return undefined;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === 'message') {
          messageHandlers.push(listener as (channel: string, message: string) => void);
          return client;
        }
        on(event, listener);
        return client;
      },
    };
    return client;
  };

  return {
    handle,
    commands,
    emitted,
    connections,
    get closed() {
      return closed;
    },
    deliver,
    setHealthy(value: boolean) {
      healthy = value;
    },
    fire(event, detail) {
      emit(event, detail);
    },
    nodeRedisClient() {
      connections.raw += 1;
      return makeClient('node');
    },
    ioredisClient() {
      connections.raw += 1;
      const client = makeClient('ioredis');
      emit('ready'); // ioredis 是自动连：构造完很快就是 ready
      return client;
    },
    nodeRedisModule() {
      return { createClient: () => (this as unknown as FakeStore).nodeRedisClient() };
    },
    ioredisModule() {
      // ioredis 的默认导出是类：`new Redis(url, options)`
      const store = this as unknown as FakeStore;
      return {
        default: class FakeIoredis {
          constructor() {
            return store.ioredisClient() as never;
          }
        } as never,
      };
    },
  };
}
