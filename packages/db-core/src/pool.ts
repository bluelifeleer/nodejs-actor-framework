import type { BaseConnection, PoolOptions } from '@actor/resource';

/**
 * SQL 形状的池与运行契约。
 *
 * 通用的连接形状与池参数在 `@actor/resource`（这里 re-export）；**SQL 专有**的
 * `Row`/`Runner`/`DriverPool`/`DriverFactory` 留在本包 —— 它们说的是"能执行语句"，不是"任何资源"。
 */
export { mapPoolOptions, type BaseConnection, type PoolOptions } from '@actor/resource';

/** 一行查询结果（列名 → 值）。 */
export type Row = Record<string, unknown>;

/** 能执行语句的最小形状（与 `@actor/data` 的 `SqlRunner` 结构兼容）。 */
export interface Runner {
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  run(sql: string, params?: readonly unknown[]): Promise<number>;
  transaction?<R>(fn: (scoped: Runner) => Promise<R>): Promise<R>;
  /** 执行 INSERT 并返回数据库生成的列（自增主键回读用）。不支持就别实现。 */
  insertReturning?(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}

/** 驱动池：能执行语句 + 自检 + 关闭。 */
export interface DriverPool extends Runner {
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  stats?(): Record<string, unknown> | null;
  readonly connection?: BaseConnection;
}

/** 驱动工厂：`create` 里做懒加载/建池。 */
export interface DriverFactory {
  /** 驱动名（用于错误信息，如 `pg` / `mysql2` / `node:sqlite`）。 */
  readonly name: string;
  create(connection: BaseConnection, pool: PoolOptions, kind: string): Promise<DriverPool>;
}
