import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '@actor/app';

import app, { http } from '../server.ts';

test('mail 能力：fileTransport 不需要任何服务，应用照常启动', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-mail-'));
  process.env['APP_PLUGINS__HTTP__PORT'] = '0';
  process.env['APP_MAIL_DIR'] = path.join(dataDir, 'mail');
  const application = createApp(app, {
    configDir: fileURLToPath(new URL('../config', import.meta.url)),
    kernel: { logger: false, persistence: { dir: dataDir } },
  });
  await application.start();
  try {
    const address = http.address();
    const response = await fetch(`http://${String(address?.host)}:${String(address?.port)}/health`);
    assert.strictEqual(response.status, 200);
  } finally {
    await application.stop({ timeoutMs: 5000 });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
