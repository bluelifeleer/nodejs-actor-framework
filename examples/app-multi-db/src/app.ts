import { defineApp, metricsPlugin } from '@actor/app';
import { databaseAdapter } from '@actor/db-core';
import { redisAdapter } from '@actor/redis';
import { httpPlugin } from '@actor/web';

import config from '../config/default.ts';
import { jsonStoreAdapter } from './json-store-adapter.ts';
import notesModule from './module.ts';

/** 导出插件实例：端口传 0 时要读真实监听地址。 */
export const http = httpPlugin({ port: 0, shutdownTimeoutMs: 5000 });

/**
 * **一个应用挂多个数据库**：
 *
 *   - `store`：**用户自装的适配器**（JSON 文件存储，零 npm 依赖）—— 演示"框架没定义的库也能被管住"；
 *   - `cache` / `queue`：**两个 Redis 实例**，只在配置了 `APP_PLUGINS__<NAME>__URL` 时才挂上
 *     （不配就不挂，否则插件会去连一个不存在的 Redis 并让启动失败 —— 我们不静默降级）。
 *
 * 三个实例各自独立配置与生命周期，客户端分别注册成 `store` / `cache` / `queue` 服务。
 */
const redisInstances = (['cache', 'queue'] as const)
  .filter((name) => {
    const url = process.env[`APP_PLUGINS__${name.toUpperCase()}__URL`];
    return url !== undefined && url !== '';
  })
  .map((name) => databaseAdapter(redisAdapter({ prefix: `${name}:` }), { name }));

export default defineApp({
  config,
  modules: [notesModule],
  plugins: [
    databaseAdapter(jsonStoreAdapter(), { name: 'store' }),
    ...redisInstances,
    http,
    metricsPlugin({ exporter: { enabled: false } }),
  ],
});
