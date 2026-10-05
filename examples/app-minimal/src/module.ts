import { defineModule } from '@actor/app';

import { Counter } from './actors/counter.ts';

/** 装配声明：有哪些 Actor、需要什么依赖、启停时做什么。 */
export default defineModule({
  name: 'counter-app',
  actors: { Counter },
  providers: {
    // 演示 provider 依赖注入（可按名取用 config 与其它 provider）
    doubling: {
      deps: ['config'],
      factory: ({ config }) => (value: number): number => value * 2 * (config as { get<T>(p: string): T }).get<number>('step'),
    },
  },
  onStart: (app) => {
    app.config.get<string>('token'); // 真实值可用，但不会出现在日志/诊断里
    console.log(`[module] ready: greeting=${app.config.get<string>('greeting')}`);
  },
  onStop: () => {
    console.log('[module] stopped');
  },
});
