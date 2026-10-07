import { ResourceConfigError } from './errors.ts';
import type { BaseConnection, PoolOptions } from './pool.ts';

/**
 * 数据库适配器契约（设计见 docs/design/m7-multi-database.md §4.1）。
 *
 * 一个适配器只描述"**怎么连**、**怎么用**、**怎么关**"；连接管控（事件、drain、快速失败、
 * 定时健康检查）由 core 的 `supervise()` 统一提供 —— 这就是"框架未定义的库也能被管住"的落点。
 */

/** 连出来的东西：既能"用"（client），也能"管"（health/close/stats）。 */
export interface ManagedConnection<C = unknown> {
  /** 底层客户端/句柄：永远给使用者留逃生通道。 */
  readonly client: C;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  /** 驱动自报的统计；**没有就返回 null**（不要编造池数字）。 */
  stats?(): Record<string, unknown> | null;
  keepAlive?(): Promise<void>;
}

/** 适配器建连时框架交给它的东西。 */
export interface AdapterConnectInput<Conn extends BaseConnection = BaseConnection> {
  readonly connection: Conn;
  readonly pool: PoolOptions;
  /** 诊断日志接缝（与内核同形状）。 */
  readonly logger?: (event: string, meta?: Record<string, unknown>) => void;
  /** 从**应用根**解析驱动（找不到时抛带安装命令的错误）。 */
  readonly load: <T>(specifier: string, packageName?: string) => T;
  /** 驱动自带的重连/错误事件 → 由框架转发成统一的 `driver_event`（框架**不自己重连**）。 */
  readonly emitDriverEvent?: (event: string, detail?: unknown) => void;
}

/** 适配器定义。 */
export interface ResourceAdapter<C = unknown, Conn extends BaseConnection = BaseConnection> {
  /** 适配器类别（'sql' | 'redis' | 'mongodb' | 用户自定义）。 */
  readonly kind: string;
  /** 用户要装的驱动包名（错误信息里用）。 */
  readonly driverPackage: string;
  readonly connectionKind: 'host' | 'file' | 'url';
  /** 自己的配置节 schema（并入应用配置的 `plugins.<插件名>.*`）。 */
  readonly config?: Record<string, unknown>;
  /** DSN → 规范化连接（可选）。 */
  connectionFromUrl?(url: string): Conn;
  /** 只用于日志/错误：**永不含密码**。 */
  describe?(connection: Conn): string;
  connect(input: AdapterConnectInput<Conn>): Promise<ManagedConnection<C>>;
}

/** 定义一个数据库适配器（做必要的校验，避免"少个字段到运行时才发现"）。 */
export function defineResourceAdapter<C = unknown, Conn extends BaseConnection = BaseConnection>(
  spec: ResourceAdapter<C, Conn>,
): ResourceAdapter<C, Conn> {
  if (typeof spec.kind !== 'string' || spec.kind.trim() === '') {
    throw new ResourceConfigError('defineResourceAdapter: "kind" is required (e.g. kind: \'redis\')');
  }
  if (typeof spec.driverPackage !== 'string' || spec.driverPackage.trim() === '') {
    throw new ResourceConfigError(`defineResourceAdapter("${spec.kind}"): "driverPackage" is required`);
  }
  if (spec.connectionKind !== 'host' && spec.connectionKind !== 'file' && spec.connectionKind !== 'url') {
    throw new ResourceConfigError(
      `defineResourceAdapter("${spec.kind}"): connectionKind must be host|file|url (got "${String(spec.connectionKind)}")`,
    );
  }
  if (typeof spec.connect !== 'function') {
    throw new ResourceConfigError(`defineResourceAdapter("${spec.kind}"): "connect" must be a function`);
  }
  return spec;
}

/**
 * 定义一个"受管资源"：不是数据库也能纳入同一套生命周期（消息队列、etcd、对象存储…）。
 *
 * 与 `defineResourceAdapter` 是**同一个契约**（这里只是语义化的别名，让非数据库场景读起来自然）。
 */
export function defineManagedResource<C = unknown, Conn extends BaseConnection = BaseConnection>(
  spec: ResourceAdapter<C, Conn>,
): ResourceAdapter<C, Conn> {
  return defineResourceAdapter(spec);
}

// --- 兼容别名（同一对象/类型；既有使用者不受搬迁影响）----------------------
export type { ResourceAdapter as DatabaseAdapter };
export { defineResourceAdapter as defineDatabaseAdapter };
