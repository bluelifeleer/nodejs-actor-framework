import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '@actor/app';

import app, { http } from '../server.ts';

test('debug 能力：默认关闭（/__debug/routes 是 404）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-debug-'));
  delete process.env['APP_DEBUG'];
  process.env['APP_PLUGINS__HTTP__PORT'] = '0';
  const application = createApp(app, {
    configDir: new URL('../config', import.meta.url).pathname,
    kernel: { logger: false, persistence: { dir: dataDir } },
  });
  await application.start();
  try {
    const address = http.address();
    const response = await fetch(`http://${String(address?.host)}:${String(address?.port)}/__debug/routes`);
    assert.strictEqual(response.status, 404, '默认关闭时诊断路由不该存在');
  } finally {
    await application.stop({ timeoutMs: 5000 });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
