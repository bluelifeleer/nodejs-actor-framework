import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { defineWebPlugin, type WebPluginSpec } from './plugins.ts';
import { HTTP_FALLBACK_SERVICE } from './http.ts';

export interface StaticPluginOptions {
  /** 静态根目录（例如 `./web/dist`）；相对路径按进程 cwd 解析。 */
  root: string;
  /** 目录索引（默认 index.html）。 */
  index?: string;
  /** 挂载前缀（默认 `/`）。例如 `/assets` 只服务该前缀。 */
  prefix?: string;
  /** 未命中文件时回退到 index.html（BrowserRouter 的 SPA fallback）。 */
  spaFallback?: boolean;
  /** 不参与 fallback 的路径前缀（默认 `/api`、`/v1`）。 */
  exclude?: readonly string[];
  /** 长缓存前缀（默认 `/assets`）。 */
  immutablePrefix?: string;
  /** immutable 资源缓存时间（默认 1 年）。 */
  immutableMaxAgeMs?: number;
  /** index.html 缓存时间（默认 0）。 */
  indexMaxAgeMs?: number;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function isHtmlRequest(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? '');
  return accept === '' || accept.includes('text/html') || accept.includes('*/*');
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Static file service.
 *
 * It is registered as an HTTP fallback, not as a route table: controllers win,
 * then real files, then SPA fallback. `/api` and `/v1` are never swallowed.
 */
export function staticPlugin(options: StaticPluginOptions): WebPluginSpec {
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new Error('staticPlugin: root 必须是非空字符串');
  }
  const root = path.resolve(options.root);
  const index = options.index ?? 'index.html';
  const prefix = options.prefix === undefined || options.prefix === '/' ? '/' : options.prefix.replace(/\/$/, '');
  const excludes = options.exclude ?? ['/api', '/v1'];
  const immutablePrefix = options.immutablePrefix ?? '/assets';
  const immutableMaxAge = options.immutableMaxAgeMs ?? 365 * 24 * 60 * 60 * 1000;
  const indexMaxAge = options.indexMaxAgeMs ?? 0;

  const serveFile = async (req: IncomingMessage, res: ServerResponse, file: string, cacheMs: number): Promise<void> => {
    const info = await stat(file);
    if (!info.isFile()) return;
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    if (String(req.headers['if-none-match'] ?? '') === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheMs > 0 ? `public, max-age=${String(Math.floor(cacheMs / 1000))}` : 'no-cache' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': contentType(file),
      'content-length': String(info.size),
      etag,
      'last-modified': info.mtime.toUTCString(),
      'cache-control': cacheMs > 0 ? `public, max-age=${String(Math.floor(cacheMs / 1000))}, immutable` : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      if (!res.writableEnded) res.end('static file read failed');
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      return false;
    }
    if (pathname.includes('\0')) return false;
    if (excludes.some((item) => pathname === item || pathname.startsWith(item + '/'))) return false;
    if (prefix !== '/' && !(pathname === prefix || pathname.startsWith(prefix + '/'))) return false;
    const relativePath = prefix === '/' ? pathname : pathname.slice(prefix.length) || '/';
    if (relativePath.split('/').some((segment) => segment === '..')) return false;

    const candidate = path.resolve(root, `.${relativePath}`);
    if (!within(root, candidate)) return false;
    let rootReal: string;
    try {
      rootReal = await realpath(root);
    } catch {
      return false;
    }

    // 1) exact file
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        const real = await realpath(candidate);
        if (!within(rootReal, real)) return false;
        const cache = pathname.startsWith(immutablePrefix + '/') ? immutableMaxAge : 0;
        await serveFile(req, res, real, cache);
        return true;
      }
    } catch {
      // miss -> fallback
    }

    // 2) SPA fallback: only for extension-less navigation requests.
    if (options.spaFallback === true && path.extname(relativePath) === '' && isHtmlRequest(req)) {
      const indexPath = path.join(root, index);
      try {
        const info = await stat(indexPath);
        if (!info.isFile()) return false;
        const real = await realpath(indexPath);
        if (!within(rootReal, real)) return false;
        await serveFile(req, res, real, indexMaxAge);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };

  return defineWebPlugin({
    name: 'static',
    framework: true,
    onReady: (app) => {
      app.provide?.(HTTP_FALLBACK_SERVICE, handler);
    },
  });
}
