import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '@actor/app';

import app, { http } from '../server.ts';

test('upload 能力：路由真的挂上了（不带文件 → 400）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-upload-'));
  process.env['APP_PLUGINS__HTTP__PORT'] = '0';
  // 内核持久化目录要传（模板里的 Actor 用了 snapshot 持久化，不传会明确报 PersistenceError）
  const application = createApp(app, {
    configDir: new URL('../config', import.meta.url).pathname,
    kernel: { logger: false, persistence: { dir: dataDir } },
  });
  await application.start();
  try {
    const address = http.address();
    const response = await fetch(`http://${String(address?.host)}:${String(address?.port)}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: '--x--\r\n',
    });
    assert.strictEqual(response.status, 400, '没带文件应当是 400（说明路由确实挂上了）');
  } finally {
    await application.stop({ timeoutMs: 5000 });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
