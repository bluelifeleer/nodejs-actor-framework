import { createApp } from '@actor/app';
import { createFileMigrationStore, createMigrationRunner } from '@actor/data';

import app, { http, kernelOptions } from './src/app.ts';
import { migrations } from './src/migrations.ts';
import { DATA_DIR } from './src/paths.ts';

const application = createApp(app, {
  configDir: new URL('./config', import.meta.url).pathname,
  kernel: kernelOptions,
});

// 迁移门：有未应用迁移就**拒绝启动**（doc 04 §5）。
// 第一次跑需要显式应用：APP_MIGRATE=1 node main.ts
const migrator = createMigrationRunner({
  store: createFileMigrationStore({ dir: DATA_DIR }),
  migrations: migrations(DATA_DIR),
  log: (message, meta) => console.log(`[migrate] ${message}`, meta ?? ''),
});
if (process.env.APP_MIGRATE === '1') await migrator.migrate();
const status = await migrator.assertApplied();
console.log(`[migrate] 已应用 v${status.applied.join(', v') || '(无)'}`);

// 信号处理器在任何 await 之前注册（否则启动窗口内收到 SIGTERM 会走默认行为）
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
