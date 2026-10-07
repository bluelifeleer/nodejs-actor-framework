import { runApp } from '@actor/app';

import app from './src/app.ts';

/**
 * 用户项目的启动入口：只需要 @actor/app，看不见内核。
 * 运行： node main.ts        （Node 直接跑 TS，无需构建）
 */
const application = await runApp(app, {
  configDir: new URL('./config', import.meta.url).pathname,
});

console.log(`[main] started with greeting=${application.config.get<string>('greeting')}`);

// 两次 add：一次显式给 by（覆盖配置），一次不给（走配置里的 step）
const explicit = await application.actor('Counter').ask({ type: 'add', by: 3 });
const fromConfig = await application.actor('Counter').ask({ type: 'add' });
console.log(`[main] counter=${String(explicit)} then ${String(fromConfig)}`);
