import { defineRoutes, del, get, post } from '@actor/web';

import { notesController } from './controllers.ts';

export default defineRoutes([
  post('/notes', notesController.create),
  get('/notes', notesController.list),
  get('/notes/:id', notesController.get),
  del('/notes/:id', notesController.remove),
  get('/health', () => ({ ok: true })),
]);
