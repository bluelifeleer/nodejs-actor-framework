import { defineApp, metricsPlugin } from '@actor/app';
import { httpPlugin } from '@actor/web';

import config from '../config/default.ts';
import apiModule from './module.ts';

/** 导出插件实例，便于启动后读取真实监听地址（端口传 0 时必需）。 */
export const http = httpPlugin({ shutdownTimeoutMs: 5000 });

export default defineApp({
  config,
  modules: [apiModule],
  plugins: [http, metricsPlugin()],
});
