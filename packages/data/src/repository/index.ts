/**
 * 仓储（M3 第 3 步）。
 *
 * 三个适配器共用同一份语义基准（`createMemoryRepository` 是基准实现）：
 * 游标分页、`where` 等值过滤、单键排序、`version` 乐观锁。
 */

export {
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

export { compareRows, compareValues, decodeCursor, encodeCursor, normalizeQuery } from './cursor.ts';

export { createMemoryRepository, type MemoryRepositoryOptions } from './memory.ts';

export { createFileRepository, type FileRepository, type FileRepositoryOptions } from './file.ts';
