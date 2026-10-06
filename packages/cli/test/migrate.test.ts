import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { MIGRATIONS_SOURCE, cli, makeProject, removeProject } from './helpers.ts';

test('migrate: status 在有未应用迁移时退出码 2（CI/启动脚本要靠它）', async () => {
  const dir = makeProject('migrate-status', { 'src/migrations.ts': MIGRATIONS_SOURCE });
  try {
    const status = await cli(['migrate', 'status', '--dir', dir]);
    assert.strictEqual(status.code, 2, '有未应用迁移 = 需要处理，退出码要非零');
    assert.match(status.stdout, /待应用 v1, v2/, '待应用要打印版本号（曾经打印 v[object Object]）');
    assert.match(status.stdout, /注意：有未应用迁移/);

    const json = await cli(['migrate', 'status', '--dir', dir, '--json']);
    const parsed = JSON.parse(json.stdout) as { status: { pending: number[]; applied: number[] } };
    assert.deepStrictEqual(parsed.status.pending, [1, 2]);
    assert.deepStrictEqual(parsed.status.applied, []);
  } finally {
    removeProject(dir);
  }
});

test('migrate: up 是幂等的；down 必须显式给 --to（绝不猜回滚到哪）', async () => {
  const dir = makeProject('migrate-updown', { 'src/migrations.ts': MIGRATIONS_SOURCE });
  const data = fs.mkdtempSync(path.join(dir, 'data-'));
  try {
    const up = await cli(['migrate', 'up', '--dir', dir, '--data', data]);
    assert.strictEqual(up.code, 0);
    assert.match(up.stdout, /本次应用：v1, v2/);

    const again = await cli(['migrate', 'up', '--dir', dir, '--data', data]);
    assert.strictEqual(again.code, 0);
    assert.match(again.stdout, /没有需要应用的迁移/, '再跑一次什么都不做（幂等）');

    const noTarget = await cli(['migrate', 'down', '--dir', dir, '--data', data]);
    assert.strictEqual(noTarget.code, 1, '缺少 --to 是用法错误');
    assert.match(noTarget.stderr, /需要显式目标版本/);
    assert.match(noTarget.stderr, /--to/, '要告诉用户怎么写');

    const down = await cli(['migrate', 'down', '--to', '1', '--dir', dir, '--data', data]);
    assert.strictEqual(down.code, 0);
    assert.match(down.stdout, /本次回滚：v2/);

    const after = await cli(['migrate', 'status', '--dir', dir, '--data', data, '--json']);
    const parsed = JSON.parse(after.stdout) as { status: { applied: number[]; pending: number[] } };
    assert.deepStrictEqual(parsed.status.applied, [1]);
    assert.deepStrictEqual(parsed.status.pending, [2], '回滚过的迁移又变成未应用');

    const unknownAction = await cli(['migrate', 'rollback', '--dir', dir]);
    assert.strictEqual(unknownAction.code, 1);
    assert.match(unknownAction.stderr, /未知的迁移动作 'rollback'/);
  } finally {
    removeProject(dir);
  }
});

test('migrate: 没有 src/migrations.ts 的项目不是错误，而是"还没有迁移"', async () => {
  const dir = makeProject('migrate-none');
  try {
    const status = await cli(['migrate', 'status', '--dir', dir]);
    assert.strictEqual(status.code, 0, '没写迁移不算问题');
    assert.match(status.stdout, /还没有迁移/);
    assert.match(status.stdout, /src\/migrations\.ts/, '要告诉用户约定位置在哪');
  } finally {
    removeProject(dir);
  }
});

test('project: 目录不存在 / 不是项目 / 迁移导出有问题 → 退出码 2 且给出下一步', async () => {
  const missing = await cli(['doctor', '--dir', path.join(ROOT_TMP(), 'definitely-missing')]);
  assert.strictEqual(missing.code, 2);
  assert.match(missing.stderr, /目录不存在/);
  assert.match(missing.stderr, /提示：/);

  const notProject = fs.mkdtempSync(path.join(ROOT_TMP(), 'not-a-project-'));
  const stray = path.join(notProject, 'file.txt');
  fs.writeFileSync(stray, 'x');
  try {
    const result = await cli(['doctor', '--dir', notProject]);
    assert.strictEqual(result.code, 2);
    assert.match(result.stderr, /看起来不是 actor 项目/);
    assert.match(result.stderr, /actor new app/);
  } finally {
    fs.rmSync(notProject, { recursive: true, force: true });
  }

  const badMigrations = makeProject('migrate-bad', { 'src/migrations.ts': 'export default 42;\n' });
  try {
    const result = await cli(['migrate', 'status', '--dir', badMigrations]);
    assert.strictEqual(result.code, 2);
    assert.match(result.stderr, /迁移不是数组/);
  } finally {
    removeProject(badMigrations);
  }

  const noExport = makeProject('migrate-noexport', { 'src/migrations.ts': 'export const nothing = 1;\n' });
  try {
    const result = await cli(['migrate', 'status', '--dir', noExport]);
    assert.strictEqual(result.code, 2);
    assert.match(result.stderr, /没有导出迁移/);
  } finally {
    removeProject(noExport);
  }
});

function ROOT_TMP(): string {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '.tmp-cli');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
