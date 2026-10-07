import { runApp } from '@actor/app';
import { createFileMigrationStore, createMigrationRunner } from '@actor/data';

import app, { http, kernelOptions } from './src/app.ts';
import { migrations } from './src/migrations.ts';
import { DATA_DIR } from './src/paths.ts';

const application = await runApp(app, {
  configDir: new URL('./config', import.meta.url).pathname,
  kernel: kernelOptions,
  // 迁移门放在 beforeStart（= 信号注册之后、start 之前）：放在 runApp 之前会让启动窗口失去优雅停
  beforeStart: async () => {
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
  },
});

const address = http.address();
console.log(`[main] listening on http://${String(address?.host)}:${String(address?.port)}`);
