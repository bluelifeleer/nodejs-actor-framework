import { defineApp } from '@actor/app';
import { httpPlugin } from '@actor/web';

import config from './config/default.ts';
import appModule from './src/module.ts';
import capabilityPlugins from './src/plugin/index.ts';

/** 导出插件实例，便于启动后读取真实监听地址（端口传 0 时必需）。 */
export const http = httpPlugin({ shutdownTimeoutMs: 5000 });

export default defineApp({
  config,
  modules: [appModule],
  // 能力插件来自 `src/plugin/index.ts`（脚手架按你选的能力生成）
  plugins: [...capabilityPlugins, http],
});
