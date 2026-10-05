import { defineApp, metricsPlugin } from '@actor/app';

import config from '../config/default.ts';
import counterModule from './module.ts';
import { auditPlugin } from './plugins/audit.ts';

export default defineApp({
  config,
  modules: [counterModule],
  // 显式启用：用户自定义插件 + 一个内置能力（未声明的能力不会被挂上）
  plugins: [auditPlugin, metricsPlugin()],
});
