import { createApp } from '@actor/app';

import app from './src/app.ts';

/**
 * 用户项目的启动入口：只需要 @actor/app，看不见内核。
 * 运行： node main.ts        （Node 直接跑 TS，无需构建）
 */
const application = createApp(app, {
  configDir: new URL('./config', import.meta.url).pathname,
});

// 信号处理器必须在任何 await 之前注册——否则启动窗口内收到 SIGTERM 会走默认行为（直接退出）
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void application
      .stop({ timeoutMs: 5000 })
      .then(
        () =>
          new Promise<void>((resolve) => {
            // 用 write 回调确保输出已刷出，再退出（process.exit 会截断未刷出的 stdout）
            process.stdout.write('[main] stopped gracefully\n', () => resolve());
          }),
      )
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`[main] stop failed: ${String(err)}\n`);
        process.exit(1);
      });
  });
}

await application.start();
console.log(`[main] started with greeting=${application.config.get<string>('greeting')}`);

// 两次 add：一次显式给 by（覆盖配置），一次不给（走配置里的 step）
const explicit = await application.actor('Counter').ask({ type: 'add', by: 3 });
const fromConfig = await application.actor('Counter').ask({ type: 'add' });
console.log(`[main] counter=${String(explicit)} then ${String(fromConfig)}`);
