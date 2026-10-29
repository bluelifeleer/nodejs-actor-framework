/**
 * SQL 薄适配器（M3 第 3 步③）。
 *
 * **框架不生成"查询"，只发固定形状的 CRUD**：`where` 等值 → `col = ?`，游标 → 键值比较，
 * 排序 → `ORDER BY`。真正连接数据库的能力由你提供（`runner`）——
 * 这是"薄封装"的含义：不接管你的 schema、不引驱动、不做查询构建器（doc 06 §3）。
 *
 * 两条安全线：
 *   1. **标识符走白名单**：表名由配置给出，列名只能来自 `fields` / `columns`；`where`、`orderBy`
 *      里出现的字段必须在白名单内，否则抛 `RepositoryQueryError`（不让字段名变成注入点）；
 *   2. **值永远参数化**：所有比较值、`LIMIT`、keyset 参数都走占位符，绝不拼字符串。
 *
 * 乐观锁走**真 CAS**：`UPDATE … SET version = version + 1 WHERE id = ? AND version = ?`
 * —— 受影响行数为 0 再回查一次以区分"版本冲突"与"实体不存在"。所以本适配器的
 * `capabilities().conditionalUpdate === 'atomic'`（这是三个适配器里唯一的一档）。
 */

import {
  RepositoryConflictError,
  RepositoryDuplicateError,
  RepositoryNotFoundError,
  RepositoryQueryError,
  resolveRepositoryOptions,
  type Repository,
  type RepositoryCapabilities,
  type RepositoryOptions,
  type RepositoryPage,
  type RepositoryQuery,
} from './types.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

import { decodeCursor, encodeCursor, normalizeQuery } from './cursor.ts';

type Entity = Record<string, unknown>;

