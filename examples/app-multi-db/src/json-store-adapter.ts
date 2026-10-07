import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DbConfigError,
  DbConnectionError,
  DbError,
  defineDatabaseAdapter,
  type AdapterConnectInput,
  type BaseConnection,
  type DatabaseAdapter,
  type ManagedConnection,
} from '@actor/db-core';

/**
 * **用户自装的适配器**：框架没定义这种"数据库"，我们自己接。
 *
 * 它故意用最朴素的驱动（`node:fs`，**零 npm 依赖**）—— 这样示例离线就能跑，
 * 同时把"自装适配器"的每个要点都演示到：
 *   - `kind`/`driverPackage`/`connectionKind`/`config` 声明齐全；
 *   - `connectionFromUrl` 认 `file:/path/to/store.json` 这种 DSN；
 *   - `connect()` 返回 `ManagedConnection`：`client`（薄封装）+ `healthCheck` + `keepAlive` + `close` + `stats`；
 *   - 用 `emitDriverEvent` 把"驱动自己的事件"报给框架（框架只转发、不解释）；
 *   - 连接管控（建连失败就失败、事件、drain、关停）**全都不用自己写** —— 交给 `supervise()`。
 */
export interface JsonStoreConnection extends BaseConnection {
  /** 文件路径（也可以用 `url: 'file:/…'` 传）。 */
  filename?: string;
}

export interface JsonStoreClient {
  /** 逃生通道：原生"客户端"信息（这里是文件位置）。 */
  readonly raw: { readonly file: string };
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<string[]>;
}

function fileOf(connection: JsonStoreConnection): string {
  const fromUrl = typeof connection.url === 'string' ? connection.url.replace(/^file:/, '') : '';
  const filename = connection.filename ?? fromUrl;
  if (filename === '') {
    throw new DbConfigError('json-store: connection needs a file path (pass { filename } or a file:/… url)');
  }
  return path.resolve(filename);
}

export function jsonStoreAdapter(): DatabaseAdapter<JsonStoreClient, JsonStoreConnection> {
  return defineDatabaseAdapter<JsonStoreClient, JsonStoreConnection>({
    kind: 'json-store',
    driverPackage: 'node:fs', // 没有 npm 包要装 —— 但字段仍要如实填（错误信息与文档都用它）
    connectionKind: 'file',
    config: { url: { type: 'string' as const, default: '' } },
    connectionFromUrl: (url) => ({ kind: 'json-store', url }),

    describe: (connection) => `json-store:${connection.filename ?? String(connection.url ?? '')}`,

    async connect({ connection, emitDriverEvent }: AdapterConnectInput<JsonStoreConnection>): Promise<ManagedConnection<JsonStoreClient>> {
      const file = fileOf(connection);
      let data: Record<string, unknown> = {};
      try {
        const text = await readFile(file, 'utf8');
        data = text.trim() === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'ENOENT') {
          const error = err instanceof Error ? err : new Error(String(err));
          // 具体错误类型原样抛（配置类），其它包成连接错误 —— 与 SQL/Redis 适配器同一套约定
          if (error instanceof DbError) throw error;
          throw new DbConnectionError(`cannot open json-store at ${file}: ${error.message}`, error);
        }
      }

      /** 落盘：既用来保存，也用来探活（写不进去就是不健康）。 */
      const flush = async (): Promise<void> => {
        try {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          throw new DbConnectionError(`cannot write json-store at ${file}: ${error.message}`, error);
        }
      };

      // 建连即探活：写不进去就在启动阶段失败，不静默降级
      emitDriverEvent?.('file_loaded', { file, keys: Object.keys(data).length });
      await flush();

      return {
        client: {
          raw: { file },
          async get(key) {
            return Object.prototype.hasOwnProperty.call(data, key) ? (data[key] as unknown) : null;
          },
          async set(key, value) {
            data[key] = value;
            await flush();
          },
          async delete(key) {
            if (!Object.prototype.hasOwnProperty.call(data, key)) return false;
            delete data[key];
            await flush();
            return true;
          },
          async list() {
            return Object.keys(data);
          },
        },
        healthCheck: flush,
        keepAlive: flush,
        close: flush, // 关闭时落盘
        stats: () => ({ kind: 'json-store', file, keys: Object.keys(data).length }),
      };
    },
  });
}
