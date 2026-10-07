import path from 'node:path';

import { defineApp, defineModule, metricsPlugin } from '@actor/app';
import { diskChunkStore, get, httpPlugin, localDiskStorage, uploadPlugin } from '@actor/web';

import config from '../config/default.ts';
import { demoPage } from './demo-page.ts';

export const http = httpPlugin({ port: 0, shutdownTimeoutMs: 5000 });

const dataDir = process.env.APP_UPLOAD_DIR ?? path.resolve(import.meta.dirname, '..', 'data');

export default defineApp({
  config,
  modules: [
    defineModule({
      name: 'demo',
      routes: [
        get('/', () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: demoPage, headers: {} })),
        get('/health', () => ({ ok: true })),
      ],
    }),
  ],
  plugins: [
    uploadPlugin({
      storage: localDiskStorage({ dir: path.join(dataDir, 'files') }),
      // 磁盘会话存储 → **进程重启后仍能续传**
      chunkStore: diskChunkStore({ dir: path.join(dataDir, 'chunks') }),
      limits: { maxFileSize: 2 * 1024 * 1024 * 1024, maxFiles: 10 },
    }),
    http,
    metricsPlugin({ exporter: { enabled: false } }),
  ],
});
