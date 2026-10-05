import { defineRoutes, get, post } from '@actor/web';

import { health, joinController, roomController, slowController } from './controllers/index.ts';

export default defineRoutes([
  get('/health', health),
  post('/join', joinController),
  get('/rooms/:id?verbose=', roomController),
  get('/slow', slowController),
]);
