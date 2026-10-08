/**
 * HTTP 入口插件（M2 第 3 步）：node:http，零依赖。
 *
 * 生命周期落点（docs/design/m2-web-layer.md §3）：
 *   onReady    —— Actor 已 spawn、模块 onStart 已完成 → 此时才 listen（start() 返回即端口就绪）
 *   onStopping —— 停止流程第一步：停收新请求 + 等在途请求（有界），然后才让内核收尾
 *   teardown   —— 兜底关闭
 */

import http from 'node:http';

import type { Application, PluginSpec } from '@actor/app';

import { dispatch } from './controller.ts';
import type { Middleware } from './middleware.ts';
import {
  duplicatePrefixOwners,
  inReservedPrefix,
  pluginPrefixCollisions,
  RESERVED_PREFIX_OWNERS,
  type HeaderValue,
} from './context.ts';
import { createRequestLogger, type LogSink } from './logging.ts';
import { WEB_CONTEXT_HOOKS_SERVICE } from './plugins.ts';
import { STREAM_ROUTES_SERVICE } from './upload/plugin.ts';
import { buildRouteTable, type HttpMethod, type Route, reservedPrefixIssues } from './routes.ts';
import { flattenRoutes } from './router.ts';

export interface HttpPluginOptions {
  port?: number;
  host?: string;
  maxBodyBytes?: number;
  /** 日志出口（`(event, meta) => void`）；给了就把请求级子日志放进 `ctx.log`。 */
  logger?: LogSink;
  /** 停止时等待在途请求的上限（毫秒）。 */
  shutdownTimeoutMs?: number;
  /** 是否记录访问日志（默认 true，也可由 plugins.http.accessLog 配置）。 */
  accessLog?: boolean;
  /** 超过该耗时（毫秒）的请求在访问日志里标记 SLOW（默认 500）。 */
  slowMs?: number;
}

export interface HttpPlugin extends PluginSpec {
  /** 实际监听地址（端口传 0 时尤其有用）。 */
  address(): { host: string; port: number } | null;
}

function readSchema() {
  return {
    port: { type: 'number' as const, default: 9000, min: 0 },
    host: { type: 'string' as const, default: '127.0.0.1' },
    maxBodyBytes: { type: 'number' as const, default: 1024 * 1024, min: 1 },
    shutdownTimeoutMs: { type: 'number' as const, default: 5000, min: 1 },
    accessLog: { type: 'boolean' as const, default: true },
    slowMs: { type: 'number' as const, default: 500, min: 0 },
  };
}

/** 读插件注册的"流式路径"匹配器（没有就 null）。 */
function readStreamMatcher(app: { get?<T>(name: string): T }): ((method: string, path: string) => boolean) | null {
  try {
    const matcher = app.get?.<((method: string, path: string) => boolean) | undefined>(STREAM_ROUTES_SERVICE);
    return typeof matcher === 'function' ? matcher : null;
  } catch {
    return null;
  }
}

/** 读插件注册的 context 钩子（没有就空数组；服务不存在不是错误）。 */
function readContextHooks(app: {
  get?<T>(name: string): T;
}): readonly ((ctx: Record<string, unknown>) => Record<string, unknown> | undefined)[] {
  try {
    const hooks = app.get?.<readonly ((ctx: Record<string, unknown>) => Record<string, unknown> | undefined)[]>(
      WEB_CONTEXT_HOOKS_SERVICE,
    );
    return Array.isArray(hooks) ? hooks : [];
  } catch {
    return [];
  }
}

