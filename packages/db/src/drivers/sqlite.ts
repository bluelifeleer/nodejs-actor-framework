import { AsyncLocalStorage } from 'node:async_hooks';
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

      /**
       * SQLite 只有一条连接。`await fn(scoped)` 的每个 await 点都会让出事件循环，
       * 如果不做隔离，**任何并发请求的写都会落进这个事务**，回滚时一起消失
       * （调用方早已收到 affected=1）。这里做两件事：
       *   1. `transactionTail`：事务之间串行，避免 "cannot start a transaction within a transaction"；
       *   2. `activeTransaction` 门：事务进行期间，外部调用先等它结束；
       *      事务回调里的调用通过 AsyncLocalStorage 识别，直接走同一条连接。
       */
      const txContext = new AsyncLocalStorage<Runner>();
      let activeTransaction: Promise<void> | null = null;
      let transactionTail: Promise<unknown> = Promise.resolve();

      const rawRunner: Runner = {
        async all(sql, params = []) {
          return db.prepare(sql).all(...(params as unknown[])) as Row[];
        },
        async run(sql, params = []) {
          const result = db.prepare(sql).run(...(params as unknown[]));
          return Number(result.changes);
        },
        async insertReturning(sql, params = []) {
          // SQLite 3.35+ 支持 RETURNING，node:sqlite 也一样（用 all() 取回结果行）
          return db.prepare(sql).all(...(params as unknown[])) as Row[];
        },
      };

      const scopedRunner: Runner = { ...rawRunner };
      /**
       * 外部操作排队：事务期间进入时先等事务结束，事务结束后才能执行。
       * 用 `opTail` 而不是"检查一次 activeTransaction"是为了避免唤醒后与下一个事务
       * 抢跑（微任务顺序不确定，检查一次的写法仍有窗口）。
       */
      let opTail: Promise<unknown> = Promise.resolve();
      const enqueueOp = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = opTail.then(async () => {
          const active = activeTransaction;
          if (active !== null) await active;
          return fn();
        });
        opTail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };

      const api: Runner = {
        async all(sql, params = []) {
          if (txContext.getStore() !== null && txContext.getStore() !== undefined) {
            return rawRunner.all(sql, params);
          }
          return enqueueOp(() => rawRunner.all(sql, params));
        },
        async run(sql, params = []) {
          if (txContext.getStore() !== null && txContext.getStore() !== undefined) {
            return rawRunner.run(sql, params);
          }
          return enqueueOp(() => rawRunner.run(sql, params));
        },
        async insertReturning(sql, params = []) {
          if (txContext.getStore() !== null && txContext.getStore() !== undefined) {
            return rawRunner.insertReturning?.(sql, params) ?? [];
          }
          return enqueueOp(async () => rawRunner.insertReturning?.(sql, params) ?? []);
        },
        transaction<R>(fn: (scoped: Runner) => Promise<R>): Promise<R> {
          if (txContext.getStore() !== null && txContext.getStore() !== undefined) {
            return Promise.reject(new Error('sqlite: nested transaction is not supported'));
          }
          const run = async (): Promise<R> => {
            // 先把已经排队的外部操作做完，再 BEGIN；否则它们会撞进事务
            await opTail;
            let release!: () => void;
            const done = new Promise<void>((resolve) => {
              release = resolve;
            });
            activeTransaction = done;
            db.exec('BEGIN');
            try {
              const result = await txContext.run(scopedRunner, () => fn(scopedRunner));
              db.exec('COMMIT');
              return result;
            } catch (err) {
              try {
                db.exec('ROLLBACK');
              } catch {
                /* 已经回滚 */
              }
              throw err;
            } finally {
              activeTransaction = null;
              release();
            }
          };
          const next = transactionTail.then(run, run);
          transactionTail = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
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
          // 不要让 close 横切一个进行中的事务（否则 COMMIT 会打在已关闭的连接上）
          await transactionTail.catch(() => undefined);
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
