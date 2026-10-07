/**
 * 与中间件无关的"池"契约。
 *
 * SQL 形状的 `Row`/`Runner`/`DriverPool`/`DriverFactory` **不在这里**（它们留在 `@actor/db-core`）：
 * 本包只描述"任何受管资源都有的东西"——连接形状与池参数。
 */

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

/** 规范化后的连接配置（各适配器在此基础上加自己的字段，例如 SQL 的 `dialect`、Redis 的 `tls`）。 */
export interface BaseConnection {
  /** 适配器 kind（'sql' | 'redis' | 'mongodb' | 用户自定义）。 */
  readonly kind?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** 文件型资源（sqlite、json 文件…）。 */
  filename?: string;
  /** 原始 DSN（**不用于日志**）。 */
  url?: string;
}
