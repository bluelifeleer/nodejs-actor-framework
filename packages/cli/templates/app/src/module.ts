import { defineModule } from '@actor/app';
import { defineRoutes, del, get, patch, post } from '@actor/web';

import { Counter } from './actor/counter.actor.ts';
import { counter } from './controller/counter.controller.ts';
import { health } from './controller/health.controller.ts';
import { notes } from './controller/notes.controller.ts';
import { createNotesRepository } from './service/notes.repository.ts';

/**
 * 模块声明：把各层的声明**挂进**应用。这里只做"接线"，不放业务逻辑。
 *
 * 分层对应关系（layered 布局）：
 *   - `src/controller/`  HTTP 语义（状态码、输入校验、错误翻译）
 *   - `src/actor/`       有状态、串行、可持久化的写路径
 *   - `src/service/`     仓储/外部依赖的装配与跨模块逻辑
 *   - `src/model/`       领域类型与映射
 *   - `src/schema/`      数据层声明（表/集合名、排序键、将来迁移的落点）
 */
export default defineModule({
  name: 'app',

  // provider：按需构造、按依赖图解析（这里只有一个仓储）
  providers: {
    // deps 的类型是 Record<string, unknown>（框架有意不把 provider 依赖做成泛型），
    // 所以这里显式收窄一次：拿到 config 再读配置。
    notes: (deps) => {
      const config = deps['config'] as { get<T>(key: string): T };
      return createNotesRepository(config.get<string>('dataDir'));
    },
  },

  // Actor：写路径在这里（有状态、串行、可持久化）
  actors: {
    Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } },
  },

  routes: defineRoutes([
    get('/health', health),

    post('/notes', notes.create),
    get('/notes?limit=&cursor=', notes.list),
    patch('/notes/:id', notes.rename),
    del('/notes/:id', notes.remove),

    post('/counter/add', counter.add),
    get('/counter', counter.read),
  ]),
});
