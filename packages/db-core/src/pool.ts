/**
 * 与数据库无关的"运行/池"契约。
 *
 * `Runner` 是"能执行语句"的最小形状（SQL 用它；KV/文档适配器可以用自己的客户端面），
 * 它与 `@actor/data` 的 `SqlRunner` **结构兼容**（不互相 import）—— 这条纪律 M7a 保持不变。
 */

/** 一行结果（列名 → 值）。 */
export type Row = Record<string, unknown>;

/** 能执行语句的最小形状（事务内的 runner 也是它）。 */
export interface Runner {
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  run(sql: string, params?: readonly unknown[]): Promise<number>;
  transaction?<R>(fn: (scoped: Runner) => Promise<R>): Promise<R>;
  /** 执行 INSERT 并返回数据库生成的列（自增主键回读用）。不支持就别实现。 */
  insertReturning?(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}

/** 池参数（框架统一形状；映射到各驱动真实字段由驱动/适配器负责）。 */
export interface PoolOptions {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/** 统一形状 → 驱动字段名（没给的键不出现：严格模式下不能塞 undefined）。 */
export function mapPoolOptions(
  options: PoolOptions,
  mapping: Partial<Record<keyof PoolOptions, string>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['min', 'max', 'idleTimeoutMs', 'connectionTimeoutMs'] as const) {
    const target = mapping[key];
    const value = options[key];
    if (target === undefined || value === undefined) continue;
    result[target] = value;
  }
  return result;
}

/** 规范化后的连接配置（各适配器在此基础上加自己的字段，例如 SQL 的 `dialect`）。 */
export interface BaseConnection {
  /** 适配器 kind（'sql' | 'redis' | 'mongodb' | 用户自定义）。 */
  readonly kind?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** 文件型资源（sqlite 等）。 */
  filename?: string;
  /** 原始 DSN（**不用于日志**）。 */
  url?: string;
}

/** 驱动池：既能执行语句，也能自检与关闭。 */
export interface DriverPool<C extends BaseConnection = BaseConnection> extends Runner {
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  stats?(): Record<string, unknown> | null;
  /** 驱动的连接对象（新适配器用；SQL 侧可不实现）。 */
  readonly connection?: C;
}

/** 驱动工厂：`create` 里做懒加载/建池。 */
export interface DriverFactory<C extends BaseConnection = BaseConnection> {
  /** 驱动名（用于错误信息，如 `pg` / `mysql2` / `node:sqlite`）。 */
  readonly name: string;
  create(connection: C, pool: PoolOptions, kind: string): Promise<DriverPool<C>>;
}
