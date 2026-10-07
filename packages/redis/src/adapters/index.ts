import { DbConfigError } from '@actor/resource';

import type { RedisConnectInput, RedisDriverHandle } from '../client.ts';
import { createIoredisHandle, resolveIoredisConstructor } from './ioredis.ts';
import { createNodeRedisHandle } from './node-redis.ts';

/**
 * **驱动注册表**：按驱动名解析实现。
 *
 * 这里是"按驱动名分支"的**唯一**允许位置（kind 门禁只豁免 `src/adapters/`）——
 * 上层（client / adapter / 使用者代码）都不该知道用的是哪家驱动。
 */
export type RedisDriverName = 'redis' | 'ioredis';

export interface RedisDriverImpl {
  readonly name: RedisDriverName;
  /** 用户要装的包名（错误信息里用）。 */
  readonly packageName: string;
  create(input: RedisConnectInput): Promise<RedisDriverHandle>;
}

/** 默认驱动：官方 `redis`（node-redis）。 */
export const DEFAULT_REDIS_DRIVER: RedisDriverName = 'redis';

const IMPLS: Record<RedisDriverName, RedisDriverImpl> = {
  redis: { name: 'redis', packageName: 'redis', create: createNodeRedisHandle },
  ioredis: { name: 'ioredis', packageName: 'ioredis', create: createIoredisHandle },
};

/** 驱动名 → 实现；不认识的名字**明确报错**（不静默当成默认驱动）。 */
export function resolveRedisDriver(name: RedisDriverName | string): RedisDriverImpl {
  const impl = IMPLS[name as RedisDriverName];
  if (impl === undefined) {
    throw new DbConfigError(
      `unknown redis driver "${String(name)}": expected one of ${Object.keys(IMPLS).join(', ')}`,
    );
  }
  return impl;
}

export { createIoredisHandle, createNodeRedisHandle, resolveIoredisConstructor };
