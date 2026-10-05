import { defineApp } from '@actor/app';
import { httpPlugin } from '@actor/web';

import { DATA_DIR } from './paths.ts';
import config from '../config/default.ts';
import dataModule from './module.ts';

/** 导出插件实例，便于启动后读取真实监听地址（端口传 0 时必需）。 */
export const http = httpPlugin({ shutdownTimeoutMs: 5000 });

export default defineApp({
  config,
  modules: [dataModule],
  plugins: [http],
});

/** 内核持久化目录与配置同源（事件日志、快照都落在这里）。 */
export const kernelOptions = { logger: false, persistence: { dir: DATA_DIR } };
