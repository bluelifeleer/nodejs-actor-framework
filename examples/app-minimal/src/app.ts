import { defineApp } from '@actor/app';

import config from '../config/default.ts';
import counterModule from './module.ts';

export default defineApp({
  config,
  modules: [counterModule],
});
