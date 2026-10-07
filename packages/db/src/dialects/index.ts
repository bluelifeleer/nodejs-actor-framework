import { DbConfigError } from '../errors.ts';
import { mysql } from './mysql.ts';
import { pgsql } from './pgsql.ts';
import { sqlite } from './sqlite.ts';
import type { Dialect, DialectSpec } from './types.ts';

/**
 * 方言描述符注册表。
 *
 * **加方言 = 加一个文件 + 在这里加一行**（其余代码不用动，门禁测试盯着这一点）。
 * 注意命名：公开的 `DIALECTS` 是 `readonly Dialect[]`（保持不变），注册表是 `DIALECT_SPECS`。
 */
export const DIALECT_SPECS: Record<Dialect, DialectSpec> = { pgsql, mysql, sqlite };

/** 取一个方言的描述符；未知方言**明确报错**（不静默当成某一个）。 */
export function dialectSpec(dialect: Dialect): DialectSpec {
  const spec = DIALECT_SPECS[dialect as Dialect];
  if (spec === undefined) {
    throw new DbConfigError(`unknown dialect "${String(dialect)}": expected one of ${Object.keys(DIALECT_SPECS).join(', ')}`);
  }
  return spec;
}

export type { Dialect, DialectSpec, ColumnTypeOptions, LogicalType, NormalizedConnection, TypeRenderers } from './types.ts';
