import { defineModule } from '@actor/app';

import { Room } from './actors/room.ts';
import routes from './routes.ts';

export default defineModule({ name: 'api', actors: { Room }, router: routes });
