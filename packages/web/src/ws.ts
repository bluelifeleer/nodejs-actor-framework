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

// 内核是 CJS 包，ops/index 用 module.exports 导出：ESM 具名导入在**类型层面**看不到这些名字。
// 用 createRequire 保持与内核一致的 CJS 取值语义（运行时复用其零依赖 ws-server）。
const require = createRequire(import.meta.url);
interface KernelWebSocketServer {
  port: number;
  on(event: string, listener: (...args: never[]) => void): void;
  listen(): Promise<unknown>;
  close?(): void;
}
const { WebSocketServer } = require('nodejs-actor-framework/src/ops/index.ts') as {
  WebSocketServer: new (options: Record<string, unknown>) => KernelWebSocketServer;
};

import { toErrorResponse, toResponse, createRequestContext, type HeaderValue } from './context.ts';
import { composeMiddleware, type Middleware } from './middleware.ts';
import { buildRouteTable, matchRoute, type ControllerLike, type Route, type RouteMethod } from './routes.ts';

export interface WsPluginOptions {
  port?: number;
  host?: string;
  maxPayloadBytes?: number;
  shutdownTimeoutMs?: number;
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
  const match = matchRoute(wsRoutes, { method: 'WS' satisfies RouteMethod, url });
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
    log: { info: console.info, warn: console.warn, error: console.error },
  });

  try {
    // 与 HTTP 同一条链：全局 → 路由 → 控制器；输入校验紧贴 handle
    const chain: Middleware[] = [
      ...appMiddleware,
      ...((route.middleware ?? []) as readonly Middleware[]),
      ...((spec.middleware ?? []) as readonly Middleware[]),
    ];
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
    console.error('[ws] handler error:', error);
    socket.send(String(toErrorResponse(error).body));
  }
}

export function wsPlugin(options: WsPluginOptions = {}): WsPlugin {
  let server: KernelWebSocketServer | null = null;
  let bound: { host: string; port: number } | null = null;
  const sockets = new Set<WsSocket>();
  let drained: (() => void) | null = null;

  const plugin = {
    name: 'ws',
    config: {
      port: { type: 'number' as const, default: 9001, min: 0 },
      host: { type: 'string' as const, default: '127.0.0.1' },
      maxPayloadBytes: { type: 'number' as const, default: 4 * 1024 * 1024, min: 1 },
      shutdownTimeoutMs: { type: 'number' as const, default: 5000, min: 1 },
    },
    async onReady(app: Application) {
      const port = options.port ?? app.config.get<number>('plugins.ws.port');
      const host = options.host ?? app.config.get<string>('plugins.ws.host');
      const maxPayloadBytes = options.maxPayloadBytes ?? app.config.get<number>('plugins.ws.maxPayloadBytes');

      const { routes, issues } = buildRouteTable(
        app.routes as readonly (readonly [RouteMethod, string, ControllerLike])[],
      );
      if (issues.length > 0) {
        throw new Error(
          `路由配置有问题（${issues.length} 项）：\n` + issues.map((i) => `  - ${i.message}`).join('\n'),
        );
      }
      const wsRoutes = routes.filter((route) => route.method === 'WS');

      // path: '*' —— 服务端不限定路径，由本插件的路由表按 URL 分发（每条 ws 路由一个模式）
      const wsServer = new WebSocketServer({ port, host, maxPayloadBytes, path: '*' });
      server = wsServer;
      wsServer.on('connection', ((socket: WsSocket, request: { url?: string }) => {
        sockets.add(socket);
        socket.on('close', (() => {
          sockets.delete(socket);
          if (sockets.size === 0) drained?.();
        }) as never);
        socket.on('message', ((data: unknown, isBinary: boolean) => {
          void handleMessage(app, wsRoutes, app.middleware as readonly Middleware[], socket, request, data, isBinary);
        }) as never);
      }) as never);

      await wsServer.listen();
      bound = { host, port: wsServer.port };
      console.log(`[@actor/web] ws listening on ${host}:${String(wsServer.port)}`);
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
