import path from 'node:path';

import { defineModule, type Application } from '@actor/app';
import { createDatabase, type Database } from '@actor/db';

import routes from './routes.ts';
import { Note } from './models.ts';

/**
 * 数据库接线：**连接配置由使用者给、驱动由使用者装，框架负责连接池与生命周期**。
 *
 * - provider 里建库并 `connect()`（拿不到连接就启动失败，不静默降级）；
 * - `sync()` 建表（生产里建议把 `migrations.auto` 关掉、用迁移脚本，这里演示自动建表）；
 * - `onStop` 里**优雅关池**（等查询结束再释放）。
 */
let db: Database | null = null;

export default defineModule({
  name: 'db',
  providers: {
    /**
     * 仓储作为 provider 注入：控制器里用 `ctx.get('notes')`。
     *
     * 注意：**provider 是同步解析的**（app 解析依赖时不会 await 你的 promise），所以这里只
     * **同步**建句柄并返回仓储；真正需要等待的 `connect()`/`sync()` 放在 `onStart` 里。
     * 这能成立是因为 `db.repository()` 用的是**惰性 runner**：拿到仓储时不需要已连接，
     * 真发查询时才要求连接就绪。
     */
    notes: ({ config }) => {
      const driver = config.get<string>('database.driver');
      const url = config.get<string>('database.url');
      const file = path.resolve(config.get<string>('database.file'));
      db = createDatabase({
        ...(url === '' ? { dialect: driver as never, connection: { filename: file } } : { connection: { url } }),
        pool: { max: config.get<number>('database.poolMax') },
        // 演示：允许自动补安全列（生产建议关掉、走显式迁移）
        migrations: { auto: true },
        logger: (event, meta) => console.log(`[db] ${event}`, meta ? JSON.stringify(meta) : ''),
      } as never);
      return db.repository(Note);
    },
  },
  routes,

  async onStart(app: Application) {
    if (db === null) throw new Error('provider "notes" 没有被解析：数据库句柄不存在');
    await db.connect();
    const health = await db.healthCheck();
    if (!health.ok) throw new Error(`数据库不可用：${String(health.error)}`);
    await db.sync([Note]);
    // 5xx 在服务端本来会被错误映射"藏起来"（只回一句 internal error）——
    // 现在有 http:error 事件，应用侧可以看见并记录（这里直接打到 stderr，真实项目接日志器）。
    app.on('http:error', (info: unknown) => {
      const detail = info as { status?: number; path?: string; error?: { name?: string; message?: string } };
      console.error(`[db-app] http ${String(detail.status)} ${String(detail.path)}: ${String(detail.error?.name)} ${String(detail.error?.message)}`);
    });
  },

  async onStop() {
    await db?.close(); // 优雅关池
    db = null;
  },
});

/** 便于测试/示例读取真实句柄（应用层不强制暴露，这里只是演示）。 */
export function currentDatabase(): Database | null {
  return db;
}

export type AppWithDb = Application;
