/**
 * **进程级**按路径写入锁（审计 F4）。
 *
 * `capabilities().conditionalUpdate === 'in-process'` 承诺的是"同进程安全"，而同进程里可能有
 * 两个仓储实例指向同一目录——实例级锁挡不住它们。按绝对路径在模块级串行化才配得上这个承诺；
 * 链 settle 后摘除，避免 Map 无界增长。
 */
const repositoryWriteChains = new Map<string, Promise<unknown>>();

function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repositoryWriteChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn) as Promise<T>;
  const tail: Promise<unknown> = run.then(
    () => undefined,
    () => undefined,
  );
  repositoryWriteChains.set(key, tail);
  void tail.then(() => {
    if (repositoryWriteChains.get(key) === tail) repositoryWriteChains.delete(key);
  });
  return run;
}

/**
 * 文件仓储（M3 第 3 步②）：一实体一文件 + 追加式索引（含 tombstone）。
 *
 * 布局：
 * ```
 * <dir>/entities/<id>-<hash>.json   一实体一文件，写盘用 tmp + rename（原子）
 * <dir>/index.jsonl                 追加式索引：{"id":…,"deleted"?:true,"at":…}
 * ```
 *
 * **索引是缓存，实体文件才是真相**：
 *   - 读单个实体一律直接读它的文件；
 *   - 索引只回答"哪些 id 存在、哪些已删除"——所以 `orderBy: id`（默认）**不必读实体文件**就能
 *     排出顺序，其它排序字段则必须读实体文件（O(n)，文件后端如实如此，大表请用 SQL/ORM 后端）；
 *   - `update` **完全不碰索引**（id 集合没变），于是"写实体文件成功、写索引失败"这个崩溃窗口
 *     对更新根本不存在；
 *   - 索引损坏/丢失时以实体文件为准：`rebuildIndex()` 重建；索引文件不存在但实体目录里有文件时
 *     自动重建。
 *
 * 并发：与持久化层同一套口径——**本进程内**串行（`capabilities().conditionalUpdate === 'in-process'`），
 * 跨进程不保证（文件后端没有 CAS）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

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
import { compareRows, decodeCursor, encodeCursor, isAfterCursor, normalizeQuery } from './cursor.ts';

type Entity = Record<string, unknown>;

function entityFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 10);
  return `${safe}-${hash}.json`;
}

export interface FileRepositoryOptions extends RepositoryOptions {
  /** 数据目录。 */
  dir: string;
  /** 索引条目超过这个数就自动压缩（默认 5000；0 = 不自动压）。 */
  compactThreshold?: number;
}

export interface FileRepository<T> extends Repository<T> {
  /** 以**实体文件为准**重建索引（手工删过文件、或索引丢了之后用）。 */
  rebuildIndex(): Promise<{ entities: number }>;
  /** 把同一 id 的重复索引条目折叠掉。 */
  compactIndex(): Promise<{ before: number; after: number }>;
}

