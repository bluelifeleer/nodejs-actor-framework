import { createRequire } from 'node:module';

import { DbConnectionError } from '../errors.ts';
import type { DriverFactory, DriverPool, Row, Runner } from './types.ts';

const require = createRequire(import.meta.url);

/** `node:sqlite` 的最小结构视图（Node 24 内置；不写死类型，避免和 @types/node 版本耦合）。 */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint };
  get?(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

function loadSqlite(): SqliteModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as SqliteModule;
  } catch (err) {
    throw new DbConnectionError(
      'sqlite support needs Node 24+ (the built-in `node:sqlite` module was not found)',
      err,
    );
  }
}

/**
 * SQLite 驱动：用 **Node 24 内置 `node:sqlite`**，零依赖。
 *
 * SQLite 是**单连接**语义：没有连接池，写操作天然串行。框架仍走同一套 `DriverPool` 接口，
 * 并把 `busy_timeout` 设上（多进程/多连接访问同一文件时才不会立刻 SQLITE_BUSY）。
 */
export function createSqliteDriver(loadModule: () => SqliteModule = loadSqlite): DriverFactory {
  return {
    name: 'node:sqlite',
    async create(connection, poolOptions): Promise<DriverPool> {
      const mod = loadModule();
      const filename = connection.filename ?? ':memory:';
      let db: SqliteDatabase;
      try {
        db = new mod.DatabaseSync(filename);
      } catch (err) {
        throw new DbConnectionError(`cannot open sqlite database "${filename}": ${err instanceof Error ? err.message : String(err)}`, err);
      }
      // 等待锁的时间（默认 5s）；:memory: 也无害
      try {
        db.exec('PRAGMA busy_timeout = 5000');
      } catch {
        /* 某些构建不支持也无所谓 */
      }

      const api: Runner = {
        async all(sql, params = []) {
          return db.prepare(sql).all(...(params as unknown[])) as Row[];
        },
        async run(sql, params = []) {
          const result = db.prepare(sql).run(...(params as unknown[]));
          return Number(result.changes);
        },
        async transaction<R>(fn: (scoped: Runner) => Promise<R>): Promise<R> {
          db.exec('BEGIN');
          try {
            const result = await fn(api);
            db.exec('COMMIT');
            return result;
          } catch (err) {
            try {
              db.exec('ROLLBACK');
            } catch {
              /* 已经回滚 */
            }
            throw err;
          }
        },
      };

      let closed = false;
      return {
        ...api,
        async healthCheck() {
          if (closed) throw new DbConnectionError(`sqlite database "${filename}" is closed`);
          db.prepare('SELECT 1 AS ok').all();
        },
        async close() {
          if (closed) return;
          closed = true;
          db.close();
        },
        stats() {
          const max = (poolOptions as { max?: number }).max;
          return { kind: 'sqlite', filename, connections: closed ? 0 : 1, maxConnections: max ?? 1 };
        },
      };
    },
  };
}
