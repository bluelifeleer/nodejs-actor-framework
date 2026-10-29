/**
 * WebSocket 入口插件（M2）。
 *
 * 复用内核的**零依赖** ws-server；路由复用同一套模式语法与启动期检查。
 * 控制器语义与 HTTP 一致：**每条消息触发一次 handle**，状态归 Actor（`ctx.actor` 桥梁不变），
 * 于是"连接在框架、状态在 Actor"。
 */

import { createRequire } from 'node:module';

import type { Application, ConfigSchema, PluginSpec } from '@actor/app';
import { validateValues } from '@actor/app';
import { orderMiddleware, WEB_CONTEXT_HOOKS_SERVICE } from './plugins.ts';

// 内核是 CJS 包，`ops` 用 module.exports 导出：ESM 具名导入在**类型层面**看不到这些名字。
// 用 createRequire 保持与内核一致的 CJS 取值语义（运行时复用其零依赖 ws-server）。
//
// 用**公开子路径** `nodejs-actor-framework/ops`（不是 `.../src/ops/index.ts`）：
// 后者在消费者机器上会命中 Node 的 "不允许对 node_modules 里的 .ts 做类型剥离" ——
// 仓库内一切正常、装成包就崩（这条是"打包 → 真装 → 真跑"的门禁抓出来的）。
const require = createRequire(import.meta.url);
interface KernelWebSocketServer {
  port: number;
  on(event: string, listener: (...args: never[]) => void): void;
  listen(): Promise<unknown>;
  close?(): void;
}
const { WebSocketServer } = require('nodejs-actor-framework/ops') as {
  WebSocketServer: new (options: Record<string, unknown>) => KernelWebSocketServer;
};

import { toErrorResponse, toResponse, createRequestContext, inReservedPrefix, RESERVED_PREFIX_OWNERS, type HeaderValue } from './context.ts';
import { createConnectionRegistry, type MutableConnectionRegistry, type WsConnection } from './connections.ts';
import { composeMiddleware, type Middleware } from './middleware.ts';
import { buildRouteTable, matchRoute, reservedPrefixIssues, type Route, type RouteMethod } from './routes.ts';
import { flattenRoutes } from './router.ts';

export interface WsPluginOptions {
  port?: number;
  host?: string;
  maxPayloadBytes?: number;
  shutdownTimeoutMs?: number;
  /**
   * 共享 HTTP 端口时，实际的绑定地址来自 HTTP server，而不是这里的 `host`。
   * 若 HTTP 绑在非回环地址且 WS 没有 TLS/verifyClient，内核会拒绝启动；
   * 仅在明确接受"无认证入口"时才设 `allowInsecureBinding: true`。
   */
  allowInsecureBinding?: boolean;
  /** 升级前鉴权（token/Origin 白名单等）。共享端口时同样生效。 */
  verifyClient?: (req: unknown) => boolean | Promise<boolean>;
  /** 连接建立后解析玩家标识（用于 wsConnections.byPlayer 与连接 id）。 */
  identify?: (request: { url?: string; headers?: Record<string, unknown> } | undefined) => string | null;
}

export interface WsPlugin extends PluginSpec {
  address(): { host: string; port: number } | null;
}

interface WsSocket {
  send(data: unknown, options?: { binary?: boolean }): boolean;
  sendJson(value: unknown): boolean;
  close(code?: number, reason?: string): void;
  destroy?(): void;
  on(event: string, listener: (...args: never[]) => void): void;
}

function isControllerSpec(
  value: unknown,
): value is { input?: ConfigSchema; middleware?: readonly Middleware[]; handle: (...args: never[]) => unknown } {
  return typeof value === 'object' && value !== null && 'handle' in (value as Record<string, unknown>);
}

