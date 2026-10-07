import { DbConfigError } from '@actor/resource';

import type { MongoDriverHandle } from '../client.ts';
import { createMongoHandle, mongoPoolOptions, type MongoConnectInput } from './mongodb.ts';

/**
 * **驱动注册表**：按驱动名解析实现。
 *
 * 这里是"按驱动名分支"的唯一允许位置（kind 门禁只豁免 `src/adapters/`）——
 * 上层（client / adapter / 使用者代码）都不该知道用的是哪家驱动。
 * v1 只有官方 `mongodb`；将来要加（例如 `mongoose` 包装或 mock 驱动）就在这里加一行。
 */
export type MongoDriverName = 'mongodb';

export interface MongoDriverImpl {
  readonly name: MongoDriverName;
  /** 用户要装的包名（错误信息里用）。 */
  readonly packageName: string;
  create(input: MongoConnectInput): Promise<MongoDriverHandle>;
}

/** 默认（也是 v1 唯一）驱动：官方 `mongodb`。 */
export const DEFAULT_MONGO_DRIVER: MongoDriverName = 'mongodb';

const IMPLS: Record<MongoDriverName, MongoDriverImpl> = {
  mongodb: { name: 'mongodb', packageName: 'mongodb', create: createMongoHandle },
};

/** 驱动名 → 实现；不认识的名字**明确报错**（不静默用默认驱动）。 */
export function resolveMongoDriver(name: MongoDriverName | string): MongoDriverImpl {
  const impl = IMPLS[name as MongoDriverName];
  if (impl === undefined) {
    throw new DbConfigError(`unknown mongodb driver "${String(name)}": expected one of ${Object.keys(IMPLS).join(', ')}`);
  }
  return impl;
}

export { createMongoHandle, mongoPoolOptions };
export type { MongoConnectInput };
