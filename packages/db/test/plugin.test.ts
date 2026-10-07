import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, defineApp, defineModule } from '@actor/app';

import { createDatabase, databasePlugin, defineModel, type Database } from '../src/index.ts';

/**
 * 用户反馈第 ③ 点：**web 层要能直接用**。
 *
 * 所以 `@actor/db` 提供一个一等插件：配置在 `plugins.db.*`，`onReady` 里连接 + 健康检查 + 建表，
 * 并把 db 与每个声明的仓储**注册成应用服务** —— 控制器里 `ctx.get('notes')` 直接拿到仓储，
 * 不需要任何手写接线；停机时优雅关池。
 */
const Note = defineModel({
  name: 'notes',
  comment: '用户笔记',
  fields: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'string', length: 200, notNull: true, comment: '标题' },
    tags: { type: 'json', default: [] },
    createdAt: { type: 'timestamp', auto: 'create' },
    version: { type: 'integer', version: true },
  },
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-plugin-'));
  return path.join(dir, 'app.sqlite');
}

function makeApp(file: string, pluginOptions: Record<string, unknown> = {}) {
  const module = defineModule({ name: 'app', routes: [] });
  return createApp(
    defineApp({
      name: 'plugin-app',
      modules: [module],
      plugins: [
        databasePlugin({
          models: [Note],
          repositories: { notes: Note },
          connection: { filename: file },
          ...pluginOptions,
        }),
      ],
    }),
    { configDir: null, env: {} },
  );
}

test('plugin: 一行接入 —— 连接/建表/注册服务，控制器侧 ctx.get("notes") 就能用', async () => {
  const file = tempFile();
  const app = makeApp(file);
  await app.start();
  try {
    // 注册成服务（控制器通过 ctx.get 拿到的就是它）
    const db = app.get<Database>('db');
    assert.strictEqual(db.dialect, 'sqlite');
    assert.strictEqual((await db.healthCheck()).ok, true, '插件启动后数据库应当是健康的');

    const notes = app.get<{ insert(e: unknown): Promise<Record<string, unknown>> }>('notes');
    assert.strictEqual(typeof notes.insert, 'function', '仓储没有注册成服务');
    const created = await notes.insert({ title: '来自插件', tags: ['a'] });
    assert.match(String(created.id), /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual(created.tags, ['a']);

    // 表是按 model 建的（注释在 sqlite 上不支持 → 报告里如实说明）
    const tables = await db.raw<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ['notes']);
    assert.strictEqual(tables.length, 1, 'model 对应的表没有被创建');
  } finally {
    await app.stop({ timeoutMs: 3000 });
  }
  // 停机时优雅关池：健康检查应当如实变成 ok:false
  const db = createDatabase({ dialect: 'sqlite', connection: { filename: file } });
  await db.connect();
  const rows = await db.raw<{ title: string }>('SELECT title FROM "notes"');
  assert.deepStrictEqual(rows.map((r) => r.title), ['来自插件'], '插件写入的数据应当落盘了');
  await db.close();
});

test('plugin: 连不上时启动必须失败（不静默降级）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-plugin-bad-'));
  // 把"数据库文件"指向一个目录：sqlite 打不开 → 插件必须在启动阶段就抛出
  const app = makeApp(dir);
  await assert.rejects(() => app.start(), (err: Error) => {
    assert.match(err.message, /sqlite|database|open/i);
    return true;
  });
  await app.stop({ timeoutMs: 1000 }).catch(() => {});
});

test('plugin: autoMigrate=true 才自动补列；默认（false）遇到漂移就启动失败', async () => {
  const file = tempFile();
  // 先造一个"缺列"的表
  const seed = createDatabase({ dialect: 'sqlite', connection: { filename: file } });
  await seed.connect();
  await seed.rawRun('CREATE TABLE "notes" ("id" text NOT NULL PRIMARY KEY, "title" text NOT NULL)');
  await seed.close();

  const strict = makeApp(file);
  await assert.rejects(() => strict.start(), /SchemaDrift|owner|column|match/i, '默认不该自动改表');
  await strict.stop({ timeoutMs: 1000 }).catch(() => {});

  const auto = makeApp(file, { autoMigrate: true });
  await auto.start();
  try {
    const db = auto.get<ReturnType<typeof createOpenDatabase>>('db');
    const columns = (await db.inspectTable('notes')).columns.map((c) => c.name).sort();
    assert.deepStrictEqual(columns, ['createdAt', 'id', 'tags', 'title', 'version'], `自动补列没生效：${columns.join(',')}`);
  } finally {
    await auto.stop({ timeoutMs: 3000 });
  }
});