async function handleMessage(
  app: Application,
  wsRoutes: readonly Route[],
  appMiddleware: readonly Middleware[],
  socket: WsSocket,
  request: { url?: string; headers?: Record<string, HeaderValue> } | undefined,
  data: unknown,
  isBinary: boolean,
): Promise<void> {
  const url = typeof request?.url === 'string' ? request.url : '/';
  const [rawPath = '/', rawQuery = ''] = url.split('?', 2);
  /**
   * `matchRoute` 会对路径段做 `decodeURIComponent`；畸形百分号编码（例如 `/%E0%A4%A`）
   * 会抛 `URIError`。这里是远程输入，必须当作 400 处理，而不是让异常逃出消息回调
   * （Node 会把未处理 rejection 当致命错误，一条消息就能打崩进程）。
   */
  let match: ReturnType<typeof matchRoute>;
  try {
    match = matchRoute(wsRoutes, { method: 'WS' satisfies RouteMethod, url });
  } catch {
    socket.sendJson({ error: { status: 400, message: `invalid websocket url: ${rawPath}` } });
    return;
  }
  if (match.kind !== 'matched') {
    socket.sendJson({ error: { status: 404, message: `no ws route for ${rawPath}` } });
    return;
  }

  const { route, params } = match;
  const querySource = new URLSearchParams(rawQuery);
  const declared: Record<string, unknown> = { ...params };
  for (const name of route.queryParams) {
    const value = querySource.get(name);
    if (value !== null) declared[name] = value;
  }
  // 消息体：文本优先按 JSON 解析（与 HTTP 的 JSON body 语义一致）
  let body: unknown = data;
  if (!isBinary && typeof data === 'string') {
    try {
      body = JSON.parse(data) as unknown;
    } catch {
      body = data;
    }
  }
  if (typeof body === 'object' && body !== null) {
    for (const [key, value] of Object.entries(body)) declared[key] ??= value;
  }

  const controller = route.controller as unknown;
  const spec = isControllerSpec(controller) ? controller : { handle: controller as never };
  const ctx = createRequestContext({
    method: 'WS',
    path: rawPath,
    requestId: `ws-${Math.random().toString(36).slice(2, 10)}`,
    params,
    query: Object.fromEntries(querySource),
    headers: request?.headers ?? {},
    body,
    actor: (name: string) => app.actor(name),
    get: (name: string) => app.get(name),
    config: app.config,
    // console-ok: 注入给 WS 控制器的内置 log 默认实现
    log: { info: console.info, warn: console.warn, error: console.error },
  });

  try {
    // 与 HTTP 同一条链：全局 → 路由 → 控制器；阶段排序与 HTTP 一致
    const chain: Middleware[] = orderMiddleware([
      ...appMiddleware,
      ...((route.middleware ?? []) as readonly Middleware[]),
      ...((spec.middleware ?? []) as readonly Middleware[]),
    ]);
    // 插件贡献的上下文钩子（与 HTTP 的 dispatch 同语义）
    const hooks = (() => {
      try {
        return app.get<readonly ((ctx: Record<string, unknown>) => Record<string, unknown> | undefined)[]>(WEB_CONTEXT_HOOKS_SERVICE) ?? [];
      } catch {
        return [];
      }
    })();
    for (const hook of hooks) {
      const values = hook(ctx as unknown as Record<string, unknown>);
      if (values !== undefined && values !== null) ctx.extend(values);
    }
    const result = await composeMiddleware(chain)(ctx, async () => {
      let input: Record<string, unknown> = declared;
      if (spec.input) {
        const { values, issues } = validateValues(spec.input, declared, 'WebSocket 消息');
        if (issues.length > 0) {
          throw new Error(
            `WS_INPUT_INVALID:${JSON.stringify(issues)}`,
          );
        }
        input = values;
      }
      return spec.handle(input as never, ctx as never);
    });
    const response = toResponse(result);
    if (response.body === null) socket.sendJson({ status: response.status });
    else socket.send(response.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('WS_INPUT_INVALID:')) {
      const issues = JSON.parse(message.slice('WS_INPUT_INVALID:'.length)) as unknown;
      socket.sendJson({ error: { status: 400, message: 'input validation failed', details: { issues } } });
      return;
    }
    // console-ok: 兜底 —— WS 控制器抛错必须留痕
    console.error('[ws] handler error:', error);
    socket.send(String(toErrorResponse(error).body));
  }
}

