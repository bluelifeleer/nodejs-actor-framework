/**
 * 内存仓储（M3 第 3 步）：测试与轻量场景用；同时它是**语义基准**——
 * file / SQL 适配器必须与它逐条对齐（游标分页、version 冲突、where 等值过滤）。
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
import {
  compareRows,
  decodeCursor,
  encodeCursor,
  isAfterCursor,
  normalizeQuery,
} from './cursor.ts';

type Entity = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface MemoryRepositoryOptions extends RepositoryOptions {
  /** 预置数据（按 id 去重，后写入的覆盖先前的）。 */
  seed?: readonly Entity[];
}

export function createMemoryRepository<T extends Entity = Entity>(
  options: MemoryRepositoryOptions = {},
): Repository<T> {
  const { idField, versionField } = resolveRepositoryOptions(options);
  const rows = new Map<string, Entity>();
  const capabilities: RepositoryCapabilities = { conditionalUpdate: 'in-process', transaction: 'in-process' };

  if (options.seed) for (const row of options.seed) rows.set(String(row[idField]), clone(row));

  /** 事务串行化：同一仓储上的 transaction() 依次执行（内存里"原子"的就是这一段）。 */
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const api: Repository<T> = {
    capabilities: () => capabilities,

    async findById(id) {
      const row = rows.get(String(id));
      return row === undefined ? null : clone(row as T);
    },

    async findMany(query?: RepositoryQuery): Promise<RepositoryPage<T>> {
      const { where, orderBy, direction, limit, cursor } = normalizeQuery(query as Record<string, unknown>, {
        idField,
      });
      const decoded = cursor === null ? null : decodeCursor(cursor);

      const matched = [...rows.values()].filter((row) =>
        Object.entries(where).every(([field, value]) => row[field] === value),
      );
      matched.sort((a, b) => compareRows(a, b, orderBy, idField, direction));

      const page = decoded === null ? matched : matched.filter((row) => isAfterCursor(row, decoded, orderBy, idField, direction));
      const slice = page.slice(0, limit + 1); // 多取一条：用来判断"还有没有下一页"
      const hasMore = slice.length > limit;
      const items = (hasMore ? slice.slice(0, limit) : slice).map((row) => clone(row as T));
      const last = items[items.length - 1] as Entity | undefined;
      return hasMore && last !== undefined
        ? { items, cursor: encodeCursor({ key: (last[orderBy] ?? null) as string | number | null, id: last[idField] as string | number }) }
        : { items };
    },

    async insert(entity) {
      const row = clone(entity) as Entity;
      const id = row[idField] === undefined || row[idField] === null ? `id-${globalThis.crypto.randomUUID()}` : row[idField];
      const key = String(id);
      if (rows.has(key)) throw new RepositoryDuplicateError(key);
      row[idField] = id;
      row[versionField] = 1;
      rows.set(key, row);
      return clone(row as T);
    },

    async update(id, patch, updateOptions = {}) {
      const key = String(id);
      const row = rows.get(key);
      const expected = updateOptions.expectedVersion;
      if (expected !== undefined && !Number.isInteger(expected)) {
        throw new RepositoryQueryError(`expectedVersion 必须是整数（当前 ${String(expected)}）`);
      }
      const actual = row === undefined ? null : (row[versionField] as number);
      if (expected !== undefined && actual !== expected) throw new RepositoryConflictError(key, expected, actual);
      if (row === undefined) throw new RepositoryNotFoundError(key);

      const next = { ...row, ...clone(patch) } as Entity;
      next[idField] = row[idField]; // id 不可改（否则游标与索引都会失效）
      next[versionField] = (row[versionField] as number) + 1;
      rows.set(key, next);
      return clone(next as T);
    },

    async delete(id) {
      return rows.delete(String(id));
    },

    transaction<R>(fn: (tx: Repository<T>) => Promise<R>): Promise<R> {
      return serialize(() => fn(api));
    },
  };

  return api;
}
