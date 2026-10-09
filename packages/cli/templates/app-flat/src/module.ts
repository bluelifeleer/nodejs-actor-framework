import path from 'node:path';

import { defineModule } from '@actor/app';
import { createFileRepository } from '@actor/data';
import { defineRoutes, del, get, patch, post } from '@actor/web';

import { Counter } from './counter.ts';
import { counter, health, notes } from './notes.ts';

// `actor generate <kind> --mount` 会往下面这些标记后面**只插整行**（没有标记就只打印片段，不改文件）
// @actor:mount imports

export default defineModule({
  name: 'app',

  // provider：按需构造、按依赖图解析（这里只有一个仓储）
  providers: {
    // @actor:mount providers
    // 换成 SQL 只改这一行：createSqlRepository({ runner, ... })
    notes: ({ config }) => createFileRepository({ dir: path.join(config.get<string>('dataDir'), 'notes') }),
  },

  // Actor：写路径在这里（有状态、串行、可持久化）
  actors: {
    // @actor:mount actors
    Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } },
  },

  // 模块级中间件：作用于本模块声明的所有路由
  middleware: [
    // @actor:mount middleware
  ],

  routes: defineRoutes([
    // @actor:mount routes
    get('/health', health),

    post('/notes', notes.create),
    get('/notes?limit=&cursor=', notes.list),
    patch('/notes/:id', notes.rename),
    del('/notes/:id', notes.remove),

    post('/counter/add', counter.add),
    get('/counter', counter.read),
  ]),
});
