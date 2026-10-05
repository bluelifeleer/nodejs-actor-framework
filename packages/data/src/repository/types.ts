/**
 * 仓储契约（M3 第 3 步，doc 04 §2）。
 *
 * 能力边界是**刻意划窄**的（已确认的 D-repo-1）：`where` 只做**等值过滤**、排序只支持**单键**、
 * 分页只用**游标**。这不是"还没做完"，而是明确不做查询构建器（doc 06 §3 的非目标）——
 * 复杂查询交给 SQL / 外部 ORM 适配器。
 */

/** 查询：等值过滤 + 单键排序 + 游标分页。 */
export interface RepositoryQuery {
  /** 等值过滤；值必须是原始值（string / number / boolean / null）。 */
  where?: Record<string, string | number | boolean | null>;
  /** 排序字段（默认 `idField`）；值必须是可比较的 string 或 number。 */
  orderBy?: string;
  /** 排序方向，默认 `'asc'`。 */
  direction?: 'asc' | 'desc';
  /** 每页条数，默认 50，范围 1..1000。 */
  limit?: number;
  /** 上一页返回的**不透明**游标；只保证同一适配器 + 同一排序下可回放。 */
  cursor?: string;
}

export interface RepositoryPage<T> {
  items: T[];
  /** 还有下一页时给出；没有更多数据时**不出现**（别用 `undefined` 判断"是否最后一页"以外的语义）。 */
  cursor?: string;
}

export interface RepositoryCapabilities {
  /**
   * `expectedVersion` 的保证级别（与持久化的 `conditionalAppend` 同一套词汇）：
   * `'atomic'` = 后端条件写（SQL 等）；`'in-process'` = 只保证本进程（file / memory）。
   */
  conditionalUpdate: 'atomic' | 'in-process' | false;
}

export interface Repository<T, Id = string> {
  findById(id: Id): Promise<T | null>;
  findMany(query?: RepositoryQuery): Promise<RepositoryPage<T>>;
  /** 没有 `id` 时由适配器生成；`version` 由适配器设为 1（实体自带的值会被覆盖）。 */
  insert(entity: T): Promise<T>;
  /**
   * 局部更新。`expectedVersion` 不匹配时抛 `RepositoryConflictError` 且**不写入**；
   * 成功时 `version` 自增。
   */
  update(id: Id, patch: Partial<T>, options?: { expectedVersion?: number }): Promise<T>;
  delete(id: Id): Promise<boolean>;
  /** 串行化一组操作（可见性/原子性由适配器如实决定，见 capabilities 与文档）。 */
  transaction<R>(fn: (tx: Repository<T, Id>) => Promise<R>): Promise<R>;
  capabilities(): RepositoryCapabilities;
}

/** 实体不存在（或删除后又被更新）。 */
export class RepositoryNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`仓储里没有 id='${id}' 的实体`);
    this.name = 'RepositoryNotFoundError';
    this.id = id;
  }
}

/** `insert` 时 id 已存在。 */
export class RepositoryDuplicateError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`仓储里已经有 id='${id}' 的实体（insert 不会覆盖；要覆盖请显式 update）`);
    this.name = 'RepositoryDuplicateError';
    this.id = id;
  }
}

/** 乐观锁冲突：`expectedVersion` 与实际不符，**没有写入**。 */
export class RepositoryConflictError extends Error {
  readonly id: string;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;
  constructor(id: string, expectedVersion: number, actualVersion: number | null) {
    super(
      `实体 '${id}' 的版本冲突：期望 ${expectedVersion}，实际 ${actualVersion === null ? '(不存在)' : actualVersion}` +
        '（先重新读一次再重试；这条与持久化层的条件写是同一套语义）',
    );
    this.name = 'RepositoryConflictError';
    this.id = id;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** 查询本身有问题（未知排序字段、非法 where 值、损坏的游标……）——启动期/调用期就要报出来。 */
export class RepositoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryQueryError';
  }
}

/** 适配器公共选项：id 与 version 的字段名可配（默认 `id` / `version`）。 */
export interface RepositoryOptions {
  idField?: string;
  versionField?: string;
}

export interface ResolvedRepositoryOptions {
  idField: string;
  versionField: string;
}

export function resolveRepositoryOptions(options: RepositoryOptions = {}): ResolvedRepositoryOptions {
  const idField = options.idField ?? 'id';
  const versionField = options.versionField ?? 'version';
  if (idField === versionField) {
    throw new RepositoryQueryError('idField 与 versionField 不能是同一个字段');
  }
  return { idField, versionField };
}
