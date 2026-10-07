/**
 * `@actor/db` 的公开类型声明（手写，与 `src/index.ts` 的运行时导出一一对应）。
 *
 * 约定与内核一致：声明面是**使用者看到的**类型，运行时才是真相；两者漂移要有门禁盯着。
 * 设计见 `docs/design/m6-db-package.md`。
 */

// --- 方言 -------------------------------------------------------------------

export type Dialect = 'pgsql' | 'mysql' | 'sqlite';

export type LogicalType =
  | 'uuid'
  | 'string'
  /** 定长字符串（`char(n)`，默认 1）。 */
  | 'char'
  | 'text'
  /** 小文本（MySQL `tinytext`）。 */
  | 'tinyText'
  /** 中等文本（MySQL `mediumtext`）。 */
  | 'mediumText'
  /** 大文本（MySQL `longtext`）。 */
  | 'bigText'
  | 'tinyint'
  | 'smallint'
  | 'integer'
  | 'bigint'
  /** 定点小数（`precision`/`scale`，默认 10,2）。 */
  | 'decimal'
  /** 4 字节浮点。 */
  | 'float'
  /** 双精度浮点。 */
  | 'real'
  | 'boolean'
  /** 只有日期（`'YYYY-MM-DD'`）。 */
  | 'date'
  /** 只有时间（`'HH:MM:SS'`）。 */
  | 'time'
  /** 带时区的时间戳（PG `timestamptz`）。 */
  | 'timestamp'
  /** 不带时区的时间戳（PG `timestamp` / MySQL `datetime`）。 */
  | 'dateTime'
  | 'json'
  | 'blob'
  /** 变长二进制（MySQL `varbinary(n)`）。 */
  | 'binary';

/** 列类型映射的附加参数。 */
export interface ColumnTypeOptions {
  length?: number;
  precision?: number;
  scale?: number;
}

export declare const DIALECTS: readonly Dialect[];
export declare const DEFAULT_PORTS: Record<Dialect, number | null>;
/** 各方言默认懒加载的驱动包名（sqlite 是内置模块，不需要安装）。 */
export declare const DRIVER_PACKAGES: Record<Dialect, string>;

/**
 * 该方言是否支持 `INSERT … RETURNING`（自增主键靠它回读生成值）。
 * MySQL 没有 RETURNING，用结果里的 `insertId`。
 */
export declare function supportsReturning(dialect: Dialect): boolean;

/** 内省出来的一列。 */
export interface IntrospectedColumn {
  name: string;
  type: string;
  rawType: string;
  notNull: boolean;
  hasDefault: boolean;
}

/** 一个方言的差异点（**加方言只需实现它 + 在 DIALECT_SPECS 登记一行**）。 */
export interface DialectSpec {
  readonly name: Dialect;
  /** 懒加载的驱动包名（sqlite 是内置模块，不需要安装）。 */
  readonly driverPackage: string;
  /** 这个方言用哪个驱动（驱动本身仍是懒加载）。 */
  readonly driver: () => DriverFactory;
  readonly defaultPort: number | null;
  readonly connectionKind: 'file' | 'host';

  placeholder(index: number): string;
  quote(name: string): string;
  quoteTable(schema: string | undefined, table: string): string;
  readonly supportsReturning: boolean;
  columnType(logical: LogicalType, options?: ColumnTypeOptions): string;

  autoIncrementPieces(field: RenderableField): AutoIncrementPieces | null;
  defaultLiteral(field: RenderableField): string | null;
  inlineComment(field: RenderableField): string | null;
  tableSuffix(model: RenderableModel, options: { withComments: boolean }): string;
  commentStatements(model: RenderableModel): string[];
  readonly indexIfNotExists: boolean;
  isDuplicateIndexError(error: unknown): boolean;
  readonly comments: 'statements' | 'inline' | 'none';

  introspection: {
    tableExists(table: string): { sql: string; params: readonly unknown[] };
    columns(table: string): { sql: string; params: readonly unknown[] } | { pragma: string };
    toColumn(row: Record<string, unknown>): IntrospectedColumn;
  };
  normalizeDbType(rawType: string, options?: { length?: number | null }): string;
  serializeBoolean(value: unknown): boolean | number;
  serializeTimestamp(date: Date): Date | string;

  connectionFromFields(input: Record<string, unknown>): NormalizedConnection;
  connectionFromUrl(url: string): NormalizedConnection;
  describe(connection: NormalizedConnection): string;
}

