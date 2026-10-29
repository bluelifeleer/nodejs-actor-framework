import { fileURLToPath } from 'node:url';
import { createApp } from '@actor/app';

import app, { http } from './src/app.ts';

// 数据目录与内核持久化同源：配置读不到时用环境变量兜底（两者必须指向同一个目录）
const dataDir = process.env.APP_DATA_DIR ?? './data';

const application = createApp(app, {
  configDir: fileURLToPath(new URL('./config', import.meta.url)),
  // 内核持久化：Actor 的快照/事件写到这里；共享存储（SQL/共享盘）才能跨节点交接
  kernel: { logger: false, persistence: { dir: dataDir } },
});

// 信号处理器要**在任何 await 之前**注册：否则启动窗口内收到 SIGTERM 会走默认行为
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void application
      .stop({ timeoutMs: 10_000 })
      .then(() => new Promise<void>((resolve) => process.stdout.write('[main] stopped gracefully\n', () => resolve())))
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
