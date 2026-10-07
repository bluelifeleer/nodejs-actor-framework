import { timingSafeEqual } from 'node:crypto';

import { DbConfigError } from '@actor/resource';

import { HttpError, reply } from './context.ts';
import { defineWebPlugin, type WebPluginSpec } from './plugins.ts';
import { defineController } from './controller.ts';
import { defineRoutes, get } from './routes.ts';
import { flattenRoutes } from './router.ts';
import type { Route } from './routes.ts';

/**
 * **诊断路由**（`/__debug/*`）：默认**关闭**；开启需要 token；`NODE_ENV=production` 下**拒绝启动**
 * （除非显式 `allowInProduction: true`）。
 *
 * | 路由 | 作用 |
 * |---|---|
 * | `GET /__debug/routes` | 路由表（方法/模式/中间件阶段） |
 * | `GET /__debug/health` | 聚合各**受管资源**的 `stats()`；`?check=1` 时再跑 `checkHealth()` |
 * | `GET /__debug/config` | 只出 schema 与"已设置"标记，**值一律打码** |
 */
export interface DebugPluginOptions {
  /** 默认 false：不显式打开就没有这些路由。 */
  enabled?: boolean;
  /** 访问令牌（`x-debug-token` 头或 `?token=`）。开启时必须给。 */
  token?: string;
  /** 生产环境也允许开启（必须显式承认；会打日志）。 */
  allowInProduction?: boolean;
  /** 路由前缀（默认 `/__debug`）。 */
  prefix?: string;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

interface ManagedResourceLike {
  readonly kind?: string;
  readonly state?: string;
  stats?(): Record<string, unknown> | null;
  checkHealth?(): Promise<void>;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // 仍然做一次比较，避免"长度即答案"的额外信号
    return false;
  }
  return timingSafeEqual(a, b);
}

export function debugPlugin(options: DebugPluginOptions = {}): WebPluginSpec {
  const enabled = options.enabled === true;
  if (!enabled) {
    // 关闭时也返回一个"什么都不做"的插件（调用方不用改代码结构）
    return defineWebPlugin({ name: 'debug', routes: [] });
  }
  if (typeof options.token !== 'string' || options.token.length < 16) {
    throw new DbConfigError('debugPlugin: 开启诊断路由必须提供至少 16 字符的 token');
  }
  const production = process.env['NODE_ENV'] === 'production';
  if (production && options.allowInProduction !== true) {
    throw new DbConfigError(
      'debugPlugin: 生产环境默认拒绝开启诊断路由（会暴露路由表/配置形状/依赖状态）；' +
        '确实需要就显式 allowInProduction: true',
    );
  }
  if (production) options.logger?.('debug_routes_enabled_in_production', {});

  const prefix = (options.prefix ?? '/__debug').replace(/\/$/, '');
  // 路由处理器需要 app：在 onReady 里抓一份（只读用途）
  let appRef: { routes: readonly unknown[]; config: { get<T>(key: string): T; all(): Record<string, unknown> }; get<T>(name: string): T } | null = null;

  const readRegistry = (): Array<{ name: string; resource: ManagedResourceLike }> => {
    try {
      const list = appRef?.get<Array<{ name: string; resource: ManagedResourceLike }>>('@actor/resource:registry');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  const routes = defineRoutes([
    get(`${prefix}/routes`, defineController({ async handle(): Promise<unknown> {
      const flattened = flattenRoutes(appRef?.routes ?? []);
      return {
        routes: flattened.entries.map((entry) => ({
          method: entry[0],
          pattern: entry[1],
          middleware: (entry[3] ?? []).map((item) => {
            const phased = item as { phase?: string; name?: string };
            return phased.phase ?? phased.name ?? 'pre';
          }),
        })),
        issues: flattened.issues.map((issue) => issue.message),
      };
    } })),

    get(`${prefix}/health`, defineController({ async handle(_input, ctx): Promise<unknown> {
      // 从 query 读（`input` 是"校验后的输入"，没声明过的键不会出现在里面）
      const deep = String(ctx.qs('check') ?? '') === '1';
      const resources = readRegistry();
      const report = [];
      for (const item of resources) {
        let check: string | null = null;
        if (deep && typeof item.resource.checkHealth === 'function') {
          try {
            await item.resource.checkHealth();
            check = 'ok';
          } catch (err) {
            check = err instanceof Error ? err.message : String(err);
          }
        }
        report.push({
          name: item.name,
          kind: item.resource.kind ?? null,
          state: item.resource.state ?? null,
          stats: typeof item.resource.stats === 'function' ? item.resource.stats() : null,
          ...(deep ? { check } : {}),
        });
      }
      return { resources: report, count: report.length, deep };
    } })),

    get(`${prefix}/config`, defineController({ async handle(): Promise<unknown> {
      // 走**有效配置**（`config.all()`，各插件配置节都在里面）。注意它含 schema 默认值，
      // 所以这里的 `default: true` 表示"这一项的值等于声明里的默认值"（能算的只有这个，
      // 框架不保留"用户是否显式写过"的信息 —— 如实标注，不假装知道）。
      const effective = ((): Record<string, unknown> => {
        try {
          return (appRef as unknown as { config: { all(): Record<string, unknown> } }).config.all();
        } catch {
          return {};
        }
      })();
      const walk = (node: Record<string, unknown>, path: string): Array<Record<string, unknown>> => {
        const out: Array<Record<string, unknown>> = [];
        for (const [key, value] of Object.entries(node)) {
          const full = path === '' ? key : `${path}.${key}`;
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            out.push(...walk(value as Record<string, unknown>, full));
            continue;
          }
          out.push({
            key: full,
            type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
            // **值一律打码**：诊断路由给的是形状，不是内容
            value: '[redacted]',
          });
        }
        return out;
      };
      return { source: 'effective-config（含 schema 默认值）', entries: walk(effective, '') };
    } })),
  ]);

  return defineWebPlugin({
    name: 'debug',
    routes: routes as unknown as readonly Route[],
    middleware: [
      {
        name: 'debug-token',
        phase: 'pre',
        handler: async (ctx, next) => {
          if (!ctx.path.startsWith(prefix)) return next();
          const header = ctx.header('x-debug-token');
          const query = String((ctx.qs as unknown as (key: string) => unknown)?.('token') ?? '');
          const provided = header ?? query;
          if (provided === undefined || !safeEqual(provided, options.token as string)) {
            options.logger?.('debug_access_denied', { path: ctx.path, requestId: ctx.requestId });
            throw new HttpError(401, 'unauthorized', undefined, { 'www-authenticate': 'Bearer' });
          }
          return next();
        },
      },
    ],
    onReady: (app) => {
      appRef = app as unknown as typeof appRef;
    },
  });
}

void reply;
