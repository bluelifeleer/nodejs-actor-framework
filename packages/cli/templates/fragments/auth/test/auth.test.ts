import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '@actor/app';

import app, { http } from '../server.ts';

test('auth 能力：没配密钥时**不挂**（应用照常启动，公开路由照常可用）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-auth-'));
  delete process.env['APP_JWT_SECRET'];
  process.env['APP_PLUGINS__HTTP__PORT'] = '0';
  const application = createApp(app, {
    configDir: new URL('../config', import.meta.url).pathname,
    kernel: { logger: false, persistence: { dir: dataDir } },
  });
  await application.start();
  try {
    const address = http.address();
    const response = await fetch(`http://${String(address?.host)}:${String(address?.port)}/health`);
    assert.strictEqual(response.status, 200, '没配 JWT 密钥不该影响其它路由');
  } finally {
    await application.stop({ timeoutMs: 5000 });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