export function httpPlugin(options: HttpPluginOptions = {}): HttpPlugin {
  let server: http.Server | null = null;
  let bound: { host: string; port: number } | null = null;
  let inFlight = 0;
  let draining: (() => void) | null = null;

  const plugin = {
    name: 'http',
    framework: true,
    config: readSchema(),
    async onReady(app: Application) {
      const config = app.config;
      const port = options.port ?? config.get<number>('plugins.http.port');
      const host = options.host ?? config.get<string>('plugins.http.host');
      const maxBodyBytes = options.maxBodyBytes ?? config.get<number>('plugins.http.maxBodyBytes');
      // 模块声明的是"路由元组"（defineRoutes/get/post... 的产物），这里解析成路由表：
      // 非法模式、重复路由、input 键未声明等启动期问题都在此一次性报出。
      const flattened = flattenRoutes(app.routes);
      const { routes, issues } = buildRouteTable(flattened.entries as never);
      issues.unshift(...flattened.issues);
      // 框架保留前缀（唯一来源 RESERVED_ROUTE_PREFIXES / RESERVED_PREFIX_OWNERS）：撞名字不是"模式重复"，
      // 所以路由表检查发现不了 —— 这里显式拦住，延续"响亮失败优于静默覆盖"。
      // ① 插件层：第三方插件不许把自己声明的前缀与保留区重叠（这一层归属明确，判得准）；
      // ② 路由层：**模块/路由器**路由落在保留区 → 报错。插件路由不带归属信息（RouteMeta 只记模块/路由器名），
      //    所以那一半交给①去判 —— 这里显式只查带归属的路由，而不是"猜不了就放过"。
      for (const collision of pluginPrefixCollisions(app.plugins ?? [])) {
        issues.push({
          message:
            `插件 '${collision.owner}' 声明的路由前缀 "${collision.prefix}" 与框架保留前缀 ` +
            `"${collision.reserved}" 重叠 —— 这片命名空间由内置插件占用，请换一个前缀`,
        });
      }
      for (const duplicate of duplicatePrefixOwners(app.plugins ?? [])) {
        issues.push({
          message:
            `路由前缀 "${duplicate.prefix}" 被多个插件声明占用（${duplicate.owners.join(' / ')}）—— ` +
            `同一片命名空间只能有一个主人，请给其中一个换 routePrefix/prefix`,
        });
      }
      issues.unshift(
        ...reservedPrefixIssues(
          flattened.entries.filter((entry) => {
            const meta = entry[4] as { module?: string; router?: string } | undefined;
            return meta?.module !== undefined || meta?.router !== undefined;
          }) as never,
          RESERVED_PREFIX_OWNERS,
          inReservedPrefix,
        ),
      );
      if (issues.length > 0) {
        throw new Error(
          `路由配置有问题（${issues.length} 项）：\n` + issues.map((i) => `  - ${i.message}`).join('\n'),
        );
      }

      const accessLog = options.accessLog ?? config.get<boolean>('plugins.http.accessLog');
      const slowMs = options.slowMs ?? config.get<number>('plugins.http.slowMs');
      // 插件级 logger（给了就优先于应用统一出口）
      const pluginLogger = options.logger;
      // console 兜底只在"应用没配统一出口"时走到（见下面各处的 app.logSink === null 判断）

      server = http.createServer((req, res) => {
        inFlight += 1;
        const startedAt = Date.now();
        const finish = (): void => {
          inFlight -= 1;
          if (inFlight === 0) draining?.();
        };
        void (async () => {
          try {
            // 流式路由（上传/分片）：**不缓冲**，把原始流交给 handler 自己消费
            const pathOnly = String(req.url ?? '/').split('?')[0] ?? '/';
            const isStreaming = readStreamMatcher(app)?.(req.method ?? 'GET', pathOnly) === true;

            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of (isStreaming ? [] : req)) {
              const buf = chunk as Buffer;
              size += buf.length;
              if (size > maxBodyBytes) {
                res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: { status: 413, message: 'payload too large' } }));
                return;
              }
              chunks.push(buf);
            }
            const raw = isStreaming ? '' : Buffer.concat(chunks).toString('utf8');
            const contentType = String(req.headers['content-type'] ?? '');
            let body: unknown = raw.length > 0 ? raw : undefined;
            if (raw.length > 0 && contentType.includes('application/json')) {
              try {
                body = JSON.parse(raw) as unknown;
              } catch {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: { status: 400, message: 'invalid JSON body' } }));
                return;
              }
            }

            const result = await dispatch({
              routes,
              middleware: app.middleware as readonly Middleware[],
              ...(isStreaming ? { stream: req as unknown as AsyncIterable<Uint8Array> } : {}),
              request: {
                method: req.method ?? 'GET',
                url: req.url ?? '/',
                headers: req.headers as Record<string, HeaderValue>,
                ...(body === undefined ? {} : { body }),
              },
              actor: (name: string) => app.actor(name),
              get: (name: string) => app.get(name),
              config: app.config,
              // 插件声明的 context 钩子（defineWebPlugin({ context }) → 服务）
              contextHooks: readContextHooks(app),
              // 请求级子日志：优先级 = 插件 logger > 应用统一出口（`app.logSink`）> console 兜底
              // （早先这里是硬编码的 console 对象，与上面的 log 是重复键，会把子日志覆盖掉）
              log: createRequestLogger(
                pluginLogger ??
                  (app.logSink === null ? undefined : (event, meta) => app.logSink?.('http', `http:${event}`, meta)),
                {
                  requestId: String(req.headers['x-request-id'] ?? ''),
                  method: req.method ?? 'GET',
                  path: String(req.url ?? '/'),
                },
              ),
              // 5xx 必须在服务端可见：转成应用事件（由使用者决定怎么记日志）
              onError: (error, info) => {
                app.emit('http:error', {
                  requestId: info.requestId,
                  status: info.status,
                  path: info.route?.path ?? null,
                  method: info.route?.method ?? null,
                  error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
                });
              },
            });

            const headers: Record<string, string> = { ...result.response.headers };
            headers['content-type'] = result.response.contentType;
            // 追踪 id 回写：客户端/网关可用它把一次请求与日志串起来
            headers['x-request-id'] = result.requestId;
            res.writeHead(result.response.status, headers);
            // HEAD：响应头照常，但不发送 body（标准行为）
            if (result.response.body === null || result.headOnly) res.end();
            else res.end(result.response.body);

            // 事件总线：订阅者（如 requestLogPlugin）据此记录/转发，订阅者抛错不影响请求
            app.emit('http:request', {
              method: req.method ?? 'GET',
              path: req.url ?? '/',
              status: result.response.status,
              ms: Date.now() - startedAt,
              requestId: result.requestId,
              // 结构化字段：流式请求的 bytesIn 无从直接统计（没缓冲）→ 如实省略
              ...(isStreaming ? {} : { bytesIn: size }),
              bytesOut: typeof result.response.body === 'string' ? Buffer.byteLength(result.response.body) : (result.response.body?.byteLength ?? 0),
              ...(result.userId === undefined ? {} : { userId: result.userId }),
            });

            if (accessLog) {
              const elapsed = Date.now() - startedAt;
              const slow = elapsed >= slowMs ? ' SLOW' : '';
              const line =
                `[http] ${req.method ?? 'GET'} ${req.url ?? '/'} ${String(result.response.status)} ` +
                `${String(elapsed)}ms rid=${result.requestId}${slow}`;
              // 有统一出口就走它（结构化：event=http:request），否则保持原样打到 console
              // console-ok: 应用没配 logging.logger 时的兜底（配了就走 http:request）
              if (app.logSink === null) console.log(line);
              else {
                app.logSink('http', 'http:request', {
                  method: req.method ?? 'GET',
                  path: req.url ?? '/',
                  status: result.response.status,
                  ms: elapsed,
                  requestId: result.requestId,
                  ...(result.userId === undefined ? {} : { userId: result.userId }),
                  slow: elapsed >= slowMs,
                });
              }
            }
          } catch (error) {
            // 500 必须留痕：响应里不含细节（安全），但服务端日志要能定位
            // console-ok: 兜底 —— 5xx 必须留痕，配了统一出口就走 http:handler_error
            if (app.logSink === null) console.error('[http] handler error:', error);
            else app.logSink('http', 'http:handler_error', { error: error instanceof Error ? error.message : String(error) });
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { status: 500, message: 'internal error' } }));
            void error;
          } finally {
            finish();
          }
        })();
      });

      await new Promise<void>((resolve) => server?.listen(port, host, () => resolve()));
      // 注册 server 服务：wsPlugin 在“共享端口”模式下用它附加 upgrade（必须在 listen 之后，
      // 否则 provide 出去的是尚未创建的 null）
      app.provide('httpServer', server);
      const addr = server.address();
      bound = typeof addr === 'object' && addr !== null ? { host, port: addr.port } : null;
      // console-ok: 兜底 —— 配了统一出口就走 plugin:http_listening
      if (app.logSink === null) console.log(`[@actor/web] http listening on ${host}:${String(bound?.port)}`);
      else app.logSink('plugin', 'plugin:http_listening', { host, port: bound?.port ?? null });
    },
    async onStopping(app: Application) {
      if (!server) return;
      const config = app.config;
      const timeoutMs = options.shutdownTimeoutMs ?? config.get<number>('plugins.http.shutdownTimeoutMs');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server?.closeAllConnections?.();
          resolve();
        }, timeoutMs);
        draining = () => {
          clearTimeout(timer);
          resolve();
        };
        server?.close(() => {
          clearTimeout(timer);
          draining = null;
          resolve();
        });
        server?.closeIdleConnections?.();
        if (inFlight === 0) draining?.();
      });
      server = null;
      bound = null;
    },
    async teardown() {
      if (server) {
        server.closeAllConnections?.();
        server = null;
        bound = null;
      }
    },
  };
  // address 需要在 listen 之后才能给出真实端口，因此在这里补齐（而不是对象字面量里）
  return Object.assign(plugin, { address: () => bound }) as HttpPlugin;
}
