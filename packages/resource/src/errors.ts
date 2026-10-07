/**
 * `@actor/resource` 的错误基类：所有错误都带 `code`，便于调用方按类别处理。
 *
 * 这些类与**具体中间件无关**（SQL / Redis / MongoDB / SMTP / 自装适配器共用）。
 * 历史名字（`DbError` 等）作为**别名**保留：同一个类对象，`instanceof` 判断不受搬迁影响。
 *
 * ⚠️ `name`、`code` 与消息文案**全部保持搬迁前的形态**（`DbError` / `DB_*`）—— 它们都是对外行为
 * （使用者会按 name/code 分类、测试会断言文案），不能因为包改名就悄悄变。
 * 新代码请按 `ResourceError` 家族来理解（名字只是类型层的别名）。
 */

/** 错误基类：所有错误都带 `code`。 */
export class ResourceError extends Error {
  readonly code: string;
  constructor(message: string, code = 'DB_ERROR') {
    super(message);
    this.name = 'DbError'; // 保持搬迁前的形态（对外行为）
    this.code = code;
  }
}

/**
 * 驱动没装：错误信息必须能照着装（kind + 包名 + 安装命令）。
 *
 * 注意字段名沿用 `dialect`（历史原因 + 已公开），语义上是"适配器 kind"。
 */
export class DriverMissingError extends ResourceError {
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
export class ResourceConfigError extends ResourceError {
  constructor(message: string) {
    super(message, 'DB_CONFIG_INVALID');
    this.name = 'DbConfigError';
  }
}

/** 连接/健康检查失败。 */
export class ResourceConnectionError extends ResourceError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DB_CONNECTION_FAILED');
    this.name = 'DbConnectionError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** 没连接就用了（不要在资源还没建好时假装能用）。 */
export class ResourceNotConnectedError extends ResourceError {
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
export class ResourceUnavailableError extends ResourceError {
  readonly state: string;
  constructor(kind: string, state: string, detail = '') {
    super(`${kind} is not connected (state: ${state})${detail === '' ? '' : `: ${detail}`}`, 'DB_UNAVAILABLE');
    this.name = 'DbUnavailableError';
    this.state = state;
  }
}

// --- 兼容别名（同一类对象；既有使用者的 instanceof 与导入路径都不变）----------
export {
  ResourceConfigError as DbConfigError,
  ResourceConnectionError as DbConnectionError,
  ResourceError as DbError,
  ResourceNotConnectedError as DbNotConnectedError,
  ResourceUnavailableError as DbUnavailableError,
  DriverMissingError as DbDriverMissingError,
};