/** 渲染列定义需要的字段视图（`Field` 结构上满足它）。 */
export interface RenderableField {
  readonly column: string;
  readonly name: string;
  readonly type: LogicalType;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue?: unknown;
  readonly autoIncrement: boolean;
  readonly comment?: string;
}

/** 渲染建表语句需要的表视图（`Model` 结构上满足它）。 */
export interface RenderableModel {
  readonly table: string;
  readonly comment?: string;
  readonly fields: readonly RenderableField[];
}

/** 自增身份的方言片段（位置有讲究，所以结构化返回）。 */
export interface AutoIncrementPieces {
  override?: string;
  beforeNotNull?: string;
  afterNotNull?: string;
}

/** 值是不是已知方言（注册表驱动）。 */
export declare function isDialect(value: unknown): value is Dialect;

/** 方言描述符注册表（加方言＝加一个文件 + 这里加一行）。 */
export declare const DIALECT_SPECS: Record<Dialect, DialectSpec>;

/** 取一个方言的描述符；未知方言明确报错。 */
export declare function dialectSpec(dialect: Dialect): DialectSpec;

/** 占位符风格：pg 用 `$n`，mysql/sqlite 用 `?`。 */
export declare function placeholderFor(dialect: Dialect): (index: number) => string;
/** 标识符引号 + 转义（pg/sqlite 双引号，mysql 反引号）。 */
export declare function quoteIdentifier(dialect: Dialect, name: string): string;
export declare function quoteTable(dialect: Dialect, schemaOrTable: string, table?: string): string;
/** 逻辑类型 → 真实列类型。 */
export declare function assertDialect(value: unknown): Dialect;
export declare function columnTypeFor(
  dialect: Dialect,
  logical: LogicalType,
  options?: ColumnTypeOptions,
): string;

export interface NormalizedConnection {
  dialect: Dialect;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** sqlite 专用：文件路径（`:memory:` 表示内存库）。 */
  filename?: string;
  /** 原始 DSN（**不用于日志**）。 */
  url?: string;
}

/** 解析连接配置（DSN 或字段式）；`dialect` 与 DSN 冲突时报错。 */
export declare function parseConnection(
  input: { url?: string; dialect?: Dialect } & Record<string, unknown>,
): NormalizedConnection;
/** 只用于日志/错误：**不含密码**。 */
export declare function describeConnection(connection: NormalizedConnection): string;
/** 从 DSN 猜方言。 */
export declare function dialectFromUrl(url: string): Dialect;
/** 不写 dialect 时的默认值：DSN 有就按 DSN，否则 `pgsql`。 */
export declare function dialectFor(options: { dialect?: Dialect; connection?: { url?: string } }): Dialect;

// --- 错误 -------------------------------------------------------------------

export declare class DbError extends Error {
  readonly code: string;
}
export declare class DbDriverMissingError extends DbError {
  readonly dialect: string;
  readonly driverPackage: string;
}
export declare class DbConfigError extends DbError {}
export declare class DbConnectionError extends DbError {}
export declare class DbNotConnectedError extends DbError {}
/** 乐观锁冲突（绝不静默覆盖）。 */
export declare class DbConflictError extends DbError {
  readonly id: string;
  readonly expectedVersion: number | null;
}
/** 目标行不存在。 */
export declare class DbNotFoundError extends DbError {
  readonly id: string;
}
export declare class DbSchemaDriftError extends DbError {
  readonly drift: DriftReport;
}

// --- 驱动 -------------------------------------------------------------------

export type Row = Record<string, unknown>;

