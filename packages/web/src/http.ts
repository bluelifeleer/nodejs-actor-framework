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
import type { HeaderValue } from './context.ts';
import { buildRouteTable, type ControllerLike, type HttpMethod, type Route } from './routes.ts';

export interface HttpPluginOptions {
  port?: number;
  host?: string;
  maxBodyBytes?: number;
  /** 停止时等待在途请求的上限（毫秒）。 */
  shutdownTimeoutMs?: number;
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
  };
}

export function httpPlugin(options: HttpPluginOptions = {}): HttpPlugin {
  let server: http.Server | null = null;
  let bound: { host: string; port: number } | null = null;
  let inFlight = 0;
  let draining: (() => void) | null = null;

  const plugin = {
    name: 'http',
    config: readSchema(),
    async onReady(app: Application) {
      const config = app.config;
      const port = options.port ?? config.get<number>('plugins.http.port');
      const host = options.host ?? config.get<string>('plugins.http.host');
      const maxBodyBytes = options.maxBodyBytes ?? config.get<number>('plugins.http.maxBodyBytes');
      // 模块声明的是"路由元组"（defineRoutes/get/post... 的产物），这里解析成路由表：
      // 非法模式、重复路由、input 键未声明等启动期问题都在此一次性报出。
      const { routes, issues } = buildRouteTable(
        app.routes as readonly (readonly [HttpMethod, string, ControllerLike])[],
      );
      if (issues.length > 0) {
        throw new Error(
          `路由配置有问题（${issues.length} 项）：\n` + issues.map((i) => `  - ${i.message}`).join('\n'),
        );
      }

      server = http.createServer((req, res) => {
        inFlight += 1;
        const finish = (): void => {
          inFlight -= 1;
          if (inFlight === 0) draining?.();
        };
        void (async () => {
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              const buf = chunk as Buffer;
              size += buf.length;
              if (size > maxBodyBytes) {
                res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: { status: 413, message: 'payload too large' } }));
                return;
              }
              chunks.push(buf);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
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
              request: {
                method: req.method ?? 'GET',
                url: req.url ?? '/',
                headers: req.headers as Record<string, HeaderValue>,
                ...(body === undefined ? {} : { body }),
              },
              actor: (name: string) => app.actor(name),
              get: (name: string) => app.get(name),
              config: app.config,
              log: { info: console.info, warn: console.warn, error: console.error },
            });

            const headers: Record<string, string> = { ...result.response.headers };
            headers['content-type'] = result.response.contentType;
            res.writeHead(result.response.status, headers);
            // HEAD：响应头照常，但不发送 body（标准行为）
            if (result.response.body === null || result.headOnly) res.end();
            else res.end(result.response.body);
          } catch (error) {
            // 500 必须留痕：响应里不含细节（安全），但服务端日志要能定位
            console.error('[http] handler error:', error);
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { status: 500, message: 'internal error' } }));
            void error;
          } finally {
            finish();
          }
        })();
      });

      await new Promise<void>((resolve) => server?.listen(port, host, () => resolve()));
      const addr = server.address();
      bound = typeof addr === 'object' && addr !== null ? { host, port: addr.port } : null;
      console.log(`[@actor/web] http listening on ${host}:${String(bound?.port)}`);
    },
    async onStopping() {
      if (!server) return;
      const timeoutMs = options.shutdownTimeoutMs ?? 5000;
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
