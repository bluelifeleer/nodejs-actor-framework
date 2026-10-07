import { ResourceError } from '@actor/resource';

/**
 * `@actor/db-core` 的错误：**通用**基类已搬到 `@actor/resource`（同一个类对象），
 * 这里原样 re-export（`instanceof` 与 `code` 都不变）；只有"行/实体语义"的两个错误留在这里。
 */
export {
  DbConfigError,
  DbConnectionError,
  DbDriverMissingError,
  DbError,
  DbNotConnectedError,
  DbUnavailableError,
} from '@actor/resource';

/** 乐观锁冲突：`expectedVersion` 与库里的不一致（**绝不静默覆盖**）。 */
export class DbConflictError extends ResourceError {
  readonly id: string;
  readonly expectedVersion: number | null;
  constructor(id: string, expectedVersion: number | null = null) {
    super(
      expectedVersion === null
        ? `row "${id}" was modified by someone else (version mismatch)`
        : `row "${id}" version mismatch: expected ${expectedVersion}`,
      'DB_CONFLICT',
    );
    this.name = 'DbConflictError';
    this.id = id;
    this.expectedVersion = expectedVersion;
  }
}

/** 目标记录不存在（更新/删除时用来和"版本冲突"区分开）。 */
export class DbNotFoundError extends ResourceError {
  readonly id: string;
  constructor(id: string) {
    super(`row "${id}" not found`, 'DB_NOT_FOUND');
    this.name = 'DbNotFoundError';
    this.id = id;
  }
}
