/** `@actor/db` 的错误基类：所有错误都带 `code`，便于调用方按类别处理。 */
export class DbError extends Error {
  readonly code: string;
  constructor(message: string, code = 'DB_ERROR') {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

/** 驱动没装：错误信息必须能照着装（方言 + 包名 + 安装命令）。 */
export class DbDriverMissingError extends DbError {
  readonly dialect: string;
  readonly driverPackage: string;
  constructor(dialect: string, driverPackage: string, cause?: unknown) {
    super(
      `cannot load the "${driverPackage}" driver for dialect ${dialect}: ` +
        `install it in your project (\`npm i ${driverPackage}\`) or pass your own driver via createDatabase({ driver }).`,
      'DB_DRIVER_MISSING',
    );
    this.name = 'DbDriverMissingError';
    this.dialect = dialect;
    this.driverPackage = driverPackage;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** 配置有问题（方言不认识、连接配置缺失、DSN 与显式方言冲突……）。 */
export class DbConfigError extends DbError {
  constructor(message: string) {
    super(message, 'DB_CONFIG_INVALID');
    this.name = 'DbConfigError';
  }
}

/** 连接/健康检查失败。 */
export class DbConnectionError extends DbError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DB_CONNECTION_FAILED');
    this.name = 'DbConnectionError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** 没连接就用了（不要在池还没建好时假装能查）。 */
export class DbNotConnectedError extends DbError {
  constructor(what = 'database') {
    super(`${what} is not connected: call await db.connect() first.`, 'DB_NOT_CONNECTED');
    this.name = 'DbNotConnectedError';
  }
}

/** 乐观锁冲突：`expectedVersion` 与库里的不一致（**绝不静默覆盖**）。 */
export class DbConflictError extends DbError {
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

/** 目标行不存在（更新/删除时用来和"版本冲突"区分开）。 */
export class DbNotFoundError extends DbError {
  readonly id: string;
  constructor(id: string) {
    super(`row "${id}" not found`, 'DB_NOT_FOUND');
    this.name = 'DbNotFoundError';
    this.id = id;
  }
}
