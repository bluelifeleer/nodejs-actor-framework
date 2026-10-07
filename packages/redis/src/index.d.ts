/**
 * `@actor/redis` 的手写声明面（与 src/index.ts 的运行时导出一一对应，由门禁测试盯着）。
 * 设计见 docs/design/m7-multi-database.md。
 */
import type { BaseConnection, DatabaseAdapter, PoolOptions } from '@actor/resource';

// --- 驱动与连接 -------------------------------------------------------------
export type RedisDriverName = 'redis' | 'ioredis';

/** 默认驱动：官方 `redis`（node-redis）。 */
export declare const DEFAULT_REDIS_DRIVER: RedisDriverName;

/** 驱动实现（注册表内部用）。 */
export interface RedisDriverImpl {
  readonly name: RedisDriverName;
  readonly packageName: string;
}
/** 驱动名 → 实现；不认识的名字明确报错。 */
export declare function resolveRedisDriver(name: RedisDriverName | string): RedisDriverImpl;

/** Redis 连接配置。 */
export interface RedisConnection extends BaseConnection {
  /** `rediss://` → TLS。 */
  tls?: boolean;
  /** 用哪个驱动。 */
  driver?: string;
}

/** 驱动建连输入（两个驱动实现共用）。 */
export interface RedisConnectInput {
  load: <T>(specifier: string, packageName?: string) => T;
  url: string;
  tls: boolean;
  pool: PoolOptions;
  clientOptions?: Record<string, unknown>;
  emitDriverEvent?: (event: string, detail?: unknown) => void;
}

/** 驱动句柄：两个驱动的实现都归一到这个形状。 */
export interface RedisDriverHandle {
  readonly name: string;
  send(args: readonly string[]): Promise<unknown>;
  subscribe(channel: string, handler: (message: string, channel: string) => void): Promise<() => Promise<void>>;
  ping(): Promise<void>;
  close(): Promise<void>;
  stats(): Record<string, unknown>;
  readonly raw: unknown;
}

// --- 键值能力层 -------------------------------------------------------------
export interface KeyValueOptions {
  /** 键命名空间前缀；所有命令自动加上，`scan` 结果会自动剥掉。 */
  prefix?: string;
  serialize?: (value: unknown) => string;
  parse?: (text: string) => unknown;
}

/** 流水线（**不是** MULTI/EXEC 事务）。 */
export interface KeyValuePipeline {
  command<T = unknown>(args: readonly string[]): KeyValuePipeline;
  exec(): Promise<unknown[]>;
}

/** 键值客户端：常用语义 + `command()`/`raw` 逃生通道。 */
export interface KeyValueClient {
  readonly raw: unknown;
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
  getJson<T = unknown>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void>;
}

/** 用一个驱动句柄造键值客户端（两个驱动共用这一份实现）。 */
export declare function createKeyValueClient(handle: RedisDriverHandle, options?: KeyValueOptions): KeyValueClient;

// --- 适配器 -----------------------------------------------------------------
export interface RedisAdapterOptions extends KeyValueOptions {
  driver?: RedisDriverName;
  clientOptions?: Record<string, unknown>;
}
/** 解析 `redis://` / `rediss://` DSN（path 是库索引）。 */
export declare function parseRedisUrl(url: string): RedisConnection;
/** 只用于日志/错误：永不含密码。 */
export declare function describeRedis(connection: RedisConnection): string;
/** Redis 适配器（连接管控交给 `@actor/db-core` 的 `supervise()`）。 */
export declare function redisAdapter(
  options?: RedisAdapterOptions,
): DatabaseAdapter<KeyValueClient, RedisConnection>;
