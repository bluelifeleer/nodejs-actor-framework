import { defineRoutes, del, get, patch, post } from '@actor/web';

import { notesController } from './controllers.ts';

export default defineRoutes([
  post('/notes', notesController.create),
  get('/notes', notesController.list),
  get('/notes/:id', notesController.get),
  patch('/notes/:id', notesController.patch),
  del('/notes/:id', notesController.remove),
  get('/health', () => ({ ok: true })),
]);
