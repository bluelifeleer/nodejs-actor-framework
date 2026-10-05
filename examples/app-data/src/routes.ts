import { defineRoutes, del, get, patch, post } from '@actor/web';

import { notesController, ordersController } from './controllers.ts';

export default defineRoutes([
  post('/notes', notesController.create),
  get('/notes?limit=&cursor=', notesController.list),
  get('/notes/:id', notesController.get),
  patch('/notes/:id', notesController.patch),
  del('/notes/:id', notesController.remove),

  // 写路径：命令（返回新状态）；读路径：投影读模型（最终一致）
  post('/orders/:id/items', ordersController.addItem),
  post('/orders/:id/confirm', ordersController.confirm),
  get('/orders/:id/summary', ordersController.summary),
]);
