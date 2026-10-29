import { ResourceConfigError } from './errors.ts';
import { supervise, type ManagedResource, type SupervisionEvent, type SupervisionOptions } from './managed.ts';
import type { BaseConnection } from './pool.ts';
import type { ResourceAdapter } from './adapter.ts';

/**
 * **把适配器接进应用**（结构化 PluginSpec，不 import `@actor/app`）。
 *
 * 一个实例 = 一个插件名：配置落在 `plugins.<name>.*`（环境变量 `APP_PLUGINS__<NAME>__KEY`），
 * 客户端注册成同名服务（控制器里 `ctx.get('cache')`），停机时优雅关闭。
 * 多实例就是多个不同 name 的插件：
 *
 * ```ts
 * plugins: [
 *   resourceAdapter(redisAdapter(), { name: 'cache' }),
 *   resourceAdapter(redisAdapter({ prefix: 'queue:' }), { name: 'queue' }),
 * ]
 * ```
 *
 * 与 `@actor/app` 的关系：这里只依赖**结构**（`config.get` / `provide` / 生命周期钩子），
 * 所以 core 不需要依赖应用层，用户自装的适配器也能用同一套接线。
 */
export interface AdapterPluginApp {
  config: { get<T>(key: string): T };
  /** 注册服务：控制器里 `ctx.get(name)` 就能拿到客户端。 */
  provide?(name: string, value: unknown): void;
  get?<T>(name: string): T;
}

/** `resourceAdapter()` 的返回值：PluginSpec 形状（`@actor/app` 的 PluginSpec 恰好也是这个形状）。 */
export interface AdapterPluginSpec {
  name: string;
  config: Record<string, unknown>;
  onReady(app: AdapterPluginApp): Promise<void>;
  onStopping(app: AdapterPluginApp): Promise<void>;
}

export interface AdapterPluginOptions<Conn extends BaseConnection = BaseConnection> {
  /** 插件名 / 配置节名 / 服务名（默认 = 适配器的 kind）。 */
  name?: string;
  /** 直接给连接配置（不给则从配置节读 `url`）。 */
  connection?: Conn;
  /** 池参数（不给则从配置节读 `connectTimeoutMs` 之类的默认值）。 */
  pool?: SupervisionOptions<Conn>['pool'];
  /** 是否要求连接后必须健康（默认 true：连不上就启动失败，不静默降级）。 */
  requireHealthy?: boolean;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
  /** 生命周期事件（connecting/connected/health_failed/driver_event/draining/closed）→ 日志/指标。 */
  onEvent?: (event: SupervisionEvent) => void;
  /** 额外包进 supervise 的选项（探活/保活/drain）。 */
  supervision?: Omit<SupervisionOptions<Conn>, 'connection' | 'pool' | 'logger' | 'onEvent'>;
}

/** 从配置节读一个值（缺了用兜底）。 */
function readConfig<T>(app: AdapterPluginApp, key: string, fallback: T): T {
  try {
    const value = app.config.get<T>(key);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 把适配器包成一个应用插件（连接/注册/关闭都由它负责）。 */
export function resourceAdapter<C = unknown, Conn extends BaseConnection = BaseConnection>(
  adapter: ResourceAdapter<C, Conn>,
  options: AdapterPluginOptions<Conn> = {},
): AdapterPluginSpec {
  const name = options.name ?? adapter.kind;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ResourceConfigError(`resourceAdapter("${adapter.kind}"): name must be a non-empty string`);
  }
  const configKey = `plugins.${name}`;
  let resource: ManagedResource<C> | null = null;

  return {
    name,
    config: adapter.config ?? { url: { type: 'string' as const, default: '' } },

    async onReady(app: AdapterPluginApp): Promise<void> {
      const url = readConfig<string>(app, `${configKey}.url`, '');
      // 适配器声明的每个配置键都必须真的被读取；否则 `prefix`/`driver`/`database` 这类
      // 配置会“被 schema 接受、被实现忽略”（静默失效）。
      const declared = adapter.config ?? { url: { type: 'string' as const, default: '' } };
      const extra: Record<string, unknown> = {};
      for (const key of Object.keys(declared)) {
        if (key === 'url' || key === 'connectTimeoutMs') continue;
        const value = readConfig<unknown>(app, `${configKey}.${key}`, undefined);
        if (value !== undefined && value !== null && value !== '') extra[key] = value;
      }
      const base = adapter.connectionFromUrl !== undefined && url !== '' ? adapter.connectionFromUrl(url) : ({} as Conn);
      const connection = options.connection ?? ({ ...base, ...extra } as Conn);
      const pool = options.pool ?? { connectionTimeoutMs: readConfig<number>(app, `${configKey}.connectTimeoutMs`, 10_000) };

      resource = supervise(adapter, {
        connection,
        pool,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        ...(options.supervision ?? {}),
      });

      await resource.connect(); // 连不上就启动失败
      if (options.requireHealthy !== false) {
        await resource.checkHealth().catch((err: unknown) => {
          throw new ResourceConfigError(
            `resourceAdapter("${name}"): database is not healthy: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      app.provide?.(name, await resource.acquire());
      app.provide?.(`${name}:resource`, resource);
      // 注册表：诊断路由（/__debug/health）据此发现所有受管资源，不需要知道谁注册过
      let registry: Array<{ name: string; resource: unknown }> = [];
      try {
        registry = app.get?.<Array<{ name: string; resource: unknown }>>('@actor/resource:registry') ?? [];
      } catch {
        registry = [];
      }
      app.provide?.('@actor/resource:registry', [...registry, { name, resource }]);
    },

    async onStopping(): Promise<void> {
      const current = resource;
      resource = null;
      if (current !== null) await current.close();
    },
  };
}

// --- 兼容别名（同一函数对象）------------------------------------------------
export { resourceAdapter as databaseAdapter };
