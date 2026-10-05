import { defineRouter, routes } from '@actor/web';

import { health, joinController, roomController, slowController } from './controllers/index.ts';

/**
 * 用**语法糖**声明路由（对象字面量表），并演示嵌套前缀：
 *   GET  /api/health      → 函数式控制器
 *   GET  /api/slow        → 每请求超时（504）
 *   GET  /api/rooms/:id   → 由子路由器（prefix: '/rooms'）贡献
 *   POST /api/join        → 输入来自请求体
 */
export default routes({
  prefix: '/api',
  GET: {
    '/health': health,
    '/slow': slowController,
  },
  POST: {
    '/join': joinController,
  },
  children: [
    defineRouter({
      prefix: '/rooms',
      name: 'rooms',
      // 注意：routes({...}) 的产物是"路由器"，要放 children；routes: 只接受元组数组
      children: [routes({ GET: { '/:id?verbose=': roomController } })],
    }),
  ],
});
