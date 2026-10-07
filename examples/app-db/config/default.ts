import { defineConfig } from '@actor/app';

/**
 * 应用配置。数据库的连接参数**不需要在这里声明** —— `databasePlugin` 自带配置节
 * `plugins.db.*`（driver / url / file / poolMax / autoMigrate），会被合并进应用配置。
 *
 * 覆盖方式（双下划线表示层级）：
 *   APP_PLUGINS__DB__DRIVER=pgsql
 *   APP_PLUGINS__DB__URL='pgsql://user:pass@host:5432/appdb'   # 需要 npm i pg
 *   APP_PLUGINS__DB__FILE=./data/app-db.sqlite                # 默认 sqlite
 */
export default defineConfig({
  name: { type: 'string', default: 'app-db' },
});
