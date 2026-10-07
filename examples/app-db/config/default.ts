import { defineConfig } from '@actor/app';

/**
 * 数据库配置：**连接由使用者在配置里给**（默认 sqlite 文件；换 PG/MySQL 只改这几行 + 装驱动）。
 *
 * 环境变量覆盖用双下划线：`APP_DATABASE__DRIVER=pgsql APP_DATABASE__URL=pgsql://user:pass@host:5432/db`。
 */
export default defineConfig({
  name: { type: 'string', default: 'app-db' },
  dataDir: { type: 'string', default: './data' },
  // 嵌套分组：纯对象 + 每组里是字段声明（与 defineConfig 的 DSL 一致）
  database: {
    driver: { type: 'string', default: 'sqlite' }, // sqlite | pgsql | mysql
    url: { type: 'string', default: '' }, // 给了 url 就用它（DSN），否则用 file
    file: { type: 'string', default: './data/app-db.sqlite' },
    poolMax: { type: 'number', default: 10 },
  },
});
