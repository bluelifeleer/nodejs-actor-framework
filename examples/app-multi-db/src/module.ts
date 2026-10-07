import { defineModule } from '@actor/app';

import routes from './routes.ts';

/**
 * 模块里**没有任何数据库接线**：连接、注册服务、关停都由 `databaseAdapter(...)` 负责
 * （见 src/app.ts）。控制器只依赖注入的客户端：`ctx.get('store')` / `ctx.get('cache')`。
 */
export default defineModule({ name: 'notes-api', routes });
