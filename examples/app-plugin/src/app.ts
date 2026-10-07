import { defineApp, defineModule, metricsPlugin } from '@actor/app';
import { get, httpPlugin } from '@actor/web';

import config from '../config/default.ts';
import { greetingPlugin } from './greeting-plugin.ts';

export const http = httpPlugin({ port: 0, shutdownTimeoutMs: 5000 });

/** 模块自己的路由（和插件路由共存；插件路由排在模块路由之后）。 */
const healthModule = defineModule({
  name: 'health',
  routes: [get('/health', () => ({ ok: true }))],
});

export default defineApp({
  config,
  modules: [healthModule],
  plugins: [greetingPlugin, http, metricsPlugin({ exporter: { enabled: false } })],
});
