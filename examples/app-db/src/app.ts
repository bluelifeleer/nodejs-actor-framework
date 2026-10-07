import { defineApp, metricsPlugin } from '@actor/app';
import { httpPlugin } from '@actor/web';

import config from '../config/default.ts';
import dbModule from './module.ts';

/** 导出插件实例：端口传 0 时要读真实监听地址。 */
export const http = httpPlugin({ port: 0, shutdownTimeoutMs: 5000 });

export default defineApp({
  config,
  modules: [dbModule],
  plugins: [http, metricsPlugin({ exporter: { enabled: false } })],
});
