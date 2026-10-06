import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { MIGRATIONS_SOURCE, cli, makeProject, removeProject } from './helpers.ts';

test('doctor: 结构完整、迁移已应用的项目全绿（退出码 0）', async () => {
  const dir = makeProject('doctor-ok', { 'src/migrations.ts': MIGRATIONS_SOURCE });
  try {
    // 未应用的迁移会被 doctor 判为问题（应用启动时会拒绝启动），所以先应用
    const up = await cli(['migrate', 'up', '--dir', dir]);
    assert.strictEqual(up.code, 0);

    // --port 0 表示"跳过端口检查"（随机端口没有意义）
    const result = await cli(['doctor', '--dir', dir, '--port', '0']);
    assert.strictEqual(result.code, 0, `期望全绿：\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /全部通过/);
    for (const name of ['Node 版本', '依赖声明', '文件 src/app.ts', '配置', '数据目录', '迁移']) {
      assert.match(result.stdout, new RegExp(`✓ ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `缺少检查项 ${name}`);
    }
  } finally {
    removeProject(dir);
  }
});

test('doctor: 缺配置/缺启动入口/未应用迁移 → 退出码 2，每项给"下一步做什么"', async () => {
  const dir = makeProject('doctor-bad', { 'src/migrations.ts': MIGRATIONS_SOURCE });
  try {
    fs.rmSync(path.join(dir, 'config', 'default.ts'));
    fs.rmSync(path.join(dir, 'main.ts'));

    const result = await cli(['doctor', '--dir', dir, '--port', '0']);
    assert.strictEqual(result.code, 2, '有问题时退出码 2（脚本能区分）');
    assert.match(result.stdout, /✗ 文件 main\.ts/);
    assert.match(result.stdout, /✗ 配置/);
    assert.match(result.stdout, /→ /, '每一项失败都要给出下一步');
    assert.match(result.stdout, /发现 \d+ 个问题/);

    const json = JSON.parse((await cli(['doctor', '--dir', dir, '--port', '0', '--json'])).stdout) as {
      problems: number;
      checks: { name: string; ok: boolean; fix?: string }[];
    };
    assert.ok(json.problems >= 2);
    const failed = json.checks.filter((check) => !check.ok);
    assert.ok(failed.every((check) => typeof check.fix === 'string'), '未通过的检查都要有 fix');
  } finally {
    removeProject(dir);
  }
});

test('doctor: 端口被占用能看出来（最常见的"起不来"）', async () => {
  const dir = makeProject('doctor-port');
  const net = await import('node:net');
  const taken = net.createServer();
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
  const port = (taken.address() as { port: number }).port;
  try {
    const result = await cli(['doctor', '--dir', dir, '--port', String(port)]);
    assert.strictEqual(result.code, 2);
    assert.match(result.stdout, new RegExp(`✗ 端口 ${port}`));
    assert.match(result.stdout, /已被占用/);
    assert.match(result.stdout, /APP_PLUGINS__HTTP__PORT/);
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
    removeProject(dir);
  }
});
