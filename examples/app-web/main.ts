import { runApp } from '@actor/app';

import app, { http } from './src/app.ts';

await runApp(app, {
  ...{ configDir: new URL('./config', import.meta.url).pathname },
  // 信号处理器由 runApp 在**任何 await 之前**注册（这处顺序容易写错，集中放在框架里）
  onStarted: () => {
const address = http.address();
console.log(`[main] listening on http://${String(address?.host)}:${String(address?.port)}`);
  },
});
