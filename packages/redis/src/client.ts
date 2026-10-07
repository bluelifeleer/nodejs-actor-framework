/**
 * **键值能力层**：与具体 Redis 驱动无关。两个驱动（node-redis / ioredis）只需要提供一个
 * `RedisDriverHandle`（发命令 + 订阅 + 探活 + 关闭 + 统计），所有命令语义都在这一层实现。
 *
 * 设计原则（与 SQL 侧一致）：
 *   - 常用语义给**薄封装**（`get`/`set`/`hSet`/`lPush`/`sAdd`/`scan`/`publish`/`subscribe`…）；
 *   - 逃生通道永远留着：`command(args)` 发任意命令、`raw` 直接拿原生客户端；
 *   - **不做**"假装完备"的 Redis ORM。
 */
import { DbConfigError, type PoolOptions } from '@actor/resource';

/** 驱动句柄：两个驱动各自的实现都归一到这个形状。 */
export interface RedisDriverHandle {
  /** 驱动名（错误信息用）。 */
  readonly name: string;
  /** 发命令（不含命令名的参数由调用方拼好，与 Redis 协议一致）。 */
  send(args: readonly string[]): Promise<unknown>;
  /** 订阅（**必须用独立连接** —— 订阅态的连接不能再发普通命令）。 */
  subscribe(channel: string, handler: (message: string, channel: string) => void): Promise<() => Promise<void>>;
  ping(): Promise<void>;
  close(): Promise<void>;
  stats(): Record<string, unknown>;
  /** 原生客户端（逃生通道）。 */
  readonly raw: unknown;
}

/**
 * **流水线**：命令入队后逐条发。
 *
 * ⚠️ 这不是 `MULTI/EXEC` 的原子事务（两个驱动的 multi 语义有差异，v1 不做，文档写明）；
 * 名字就叫 `pipeline()`，不假装是事务。
 */
export interface KeyValuePipeline {
  command<T = unknown>(args: readonly string[]): KeyValuePipeline;
  exec(): Promise<unknown[]>;
}

export interface KeyValueOptions {
  /** 键命名空间前缀（多租户/多环境隔离）；所有命令都会自动加上。 */
  prefix?: string;
  /** 值的序列化（默认 JSON）。 */
  serialize?: (value: unknown) => string;
  /** 值的反序列化（默认 JSON）。 */
  parse?: (text: string) => unknown;
}

/**
 * 驱动建连输入：两个驱动实现共用的形状（差异只在实现内部解决）。
 */
export interface RedisConnectInput {
  /** 从应用根解析驱动（缺失时抛带 `npm i …` 提示的错误）。 */
  load: <T>(specifier: string, packageName?: string) => T;
  url: string;
  /** `rediss://`（TLS）。 */
  tls: boolean;
  pool: PoolOptions;
  /** 直接透传给驱动的额外选项（逃生通道）。 */
  clientOptions?: Record<string, unknown>;
  emitDriverEvent?: (event: string, detail?: unknown) => void;
}

/** 键值客户端：常用语义 + 逃生通道。 */
export interface KeyValueClient {
  /** 原生客户端（逃生通道）。 */
  readonly raw: unknown;
  /** 发任意命令（逃生通道）：`await cache.command<number>(['DBSIZE'])`。 */
  command<T = unknown>(args: readonly string[]): Promise<T>;

  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ttlMs?: number; ifNotExists?: boolean }): Promise<boolean>;
  setEx(key: string, value: string, ttlMs: number): Promise<void>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  incr(key: string, by?: number): Promise<number>;
  expire(key: string, ttlMs: number): Promise<boolean>;
  ttl(key: string): Promise<number>;

  mGet(...keys: string[]): Promise<Array<string | null>>;
  mSet(entries: Record<string, string>): Promise<void>;

  hGet(key: string, field: string): Promise<string | null>;
  hSet(key: string, field: string, value: string): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;

  lPush(key: string, ...values: string[]): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;

  sAdd(key: string, ...members: string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;

  scan(cursor: string, options?: { match?: string; count?: number }): Promise<{ cursor: string; keys: string[] }>;

  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string, channel: string) => void): Promise<() => Promise<void>>;

  pipeline(): KeyValuePipeline;

  /** JSON 便捷方法（用 `serialize`/`parse`，默认 JSON）。 */
  getJson<T = unknown>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void>;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  throw new DbConfigError(`redis returned an unsupported value type: ${typeof value}`);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const text = asText(value);
  return text === null ? 0 : Number(text);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 用一个驱动句柄造出键值客户端（两个驱动共用这一份实现）。 */
