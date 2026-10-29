import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '@actor/app';

import app, { http } from '../server.ts';

test('redis 能力：没配 APP_REDIS_URL 时**不挂**（应用照常启动）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-redis-'));
  delete process.env['APP_REDIS_URL'];
  process.env['APP_PLUGINS__HTTP__PORT'] = '0';
  const application = createApp(app, {
    configDir: fileURLToPath(new URL('../config', import.meta.url)),
    kernel: { logger: false, persistence: { dir: dataDir } },
  });
  await application.start();
  try {
    const address = http.address();
    const response = await fetch(`http://${String(address?.host)}:${String(address?.port)}/health`);
    assert.strictEqual(response.status, 200, '没配 Redis 不该影响应用启动');
  } finally {
    await application.stop({ timeoutMs: 5000 });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
