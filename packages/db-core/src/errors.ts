/**
 * `@actor/db-core` 的错误基类：所有错误都带 `code`，便于调用方按类别处理。
 *
 * 这些类与**具体数据库无关**（SQL / Redis / MongoDB / 自装适配器共用），所以住在 core 里；
 * `@actor/db` 会原样 re-export 它们，保证既有使用者的 `instanceof` 判断不受搬迁影响。
 */

/** 错误基类：所有错误都带 `code`。 */
export class DbError extends Error {
  readonly code: string;
  constructor(message: string, code = 'DB_ERROR') {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

/**
 * 驱动没装：错误信息必须能照着装（kind + 包名 + 安装命令）。
 *
 * 注意字段名沿用 `dialect`（历史原因 + 已公开），语义上是"适配器 kind"。
 */
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

/** 配置有问题（kind 不认识、连接配置缺失、DSN 与显式 kind 冲突……）。 */
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

/**
 * 资源不可用（已关闭 / 正在关闭 / 尚未就绪）—— **快速失败**用的错误。
 *
 * 为什么不排队等：等下去只会让请求堆积，最后一起超时；如实报"现在不可用"才能让上游做决定。
 */
export class DbUnavailableError extends DbError {
  readonly state: string;
  constructor(kind: string, state: string, detail = '') {
    super(
      `${kind} is not connected (state: ${state})${detail === '' ? '' : `: ${detail}`}`,
      'DB_UNAVAILABLE',
    );
    this.name = 'DbUnavailableError';
    this.state = state;
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

/** 目标记录不存在（更新/删除时用来和"版本冲突"区分开）。 */
export class DbNotFoundError extends DbError {
  readonly id: string;
  constructor(id: string) {
    super(`row "${id}" not found`, 'DB_NOT_FOUND');
    this.name = 'DbNotFoundError';
    this.id = id;
  }
}
