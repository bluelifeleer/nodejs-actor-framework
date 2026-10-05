import { createApp } from '@actor/app';

import app, { http } from './src/app.ts';

const application = createApp(app, { configDir: new URL('./config', import.meta.url).pathname });

// 信号处理器在任何 await 之前注册（否则启动窗口内收到 SIGTERM 会走默认行为）
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void application
      .stop({ timeoutMs: 10_000 })
      .then(
        () =>
          new Promise<void>((resolve) => {
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
const address = http.address();
console.log(`[main] listening on http://${String(address?.host)}:${String(address?.port)}`);
