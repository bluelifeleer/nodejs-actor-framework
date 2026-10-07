import type { Dialect, NormalizedConnection } from '../dialect.ts';

/** 一行查询结果（列名 → 值）。 */
export type Row = Record<string, unknown>;

/**
 * 事务范围内的 runner：与 `@actor/data` 的 `SqlRunner` **结构兼容**（不互相 import），
 * 所以 `@actor/data` 的 `createSqlRepository({ runner })` 可以直接吃它。
 */
export interface Runner {
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  run(sql: string, params?: readonly unknown[]): Promise<number>;
  transaction?<R>(fn: (scoped: Runner) => Promise<R>): Promise<R>;
  /**
   * 执行 INSERT 并返回**数据库生成的列**（自增主键靠它回读）。
   *
   * 约定：pg/sqlite 走 `INSERT … RETURNING`（返回结果行）；mysql 没有 RETURNING，
   * 所以返回 `[{ insertId }]`（由仓储层归一）。驱动不支持时必须**不实现**这个方法，
   * 仓储层会给出明确错误，而不是静默返回一个没有 id 的实体。
   */
  insertReturning?(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}

/** 池参数（框架统一形状；映射到各驱动真实字段由驱动负责）。 */
export interface PoolOptions {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/**
 * 驱动池：每个方言实现这一个接口。框架只认它，不认具体驱动 API。
 *
 * 它同时也是 `Runner`（多一个 healthCheck/close/stats）。
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
