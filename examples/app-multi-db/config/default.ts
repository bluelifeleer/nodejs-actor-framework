import { defineConfig } from '@actor/app';

/**
 * 应用配置。
 *
 * 注意：各数据库实例的连接配置**不写在这里** —— 每个实例是一个插件名，配置落在 `plugins.<name>.*`
 * （环境变量 `APP_PLUGINS__<NAME>__URL`）。例如：
 *   APP_PLUGINS__STORE__URL='file:./data/store.json'   # 自装适配器（框架没定义的那种"库"）
 *   APP_PLUGINS__CACHE__URL='redis://127.0.0.1:6379/0' # 挂上 cache 实例（需要 npm i redis）
 *   APP_PLUGINS__QUEUE__URL='redis://127.0.0.1:6379/1' # 挂上 queue 实例
 */
export default defineConfig({
  name: { type: 'string', default: 'app-multi-db' },
});
