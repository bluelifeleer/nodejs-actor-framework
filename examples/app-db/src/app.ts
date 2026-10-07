import { defineApp, metricsPlugin } from '@actor/app';
import { databasePlugin } from '@actor/db';
import { httpPlugin } from '@actor/web';

import config from '../config/default.ts';
import dbModule from './module.ts';
import { Note } from './models.ts';

/** 导出插件实例：端口传 0 时要读真实监听地址。 */
export const http = httpPlugin({ port: 0, shutdownTimeoutMs: 5000 });

/**
 * **一行接入数据库**：插件负责连接 + 健康检查 + 建表 + 把 `db`/仓储注册成应用服务 + 停机优雅关池。
 * 业务代码（控制器）只需要 `ctx.get('notes')`。
 *
 * 连接参数走配置节 `plugins.db.*`（可用环境变量覆盖）：
 *   `APP_PLUGINS__DB__DRIVER=pgsql APP_PLUGINS__DB__URL='pgsql://user:pass@host:5432/db' node main.ts`
 */
export const database = databasePlugin({
  models: [Note],
  repositories: { notes: Note }, // 控制器里 ctx.get('notes')
  autoMigrate: true, // 演示方便；生产建议关掉并走显式迁移
  logger: (event, meta) => console.log(`[db] ${event}`, meta ? JSON.stringify(meta) : ''),
});

export default defineApp({
  config,
  modules: [dbModule],
  plugins: [database, http, metricsPlugin({ exporter: { enabled: false } })],
});
