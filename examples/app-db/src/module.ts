import { defineModule } from '@actor/app';

import routes from './routes.ts';

/**
 * 模块里**不再有任何数据库接线** —— 连接、建表、仓储注册、关池都由 `databasePlugin` 负责
 * （见 `src/app.ts`）。控制器用 `ctx.get('notes')` 拿仓储，模块只声明路由。
 */
export default defineModule({
  name: 'notes-api',
  routes,
});