export function createKeyValueClient(handle: RedisDriverHandle, options: KeyValueOptions = {}): KeyValueClient {
  const prefix = options.prefix ?? '';
  const serialize = options.serialize ?? ((value: unknown) => JSON.stringify(value));
  const parse = options.parse ?? ((text: string) => JSON.parse(text) as unknown);
  const key = (name: string): string => `${prefix}${name}`;

  const send = (args: readonly string[]): Promise<unknown> => handle.send(args);
  const sendNumber = async (args: readonly string[]): Promise<number> => asNumber(await send(args));
  const sendText = async (args: readonly string[]): Promise<string | null> => asText(await send(args));

  const client: KeyValueClient = {
    raw: handle.raw,

    async command<T = unknown>(args: readonly string[]): Promise<T> {
      return (await send(args)) as T;
    },

    get: (name) => sendText(['GET', key(name)]),
    async set(name, value, setOptions = {}) {
      const args = ['SET', key(name), value];
      if (setOptions.ttlMs !== undefined) args.push('PX', String(Math.max(1, Math.round(setOptions.ttlMs))));
      if (setOptions.ifNotExists === true) args.push('NX');
      const result = await sendText(args);
      return result === 'OK';
    },
    async setEx(name, value, ttlMs) {
      // 统一用 `SET key value PX ms`（不再用已废弃的 SETEX 语义差异）
      const result = await sendText(['SET', key(name), value, 'PX', String(Math.max(1, Math.round(ttlMs)))]);
      if (result !== 'OK') throw new DbConfigError(`redis SET PX failed for "${name}"`);
    },
    del: (...names) => sendNumber(['DEL', ...names.map(key)]),
    exists: (...names) => sendNumber(['EXISTS', ...names.map(key)]),
    incr: (name, by = 1) => sendNumber(by === 1 ? ['INCR', key(name)] : ['INCRBY', key(name), String(by)]),
    async expire(name, ttlMs) {
      return (await sendNumber(['PEXPIRE', key(name), String(Math.max(1, Math.round(ttlMs)))])) === 1;
    },
    ttl: (name) => sendNumber(['PTTL', key(name)]),

    async mGet(...names) {
      const values = asArray(await send(['MGET', ...names.map(key)]));
      return values.map((value) => asText(value));
    },
    async mSet(entries) {
      const args = ['MSET'];
      for (const [name, value] of Object.entries(entries)) args.push(key(name), value);
      if (args.length > 1) await send(args);
    },

    hGet: (name, field) => sendText(['HGET', key(name), field]),
    hSet: (name, field, value) => sendNumber(['HSET', key(name), field, value]),
    async hGetAll(name) {
      const flat = asArray(await send(['HGETALL', key(name)]));
      const result: Record<string, string> = {};
      // Redis 的 HGETALL 在 RESP2 下是扁平数组 [field, value, field, value, …]
      for (let index = 0; index + 1 < flat.length; index += 2) {
        const field = asText(flat[index]);
        const value = asText(flat[index + 1]);
        if (field !== null && value !== null) result[field] = value;
      }
      return result;
    },

    lPush: (name, ...values) => sendNumber(['LPUSH', key(name), ...values]),
    async lRange(name, start, stop) {
      return asArray(await send(['LRANGE', key(name), String(start), String(stop)])).map((value) => asText(value) ?? '');
    },

    sAdd: (name, ...members) => sendNumber(['SADD', key(name), ...members]),
    async sMembers(name) {
      return asArray(await send(['SMEMBERS', key(name)])).map((value) => asText(value) ?? '');
    },

    async scan(cursor, scanOptions = {}) {
      const args = ['SCAN', cursor];
      if (scanOptions.match !== undefined) args.push('MATCH', key(scanOptions.match));
      if (scanOptions.count !== undefined) args.push('COUNT', String(scanOptions.count));
      const result = asArray(await send(args));
      const next = asText(result[0]) ?? '0';
      // 剥掉自己的前缀：调用方看到的是"他给的名字"，不是被注入的命名空间
      const keys = asArray(result[1]).map((value) => {
        const text = asText(value) ?? '';
        return prefix !== '' && text.startsWith(prefix) ? text.slice(prefix.length) : text;
      });
      return { cursor: next, keys };
    },

    publish: (channel, message) => sendNumber(['PUBLISH', channel, message]),
    subscribe: (channel, handler) => handle.subscribe(channel, handler),

    pipeline(): KeyValuePipeline {
      const queued: string[][] = [];
      const tx: KeyValuePipeline = {
        command<T = unknown>(args: readonly string[]): KeyValuePipeline {
          void (0 as unknown as T);
          queued.push([...args]);
          return tx;
        },
        async exec(): Promise<unknown[]> {
          // 明确只是流水线（不是 MULTI/EXEC）：逐条发，顺序保证，原子性不保证
          const results: unknown[] = [];
          for (const args of queued) results.push(await send(args));
          return results;
        },
      };
      return tx;
    },

    async getJson<T = unknown>(name: string): Promise<T | null> {
      const text = await sendText(['GET', key(name)]);
      if (text === null) return null;
      return parse(text) as T;
    },
    async setJson(name, value, setOptions = {}) {
      await client.set(name, serialize(value), setOptions);
    },
  };

  return client;
}