/** 事务范围内的 runner；与 `@actor/data` 的 `SqlRunner` **结构兼容**（不互相 import）。 */
export interface Runner {
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  run(sql: string, params?: readonly unknown[]): Promise<number>;
  transaction?<R>(fn: (scoped: Runner) => Promise<R>): Promise<R>;
  /**
   * 执行 INSERT 并返回数据库生成的列（自增主键回读用）：
   * pg/sqlite 走 `RETURNING`（返回结果行），mysql 返回 `[{ insertId }]`。
   */
  insertReturning?(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}

export interface PoolOptions {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export interface DriverPool extends Runner {
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  stats?(): Record<string, unknown> | null;
}

export interface DriverFactory {
  readonly name: string;
  create(connection: NormalizedConnection, pool: PoolOptions, dialect: Dialect): Promise<DriverPool>;
}

/** 从**应用根**解析模块（驱动装在用户项目里，不在本包的 node_modules 里）。 */
export interface DriverResolver {
  (specifier: string): unknown;
}
export declare function createAppRequire(root?: string): DriverResolver;
export declare function loadDriverModule<T>(
  specifier: string,
  dialect: string,
  packageName: string,
  resolve?: DriverResolver,
): T;

export declare function createSqliteDriver(loadModule?: () => unknown): DriverFactory;
export declare function createPgDriver(loadModule?: (resolve?: DriverResolver) => Promise<unknown>): DriverFactory;
export declare function createMssqlDriver(
  loadModule?: (resolve?: DriverResolver) => Promise<unknown>,
): DriverFactory;
export declare function buildMssqlPool(pool: unknown): DriverPool;

export declare function createMysqlDriver(loadModule?: (resolve?: DriverResolver) => Promise<unknown>): DriverFactory;

// --- model 层（用户写声明，框架生成 DDL）-------------------------------------

export interface FieldHooks {
  /** 列值 → 领域值（如 JSON 解码）。 */
  parse?: (raw: unknown) => unknown;
  /** 领域值 → 列值（如 JSON 编码）。 */
  serialize?: (value: unknown) => unknown;
}

export interface FieldSpec extends FieldHooks {
  type: LogicalType;
  /** `string` 的长度（其它类型忽略）。 */
  length?: number;
  /** 列名（默认与字段名相同）。 */
  column?: string;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  /** DB 侧默认值（会渲染成方言正确的字面量）。 */
  default?: unknown;
  /** 时间戳自动填充：`create` 只在插入时写，`update` 每次更新都写（由仓储层执行）。 */
  auto?: 'create' | 'update';
  /** 乐观锁版本列（一个 model 最多一个）。 */
  version?: boolean;
  /**
   * **自增整数主键**：只对整数类型且必须是主键。
   * PG 用 `GENERATED BY DEFAULT AS IDENTITY`、MySQL 用 `AUTO_INCREMENT`、
   * SQLite 用 `INTEGER PRIMARY KEY AUTOINCREMENT`。
   * 插入时不给主键 → 省略该列并在写入后**回读**数据库生成的值。
   */
  autoIncrement?: boolean;
}

export interface Field {
  name: string;
  column: string;
  type: LogicalType;
  length?: number;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
  auto?: 'create' | 'update';
  version: boolean;
  parse?: (raw: unknown) => unknown;
  serialize?: (value: unknown) => unknown;
}

export interface IndexSpec {
  fields: readonly string[];
  unique?: boolean;
  name?: string;
}
export interface Index {
  name: string;
  columns: readonly string[];
  unique: boolean;
}

/** 关联声明：本轮只做"声明 + 查询构造"。 */
export interface RelationSpec {
  kind: 'hasMany' | 'belongsTo';
  /** 目标 model 的名字（要在同一批注册过）。 */
  model: string;
  /** hasMany 用**目标表**上的外键字段名；belongsTo 用**本表**上的外键字段名。 */
  foreignKey: string;
}
export interface Relation {
  name: string;
  kind: 'hasMany' | 'belongsTo';
  model: string;
  foreignKey: string;
}

export interface ModelSpec {
  name: string;
  /** 表名（默认 = name）。 */
  table?: string;
  fields: Record<string, FieldSpec>;
  indexes?: readonly IndexSpec[];
  /** 关联声明（hasMany / belongsTo）。 */
  relations?: Record<string, RelationSpec>;
  /** 整行级自定义映射（**用户可写**）：行 → 实体。 */
  parseRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** 整行级自定义映射（**用户可写**）：实体 → 行。 */
  serializeRow?: (entity: Record<string, unknown>) => Record<string, unknown>;
}

export interface Model {
  readonly name: string;
  readonly table: string;
  readonly fields: readonly Field[];
  readonly indexes: readonly Index[];
  readonly relations: readonly Relation[];
  readonly primaryKey: string;
  readonly versionField: string | null;
  readonly parseRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  readonly serializeRow?: (entity: Record<string, unknown>) => Record<string, unknown>;
  fieldFor(name: string): Field;
  fieldByColumn(column: string): Field | undefined;
  /** 建表语句；`options.comments === false` 时不写内联注释。 */
  createTableSql(dialect: Dialect, options?: { comments?: boolean }): string;
  createIndexSql(dialect: Dialect, index: Index): string;
  addColumnSql(dialect: Dialect, field: Field): string;
}

/** 声明一个 model（用户写这一层；此处不访问数据库）。 */
export declare function defineModel(spec: ModelSpec): Model;

// --- schema 层 ---------------------------------------------------------------

export interface ColumnInfo {
  name: string;
  /** 规范化后的类型（用于比较）。 */
  type: string;
  rawType: string;
  notNull: boolean;
  hasDefault: boolean;
}
export interface TableInfo {
  table: string;
  exists: boolean;
  columns: ColumnInfo[];
}
export interface DriftReport {
  ok: boolean;
  table: string;
  tableMissing: boolean;
  missingColumns: Array<{ field: string; column: string; type: string }>;
  typeMismatches: Array<{ column: string; expected: string; actual: string }>;
}
/** 注释策略：`never` 从不写；`create`（默认）只在建表那一次写；`always` 每次 sync 都重新应用。 */
export type CommentMode = 'never' | 'create' | 'always';

export interface SyncReport {
  created: string[];
  altered: string[];
  indexes: string[];
  /** 这次 sync 是否真的应用了注释。 */
  commentsApplied: boolean;
  /** 成功应用了注释的目标（`notes` / `notes.title`）。 */
  comments: string[];
  /** **没有**被应用的注释目标 + 原因（不静默丢弃）。 */
  unsupportedComments: string[];
}
export interface SyncOptions {
  auto?: boolean;
  /** 注释策略（默认 `create`）：已存在的表**不会**被自动更新注释。 */
  comments?: CommentMode;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

export declare function normalizeDbType(
  dialect: Dialect,
  rawType: string,
  options?: { length?: number | null },
): string;
export declare function tableExistsSql(dialect: Dialect, table?: string): string;
export declare function columnsSql(dialect: Dialect, table?: string): string;
export declare function inspectTable(dialect: Dialect, runner: Runner, table: string): Promise<TableInfo>;
export declare function checkDrift(dialect: Dialect, model: Model, info: TableInfo): DriftReport;
export declare function syncModels(
  dialect: Dialect,
  runner: Runner,
  models: readonly Model[],
  options?: SyncOptions,
): Promise<SyncReport>;

// --- ORM 映射层 + 仓储 -------------------------------------------------------

export type Entity = Record<string, unknown>;

/** 默认的"列值 → 领域值"（可被字段级 `parse` / 整行 `parseRow` 覆盖）。 */
export declare function defaultParseValue(dialect: Dialect, field: Field, value: unknown): unknown;
/** 默认的"领域值 → 列值"。 */
export declare function defaultSerializeValue(dialect: Dialect, field: Field, value: unknown): unknown;
/** 行 → 实体（字段级 parse → 整行 parseRow）。 */
export declare function rowToEntity(dialect: Dialect, model: Model, row: Record<string, unknown>): Entity;
/** 实体 → 行（只取 model 声明过的字段；`undefined` 不写）。 */
export declare function entityToRow(
  dialect: Dialect,
  model: Model,
  entity: Entity,
  options?: { onlyProvided?: boolean },
): Record<string, unknown>;

export interface FindManyOptions {
  /** 等值条件（AND）；键必须是 model 的**字段名**。 */
  where?: Record<string, unknown>;
  orderBy?: ReadonlyArray<{ field: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}

export interface UpdateOptions {
  /** 乐观锁：与库里 version 不一致就抛 `DbConflictError`。 */
  expectedVersion?: number;
}

export interface Repository<M extends Model = Model> {
  readonly model: M;
  insert(entity: Entity): Promise<Entity>;
  findById(id: unknown): Promise<Entity | null>;
  findMany(options?: FindManyOptions): Promise<Entity[]>;
  update(id: unknown, patch: Entity, options?: UpdateOptions): Promise<Entity>;
  delete(id: unknown): Promise<boolean>;
  related(
    entity: Entity,
    name: string,
  ): Promise<{ model: string; kind: 'hasMany' | 'belongsTo'; many(): Promise<Entity[]>; one(): Promise<Entity | null> }>;
}

export interface RepositoryOptions {
  dialect: Dialect;
  runner: Runner;
  models: Map<string, Model>;
  generateId?: () => string;
}

export declare function createRepository<M extends Model>(model: M, options: RepositoryOptions): Repository<M>;

// --- SQL 适配器 -------------------------------------------------------------
/** SQL 适配器参数：方言 + 驱动工厂。 */
export interface SqlAdapterOptions {
  dialect: Dialect;
  driver: DriverFactory;
}
/**
 * 把既有的 `DriverFactory` 包成 core 的 `DatabaseAdapter` —— 这样 SQL 与
 * Redis/MongoDB/自装适配器走**同一条**连接生命周期（core 的 `supervise()`）。
 */
export declare function createSqlAdapter(
  options: SqlAdapterOptions,
): import('@actor/db-core').DatabaseAdapter<DriverPool, NormalizedConnection>;

// --- 应用层插件（让 web 层开箱可用）------------------------------------------

/** 插件需要的**应用侧**能力（结构化，不 import @actor/app）。 */
export interface DbPluginApp {
  config: { get<T>(key: string): T };
  provide?(name: string, value: unknown): void;
  get?<T>(name: string): T;
}

/** `databasePlugin()` 的返回值：一个 PluginSpec 形状的对象。 */
export interface DatabasePluginSpec {
  name: string;
  config: Record<string, unknown>;
  onReady(app: DbPluginApp): Promise<void>;
  onStopping(app: DbPluginApp): Promise<void>;
}

export interface DatabasePluginOptions {
  /** 插件名（也是配置节名），默认 `db`。 */
  name?: string;
  /** 要 sync 的 model（也会被注册，供关联解析）。 */
  models?: readonly Model[];
  /** 注册成应用服务的仓储：`{ notes: Note }` 或 `{ notes: 'notes' }`。 */
  repositories?: Record<string, Model | string>;
  /** 方言（不写则从 connection 推断 / 读配置 `plugins.<name>.driver` / 默认 pgsql）。 */
  dialect?: Dialect;
  /** 连接配置（不写则读配置：有 url 用 url，否则用 filename 走 sqlite）。 */
  connection?: Record<string, unknown>;
  pool?: PoolOptions;
  /** 是否允许 sync 自动补安全列（默认 false，也可由配置打开）。 */
  autoMigrate?: boolean;
  /** 注释策略（默认 `create`；`always` 才会更新已存在表的注释）。 */
  comments?: CommentMode;
  /** 连接后是否必须健康（默认 true）。 */
  requireHealthy?: boolean;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

/** 让 web 层开箱可用的数据库插件（连接 + 建表 + 注册服务 + 优雅关池）。 */
export declare function databasePlugin(options?: DatabasePluginOptions): DatabasePluginSpec;

// --- 数据库句柄 -------------------------------------------------------------

export interface DatabaseOptions {
  dialect?: Dialect;
  connection: ({ url: string } | Record<string, unknown>) & { dialect?: Dialect };
  pool?: PoolOptions;
  driver?: DriverFactory;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
  /**
   * schema 策略：`auto` 是否允许自动补安全列（默认 false）；`comments` 注释策略
   * （默认 `create` = 只在建表时写，已存在的表不自动更新）。
   */
  migrations?: { auto?: boolean; comments?: CommentMode };
}

export declare const DEFAULT_POOL: Required<PoolOptions>;

export interface HealthReport {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /** 目标连接（**不含密码**）。 */
  target: string;
}

export interface Database {
  readonly dialect: Dialect;
  readonly connection: NormalizedConnection;
  readonly driverName: string;
  /** 建池 + 一次健康检查；失败即抛。幂等。 */
  connect(): Promise<void>;
  /** 优雅关闭；幂等。关闭后 `healthCheck()` 返回 ok:false。 */
  close(): Promise<void>;
  healthCheck(): Promise<HealthReport>;
  /** 与 `@actor/data` 的 `SqlRunner` 结构兼容。 */
  runner(): Runner;
  /** 逃生通道：手写 SQL，仍然参数化。 */
  raw<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  rawRun(sql: string, params?: readonly unknown[]): Promise<number>;
  stats(): Record<string, unknown> | null;
  /** 按 model 建表/建索引（`migrations.auto` 时才做安全加列）。 */
  sync(models: readonly Model[] | Model, options?: SyncOptions): Promise<SyncReport>;
  /** 读一张表的实况。 */
  inspectTable(table: string): Promise<TableInfo>;
  /** 只比不改：model 与库里实况的差异。 */
  checkDrift(model: Model): Promise<DriftReport>;
  /** 已注册的 model（`sync()` 会自动注册）。 */
  models(): ReadonlyMap<string, Model>;
  /** 取一个 model 的仓储（实体 ↔ 行、乐观锁、关联）。 */
  repository<M extends Model>(
    model: M,
    options?: { models?: readonly Model[]; generateId?: () => string },
  ): Repository<M>;
}

/** 建一个数据库句柄（此刻还不连接）。 */
export declare function createDatabase(options: DatabaseOptions): Database;
export declare function defaultPortFor(dialect: Dialect): number | null;