export function wsPlugin(options: WsPluginOptions = {}): WsPlugin {
  const registry: MutableConnectionRegistry = createConnectionRegistry();
  let sequence = 0;
  let server: KernelWebSocketServer | null = null;
  let bound: { host: string; port: number } | null = null;
  const sockets = new Set<WsSocket>();
  let drained: (() => void) | null = null;

  const plugin = {
    name: 'ws',
    framework: true,
    config: {
      // 刻意**不给默认值**（改成可空）：未配置才能与'显式配置'区分，从而决定是否与 HTTP 共享端口；
      // 若既不共享也未配置，运行期回落到 9001。
      port: { type: 'number' as const, min: 0, nullable: true },
      host: { type: 'string' as const, default: '127.0.0.1' },
      maxPayloadBytes: { type: 'number' as const, default: 4 * 1024 * 1024, min: 1 },
      shutdownTimeoutMs: { type: 'number' as const, default: 5000, min: 1 },
    },
    async onReady(app: Application) {
      const configuredPort = options.port ?? app.config.get<number | undefined>('plugins.ws.port');
      const host = options.host ?? app.config.get<string>('plugins.ws.host');

      // 共享端口判定：HTTP 已启用且（ws 端口未配置 或 与 HTTP 端口相同）→ 附加到 HTTP server
      let sharedServer: { address(): unknown } | null = null;
      try {
        sharedServer = app.get<{ address(): unknown }>('httpServer');
      } catch {
        sharedServer = null; // 未启用 HTTP 入口
      }
      const httpPort = (() => {
        const address = sharedServer?.address();
        return typeof address === 'object' && address !== null ? (address as { port: number }).port : null;
      })();
      const share =
        sharedServer !== null && (configuredPort == null || configuredPort === httpPort);
      const port = share ? 0 : (configuredPort ?? 9001);
      // 共享模式下真正对外的是 HTTP server 的绑定地址；用配置里的 host 做安全判断
      // 会让 `httpPlugin({host:'0.0.0.0'}) + wsPlugin()` 静默绕过非回环守卫。
      const sharedAddress = share ? sharedServer?.address() : null;
      const effectiveHost =
        sharedAddress !== null && typeof sharedAddress === 'object' && 'address' in sharedAddress
          ? String((sharedAddress as { address?: unknown }).address)
          : host;
      const maxPayloadBytes = options.maxPayloadBytes ?? app.config.get<number>('plugins.ws.maxPayloadBytes');

      const flattened = flattenRoutes(app.routes);
      const { routes, issues } = buildRouteTable(flattened.entries as never);
      issues.unshift(...flattened.issues);
      // 与 httpPlugin 同一口径：WS 路由也装在保留前缀里就明确报错（两处装的是同一份路由表）
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
      const wsRoutes = routes.filter((route) => route.method === 'WS');

      // path: '*' —— 服务端不限定路径，由本插件的路由表按 URL 分发（每条 ws 路由一个模式）
      // 注册为应用层服务：同一服务内的 HTTP 控制器可用 ctx.get('wsConnections') 推送
      app.provide('wsConnections', registry);

      const wsServer = new WebSocketServer({
        port,
        host: effectiveHost,
        maxPayloadBytes,
        path: '*',
        ...(options.allowInsecureBinding === true ? { allowInsecureBinding: true } : {}),
        ...(options.verifyClient === undefined ? {} : { verifyClient: options.verifyClient }),
        ...(share && sharedServer ? { server: sharedServer } : {}),
      });
      server = wsServer;
      wsServer.on('connection', ((socket: WsSocket, request: { url?: string; headers?: Record<string, unknown> }) => {
        sockets.add(socket);
        sequence += 1;
        const identified = options.identify?.(request) ?? null;
        if (identified !== null) (socket as { playerId?: string | null }).playerId = identified;
        const playerId = identified ?? ((socket as { playerId?: unknown }).playerId as string | null | undefined);
        const connection: WsConnection = {
          id: typeof playerId === 'string' && playerId.length > 0 ? playerId : `ws-${String(sequence)}`,
          ...(typeof playerId === 'string' && playerId.length > 0 ? { playerId } : {}),
          path: request?.url ?? '/',
          get readyState(): string {
            return String((socket as { readyState?: unknown }).readyState ?? 'open');
          },
          send: (payload: unknown) =>
            socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)),
          close: (code?: number, reason?: string) => socket.close(code, reason),
        };
        registry.register(connection);
        // 审计 F1：连接上的 error 必须有监听者 —— 否则 `emit('error')` 在无监听者时会抛
        // ERR_UNHANDLED_ERROR，而抛点在 net socket 的 error 回调里，一次 RST 就能打崩整个进程。
        // 这里**显式**记一条日志（而不是静默吞掉），保持"降级可见"。
        socket.on('error', ((err: Error) => {
          app.emit('ws:connection:error', { message: err.message });
        }) as never);
        socket.on('close', (() => {
          registry.unregister(connection.id);
          sockets.delete(socket);
          if (sockets.size === 0) drained?.();
        }) as never);
        /**
         * 每条连接串行处理消息：既保证同一连接内的顺序（聊天/命令协议的基本预期），
         * 也避免单连接堆无限在途 handler。错误逐个兜底，不再用 `void`。
         */
        let messageQueue: Promise<void> = Promise.resolve();
        socket.on('message', ((data: unknown, isBinary: boolean) => {
          messageQueue = messageQueue
            .then(() =>
              handleMessage(app, wsRoutes, app.middleware as readonly Middleware[], socket, request as never, data, isBinary),
            )
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              app.emit('ws:message:error', { message });
              try {
                socket.sendJson({ error: { status: 500, message: 'internal error' } });
                socket.close(1011, 'internal error');
              } catch {
                /* socket 已关闭 */
              }
            });
        }) as never);
      }) as never);

      await wsServer.listen();
      bound = { host, port: wsServer.port };
      if (app.logSink === null) {
        // console-ok: 兜底 —— 配了统一出口就走 plugin:ws_listening
        console.log(
          `[@actor/web] ws listening on ${host}:${String(wsServer.port)}${share ? '（与 HTTP 共享端口）' : ''}`,
        );
      } else {
        app.logSink('plugin', 'plugin:ws_listening', { host, port: wsServer.port, sharedWithHttp: share });
      }
    },
    async onStopping(app: Application) {
      const timeoutMs = options.shutdownTimeoutMs ?? app.config.get<number>('plugins.ws.shutdownTimeoutMs');
      for (const socket of sockets) {
        try {
          socket.close(1001, 'server shutting down');
        } catch {
          /* 连接可能已断开 */
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) {
            try {
              socket.destroy?.();
            } catch {
              /* ignore */
            }
          }
          resolve();
        }, timeoutMs);
        drained = () => {
          clearTimeout(timer);
          resolve();
        };
        server?.close?.();
        if (sockets.size === 0) drained();
      });
      server = null;
      bound = null;
    },
    async teardown() {
      for (const socket of sockets) {
        try {
          socket.destroy?.();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      server = null;
      bound = null;
    },
  };
  return Object.assign(plugin, { address: () => bound }) as WsPlugin;
}