/** 你提供的数据库能力；包一层你自己的驱动即可（见文档里的 pg / mysql2 / better-sqlite3 示例）。 */
export interface SqlRunner {
  /** 执行 SELECT，返回行。 */
  all(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /** 执行写语句，返回**受影响行数**。 */
  run(sql: string, params: readonly unknown[]): Promise<number>;
  /**
   * 可选：真事务。**必须把"事务范围内的 runner"交给回调**——否则仓储内部的语句会走连接池，
   * 根本不在你开启的那个事务里（那样"数据库事务"这个能力就是假的）。
   *
   * 典型实现（pg）：
   * ```ts
   * transaction: async (fn) => {
   *   const client = await pool.connect();
   *   try {
   *     await client.query('BEGIN');
   *     const scoped = {
   *       all: async (sql, params) => (await client.query(sql, params)).rows,
   *       run: async (sql, params) => (await client.query(sql, params)).rowCount,
   *     };
   *     const result = await fn(scoped);
   *     await client.query('COMMIT');
   *     return result;
   *   } catch (err) {
   *     await client.query('ROLLBACK');
   *     throw err;
   *   } finally {
   *     client.release();
   *   }
   * },
   * ```
   *
   * 不提供时 `transaction()` 退化为"本进程串行"（`capabilities().transaction === 'in-process'`）。
   */
  transaction?<R>(fn: (scoped: SqlRunner) => Promise<R>): Promise<R>;
}

export interface SqlRepositoryOptions extends RepositoryOptions {
  runner: SqlRunner;
  /** 表名（你自己建表/迁移，框架不接管 schema）。 */
  table: string;
  /** 参与读写的字段白名单（默认与 `id`/`version` 合并）。顺序不重要，但必须覆盖你用的字段。 */
  fields: readonly string[];
  /** 字段名 → 列名（默认同名）。 */
  columns?: Readonly<Record<string, string>>;
  /** 占位符风格：默认 `?`（SQLite / MySQL）；PostgreSQL 用 `(i) => `$${i}``。 */
  placeholder?: (index: number) => string;
  /** id 生成器（默认 `id-<uuid>`）。 */
  generateId?: () => string;
  /** 驱动抛出的"唯一约束冲突"判定；给了它，insert 撞 id 会抛 `RepositoryDuplicateError`。 */
  isUniqueViolation?: (error: unknown) => boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function createSqlRepository<T extends Entity = Entity>(options: SqlRepositoryOptions): Repository<T> {
  if (!options?.runner || typeof options.runner.all !== 'function' || typeof options.runner.run !== 'function') {
    throw new RepositoryQueryError('createSqlRepository 需要 runner（提供 all / run 两个方法）');
  }
  if (typeof options.table !== 'string' || !IDENTIFIER.test(options.table)) {
    throw new RepositoryQueryError(`table 必须是简单标识符（当前 ${JSON.stringify(options.table)}）`);
  }
  const { idField, versionField } = resolveRepositoryOptions(options);
  const fields = [...new Set([idField, versionField, ...options.fields])];
  for (const field of fields) {
    if (!IDENTIFIER.test(field)) throw new RepositoryQueryError(`字段名必须是简单标识符：${JSON.stringify(field)}`);
  }
  const columns = options.columns ?? {};
  for (const column of Object.values(columns)) {
    if (!IDENTIFIER.test(String(column))) {
      throw new RepositoryQueryError(`列名必须是简单标识符：${JSON.stringify(column)}`);
    }
  }

  const { runner, table } = options;
  /**
   * 事务期间的 runner 必须**跟着异步上下文走**，不能是实例字段：
   * 实例字段会被事务外的并发调用看到，让它们跑进别人的事务、随回滚静默丢失。
   */
  const txContext = new AsyncLocalStorage<SqlRunner>();
  const runnerNow = (): SqlRunner => txContext.getStore() ?? runner;
  const ph = options.placeholder ?? (() => '?');
  const columnOf = (field: string): string => {
    if (!fields.includes(field)) {
      throw new RepositoryQueryError(`字段 '${field}' 不在声明的 fields 白名单里（防注入经由标识符）`);
    }
    const column = columns[field] ?? field;
    return column;
  };
  const capabilities: RepositoryCapabilities = {
    conditionalUpdate: 'atomic', // 真 CAS：WHERE version = ?
    transaction: typeof runner.transaction === 'function' ? 'database' : 'in-process',
  };

  const selectColumns = fields.map((field) => columnOf(field)).join(', ');

  const fromRow = (row: Record<string, unknown>): Entity => {
    const entity: Entity = {};
    for (const field of fields) entity[field] = row[columns[field] ?? field];
    return entity;
  };
  const clone = <V>(value: V): V => structuredClone(value);

  /** 本进程内串行（没有数据库事务时的兜底；能力已如实标注）。 */
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function selectById(id: string): Promise<Entity | null> {
    const rows = await runnerNow().all(
      `SELECT ${selectColumns} FROM ${table} WHERE ${columnOf(idField)} = ${ph(1)}`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : fromRow(row);
  }

  const api: Repository<T> = {
    capabilities: () => capabilities,

    async findById(id) {
      const row = await selectById(String(id));
      return row === null ? null : (clone(row) as T);
    },

    async findMany(query?: RepositoryQuery): Promise<RepositoryPage<T>> {
      const { where, orderBy, direction, limit, cursor } = normalizeQuery(query as Record<string, unknown>, {
        idField,
      });
      const orderColumn = columnOf(orderBy);
      const idColumn = columnOf(idField);
      const params: unknown[] = [];
      const clauses: string[] = [];

      for (const [field, value] of Object.entries(where)) {
        const column = columnOf(field);
        if (value === null) {
          clauses.push(`${column} IS NULL`); // SQL 里 = NULL 永远不成立
        } else {
          params.push(value);
          clauses.push(`${column} = ${ph(params.length)}`);
        }
      }

      const decoded = cursor === null ? null : decodeCursor(cursor);
      if (decoded !== null) {
        if (decoded.key === null) {
          throw new RepositoryQueryError(
            'cursor 里的排序键是 null：SQL 后端的键值分页不支持 NULL 排序键（排序字段请保证非空）',
          );
        }
        // NULL 是排序里最麻烦的东西（SQL 的 NULL 比较恒为 NULL），所以直接拒绝而不是"看起来能跑"
        const operator = direction === 'desc' ? '<' : '>';
        const keyIndex = params.push(decoded.key);
        const equalIndex = params.push(decoded.key);
        const idIndex = params.push(decoded.id);
        clauses.push(
          `(${orderColumn} ${operator} ${ph(keyIndex)} OR (${orderColumn} = ${ph(equalIndex)} AND ${idColumn} ${operator} ${ph(idIndex)}))`,
        );
      }

      params.push(limit + 1); // 多取一条判断有没有下一页
      const sql =
        `SELECT ${selectColumns} FROM ${table}` +
        (clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '') +
        ` ORDER BY ${orderColumn} ${direction === 'desc' ? 'DESC' : 'ASC'}, ${idColumn} ${
          direction === 'desc' ? 'DESC' : 'ASC'
        } LIMIT ${ph(params.length)}`;

      const rows = await runnerNow().all(sql, params);
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => clone(fromRow(row)) as T);
      const last = items[items.length - 1] as Entity | undefined;
      return hasMore && last !== undefined
        ? {
            items,
            cursor: encodeCursor({
              key: (last[orderBy] ?? null) as string | number | null,
              id: last[idField] as string | number,
            }),
          }
        : { items };
    },

    async insert(entity) {
      const row = clone(entity) as Entity;
      const existingId = row[idField];
      const id =
        existingId === undefined || existingId === null
          ? (options.generateId?.() ?? `id-${globalThis.crypto.randomUUID()}`)
          : existingId;
      row[idField] = id;
      row[versionField] = 1;

      const placeholders = fields.map((_, index) => ph(index + 1)).join(', ');
      try {
        await runnerNow().run(
          `INSERT INTO ${table} (${fields.map((field) => columnOf(field)).join(', ')}) VALUES (${placeholders})`,
          fields.map((field) => row[field] ?? null),
        );
      } catch (err) {
        const unique =
          options.isUniqueViolation?.(err) ??
          /23505|ER_DUP_ENTRY|SQLITE_CONSTRAINT|duplicate key|unique constraint/i.test(
            `${(err as { code?: unknown })?.code ?? ''} ${(err as Error)?.message ?? ''}`,
          );
        if (unique) throw new RepositoryDuplicateError(String(id));
        throw err;
      }
      const stored = await selectById(String(id));
      return clone((stored ?? row) as T);
    },

    async update(id, patch, updateOptions = {}) {
      const key = String(id);
      const expected = updateOptions.expectedVersion;
      if (expected !== undefined && !Number.isInteger(expected)) {
        throw new RepositoryQueryError(`expectedVersion 必须是整数（当前 ${String(expected)}）`);
      }
      const patchFields = Object.keys(patch ?? {});
      for (const field of patchFields) {
        if (field === idField) continue; // id 不可改（静默忽略，与内存/文件一致）
        columnOf(field); // 白名单校验（未知字段直接报错，而不是静默丢掉）
      }

      const params: unknown[] = [];
      const setClauses: string[] = [];
      for (const field of patchFields) {
        if (field === idField) continue;
        params.push((patch as Entity)[field] ?? null);
        setClauses.push(`${columnOf(field)} = ${ph(params.length)}`);
      }
      setClauses.push(`${columnOf(versionField)} = ${columnOf(versionField)} + 1`);

      params.push(key);
      const where = [`${columnOf(idField)} = ${ph(params.length)}`];
      if (expected !== undefined) {
        params.push(expected);
        where.push(`${columnOf(versionField)} = ${ph(params.length)}`);
      }

      const changes = await runnerNow().run(
        `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${where.join(' AND ')}`,
        params,
      );
      if (changes === 0) {
        const current = await selectById(key);
        if (expected !== undefined) {
          throw new RepositoryConflictError(key, expected, current === null ? null : (current[versionField] as number));
        }
        throw new RepositoryNotFoundError(key);
      }
      const stored = await selectById(key);
      if (stored === null) throw new RepositoryNotFoundError(key);
      return clone(stored as T);
    },

    async delete(id) {
      const changes = await runnerNow().run(
        `DELETE FROM ${table} WHERE ${columnOf(idField)} = ${ph(1)}`,
        [String(id)],
      );
      return changes > 0;
    },

    transaction<R>(fn: (tx: Repository<T>) => Promise<R>): Promise<R> {
      return serialize(async () => {
        if (!runner.transaction) return fn(api);
        // 让事务内的语句走到事务连接上；结束（含抛错）后恢复原 runner
        return runner.transaction((scoped) => txContext.run(scoped, () => fn(api)));
      });
    },
  };

  return api;
}
