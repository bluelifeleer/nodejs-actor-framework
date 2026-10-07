import { createApp } from '@actor/app';

import app, { http } from './src/app.ts';

const application = createApp(app, { configDir: new URL('./config', import.meta.url).pathname });

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
