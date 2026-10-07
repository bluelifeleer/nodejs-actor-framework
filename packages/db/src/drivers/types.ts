import {
  type PoolOptions as CorePoolOptions,
  type Row as CoreRow,
  type Runner as CoreRunner,
} from '@actor/db-core';
import type { Dialect, NormalizedConnection } from '../dialect.ts';

// 这三个是**通用**契约，单一来源在 @actor/db-core（SQL/Redis/Mongo/自装适配器共用）；
// 这里原样再导出，`@actor/db` 的公开类型与既有导入路径不变。
export type Row = CoreRow;
export type Runner = CoreRunner;
export type PoolOptions = CorePoolOptions;

/**
 * 驱动池：SQL 侧的实现（每个方言一个）。
 *
 * 与 core 的 `DriverPool` 语义相同，但这里是 **SQL 形状**：它同时是 `Runner`，
 * 额外提供健康检查/关闭/统计。
 */
export interface DriverPool extends Runner {
  /** `SELECT 1` 级别的探活；失败即抛。 */
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  /** 池的只读统计（有就给，没有返回 null）。 */
  stats?(): Record<string, unknown> | null;
}

/** 驱动工厂：`create` 里做懒加载/建池。 */
export interface DriverFactory {
  /** 驱动名（用于错误信息，如 `pg` / `mysql2` / `node:sqlite`）。 */
  readonly name: string;
  create(connection: NormalizedConnection, pool: PoolOptions, dialect: Dialect): Promise<DriverPool>;
}
