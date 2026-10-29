import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { reply, type HttpResponse } from './context.ts';
import { defineWebPlugin, type WebPluginSpec } from './plugins.ts';

export interface ViewPluginOptions {
  /** 模板根目录；相对路径按进程 cwd 解析。 */
  root: string;
  /** 扩展名（默认 .html）。传了带扩展名的 name 就不再拼。 */
  extension?: string;
  /** 是否把数据挂到 `window.__INITIAL_DATA__`（默认 true）。 */
  injectData?: boolean;
}

export interface ViewService {
  /** 读取 `name` 模板并注入 `data`；返回可直接交给控制器的 HttpResponse。 */
  render(name: string, data?: unknown): Promise<HttpResponse>;
  /** 只读模板（不注入）。 */
  read(name: string): Promise<string>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

function getPath(data: unknown, dotted: string): unknown {
  let current = data;
  for (const key of dotted.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Replace `{{path.to.value}}` with escaped values; arrays/objects are JSON encoded. */
export function renderTemplate(source: string, data: unknown): string {
  return source.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_, key: string) => {
    const value = getPath(data, key);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return escapeHtml(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return escapeHtml(JSON.stringify(value));
  });
}

export function viewPlugin(options: ViewPluginOptions): WebPluginSpec {
  if (typeof options.root !== 'string' || options.root.trim() === '') throw new Error('viewPlugin: root 必须是非空字符串');
  const root = path.resolve(options.root);
  const extension = options.extension ?? '.html';

  const resolveName = (name: string): string => {
    if (name.includes('\0')) throw new Error('view name 不能包含 NUL');
    const relative = name.startsWith('/') ? name : `./${name}`;
    const file = path.resolve(root, relative.endsWith(extension) || path.extname(relative) !== '' ? relative : relative + extension);
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error(`view 越界：${name}`);
    return file;
  };

  const read = async (name: string): Promise<string> => readFile(resolveName(name), 'utf8');

  const render = async (name: string, data?: unknown): Promise<HttpResponse> => {
    const source = await read(name);
    const html = renderTemplate(source, data);
    if (options.injectData === false || data === undefined) return reply.html(html);
    const script = `<script>window.__INITIAL_DATA__ = ${safeJson(data)};</script>`;
    const injected = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${script}</head>`) : `${script}${html}`;
    return reply.html(injected);
  };

  const service: ViewService = { render, read };
  return defineWebPlugin({
    name: 'view',
    framework: true,
    context: () => ({ render, view: service }),
    onReady: (app) => {
      app.provide?.('view', service);
    },
  });
}