export function createFileRepository<T extends Entity = Entity>(options: FileRepositoryOptions): FileRepository<T> {
  if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
    throw new RepositoryQueryError('createFileRepository 需要 dir（数据目录）');
  }
  const { idField, versionField } = resolveRepositoryOptions(options);
  const { dir } = options;
  const entitiesDir = path.join(dir, 'entities');
  const indexPath = path.join(dir, 'index.jsonl');
  const compactThreshold = options.compactThreshold ?? 5000;
  const capabilities: RepositoryCapabilities = { conditionalUpdate: 'in-process', transaction: 'in-process' };

  let indexCache: Map<string, boolean> | null = null;
  let indexEntryCount = 0;

  const entityPath = (id: string) => path.join(entitiesDir, entityFileName(id));

  function parseIndex(raw: string): Map<string, boolean> {
    const alive = new Map<string, boolean>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { id?: unknown; deleted?: unknown };
        if (typeof entry.id !== 'string') continue;
        alive.set(entry.id, entry.deleted !== true);
        indexEntryCount += 1;
      } catch {
        break; // 撕裂尾巴（崩溃中断的追加）：后面的当作没写
      }
    }
    return alive;
  }

  async function readIndexFile(): Promise<string> {
    try {
      return await fsp.readFile(indexPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  async function entityFiles(): Promise<string[]> {
    try {
      return (await fsp.readdir(entitiesDir)).filter((name) => name.endsWith('.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async function writeIndex(entries: Map<string, boolean>): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${indexPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const body = [...entries.entries()]
      .map(([id, alive]) => JSON.stringify(alive ? { id } : { id, deleted: true }))
      .join('\n');
    await fsp.writeFile(tmp, body.length > 0 ? `${body}\n` : '');
    await fsp.rename(tmp, indexPath);
    indexCache = entries;
    indexEntryCount = entries.size;
  }

  async function appendIndex(id: string, deleted: boolean): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    await fsp.appendFile(indexPath, `${JSON.stringify({ id, ...(deleted ? { deleted: true } : {}), at: Date.now() })}\n`);
    indexEntryCount += 1;
    if (indexCache) indexCache.set(id, !deleted);
    if (compactThreshold > 0 && indexEntryCount > compactThreshold) await compactIndex();
  }

  async function loadIndex(): Promise<Map<string, boolean>> {
    if (indexCache) return indexCache;
    indexEntryCount = 0;
    const alive = parseIndex(await readIndexFile());
    if (indexEntryCount === 0 && (await entityFiles()).length > 0) {
      // 索引不存在/为空但实体文件在 → 以实体文件为准重建（索引只是缓存）
      return (await rebuildIndex()).alive;
    }
    indexCache = alive;
    return alive;
  }

  async function readEntity(id: string): Promise<Entity | null> {
    try {
      const raw = await fsp.readFile(entityPath(id), 'utf8');
      const parsed = JSON.parse(raw) as Entity;
      return parsed === null || typeof parsed !== 'object' ? null : parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeEntity(id: string, entity: Entity): Promise<void> {
    fs.mkdirSync(entitiesDir, { recursive: true });
    const target = entityPath(id);
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(entity)}\n`);
    await fsp.rename(tmp, target); // 原子替换：读到的要么是旧版本，要么是新版本
  }

  async function rebuildIndex(): Promise<{ entities: number; alive: Map<string, boolean> }> {
    const alive = new Map<string, boolean>();
    for (const name of await entityFiles()) {
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(entitiesDir, name), 'utf8')) as Entity;
        const id = parsed?.[idField];
        if (typeof id === 'string' || typeof id === 'number') alive.set(String(id), true);
      } catch {
        /* 读不通的实体文件跳过：重建不能因为一个坏文件就整个失败 */
      }
    }
    await writeIndex(alive);
    return { entities: alive.size, alive };
  }

  async function compactIndex(): Promise<{ before: number; after: number }> {
    const before = indexEntryCount;
    const alive = indexCache ?? parseIndex(await readIndexFile());
    await writeIndex(new Map(alive));
    return { before, after: alive.size };
  }

  /**
   * 按 id 串行化"读-改-写"（审计 F4）：`conditionalUpdate: 'in-process'` 是给使用者的承诺，
   * 而 `update()` 原本是"读 → 检查 version → 写"、中间没有串行化 → 同进程并发两次都能成功。
   *
   * 刻意**不用**下面的全局 `serialize`：`transaction()` 已经持有它，事务里再调 `update()`
   * 会等自己、直接死锁。按 id 分链既满足承诺又不与事务互锁。
   */
  const serializeById = <R>(key: string, fn: () => Promise<R>): Promise<R> =>
    withPathLock(entityPath(key), fn);

  /** 本进程内串行（与内存适配器同一语义）。 */
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const orderOfIds = (ids: string[], direction: 'asc' | 'desc') => {
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return direction === 'desc' ? sorted.reverse() : sorted;
  };

  const api: FileRepository<T> = {
    capabilities: () => capabilities,
    rebuildIndex: async () => ({ entities: (await rebuildIndex()).entities }),
    compactIndex,

    async findById(id) {
      const row = await readEntity(String(id));
      return row === null ? null : (structuredClone(row) as T);
    },

    async findMany(query?: RepositoryQuery): Promise<RepositoryPage<T>> {
      const { where, orderBy, direction, limit, cursor } = normalizeQuery(query as Record<string, unknown>, {
        idField,
      });
      const alive = await loadIndex();
      const liveIds = [...alive.entries()].filter(([, isAlive]) => isAlive).map(([id]) => id);

      if (orderBy === idField && Object.keys(where).every((field) => field === idField)) {
        // 只按 id（默认排序）且过滤条件也只涉及 id：**不必读实体文件**就能排出顺序
        let ids = orderOfIds(liveIds, direction);
        const wanted = where[idField];
        if (wanted !== undefined) ids = ids.filter((id) => id === String(wanted));
        const decoded = cursor === null ? null : decodeCursor(cursor);
        if (decoded !== null) {
          // 排序键就是 id 本身，而 id 唯一 ⇒ 判据直接是"严格大于/小于游标里的 id"，不需要 tie-breaker
          const pivot = String(decoded.id);
          ids = ids.filter((id) => (direction === 'desc' ? id < pivot : id > pivot));
        }
        const pageIds = ids.slice(0, limit + 1);
        const rows: Entity[] = [];
        for (const id of pageIds) {
          const row = await readEntity(id);
          if (row !== null) rows.push(row); // 索引说存在但文件没了 → 跳过（rebuildIndex 可修）
        }
        const hasMore = rows.length > limit;
        const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => structuredClone(row) as T);
        const last = items[items.length - 1] as Entity | undefined;
        return hasMore && last !== undefined
          ? { items, cursor: encodeCursor({ key: String(last[idField]), id: last[idField] as string | number }) }
          : { items };
      }

      // 其它排序字段：必须读实体文件（O(n)，文件后端如实如此）
      const ordered: Entity[] = [];
      for (const id of liveIds) {
        const row = await readEntity(id);
        if (row === null) continue;
        if (!Object.entries(where).every(([field, value]) => row[field] === value)) continue;
        ordered.push(row);
      }
      ordered.sort((a, b) => compareRows(a, b, orderBy, idField, direction));
      const decoded = cursor === null ? null : decodeCursor(cursor);
      const page =
        decoded === null ? ordered : ordered.filter((row) => isAfterCursor(row, decoded, orderBy, idField, direction));
      const slice = page.slice(0, limit + 1);
      const hasMore = slice.length > limit;
      const items = (hasMore ? slice.slice(0, limit) : slice).map((row) => structuredClone(row) as T);
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
      const row = structuredClone(entity) as Entity;
      const existingId = row[idField];
      const id =
        existingId === undefined || existingId === null ? `id-${globalThis.crypto.randomUUID()}` : existingId;
      const key = String(id);
      // 查重 + 写入必须在同一把 per-id 锁里：否则两个并发 insert 都会通过检查
      return serializeById(key, async () => {
        if ((await readEntity(key)) !== null) throw new RepositoryDuplicateError(key);
        row[idField] = id;
        row[versionField] = 1;
        await writeEntity(key, row);
        await appendIndex(key, false);
        return structuredClone(row) as T;
      });
    },

    async update(id, patch, updateOptions = {}) {
      const key = String(id);
      const expected = updateOptions.expectedVersion;
      if (expected !== undefined && !Number.isInteger(expected)) {
        throw new RepositoryQueryError(`expectedVersion 必须是整数（当前 ${String(expected)}）`);
      }
      return serializeById(key, async () => {
        const row = await readEntity(key);
        const actual = row === null ? null : (row[versionField] as number);
        if (expected !== undefined && actual !== expected) throw new RepositoryConflictError(key, expected, actual);
        if (row === null) throw new RepositoryNotFoundError(key);

        const next = { ...row, ...structuredClone(patch) } as Entity;
        next[idField] = row[idField]; // id 不可改
        next[versionField] = (row[versionField] as number) + 1;
        await writeEntity(key, next);
        // 更新不碰索引：id 集合没变，于是"实体写了、索引没写"这个崩溃窗口不存在
        return structuredClone(next) as T;
      });
    },

    async delete(id) {
      const key = String(id);
      // 与 update 共用 per-id 锁：否则 update 可能在 unlink 之后写回（实体复活），
      // 或两个 delete 同时 unlink（裸 ENOENT）。
      return serializeById(key, async () => {
        if ((await readEntity(key)) === null) return false;
        try {
          await fsp.unlink(entityPath(key));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw err;
        }
        await appendIndex(key, true);
        return true;
      });
    },

    transaction<R>(fn: (tx: Repository<T>) => Promise<R>): Promise<R> {
      return serialize(() => fn(api));
    },
  };

  return api;
}
