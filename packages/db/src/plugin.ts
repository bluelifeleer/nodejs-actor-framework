import { DIALECTS, dialectFromUrl, isDialect, type Dialect } from './dialect.ts';
import { DbConfigError } from './errors.ts';
import { createDatabase, type Database } from './database.ts';
import { dialectSpec } from './dialects/index.ts';
import type { PoolOptions } from './drivers/types.ts';
import type { Model } from './model.ts';
import type { Repository } from './repository.ts';
import type { CommentMode } from './schema.ts';

/**
 * 插件需要的**应用侧**能力（结构化，不 import `@actor/app`）。
 *
 * 这样 `@actor/db` 不反向依赖应用层：插件返回的就是一个普通的 PluginSpec 形状对象，
 * `@actor/app` 的 `PluginSpec` 恰好也长这样（配置节 + 生命周期钩子）——两边靠结构兼容。
 */
export interface DbPluginApp {
  config: { get<T>(key: string): T };
  /** 注册服务：控制器里 `ctx.get(name)` 就能拿到（应用层 API）。 */
  provide?(name: string, value: unknown): void;
  get?<T>(name: string): T;
}

/** `databasePlugin()` 的返回值：一个 PluginSpec 形状的对象。 */
export interface DatabasePluginSpec {
  name: string;
  /** 插件自己的配置节（合并进应用的 `plugins.<name>.*`）。 */
  config: Record<string, unknown>;
  onReady(app: DbPluginApp): Promise<void>;
  onStopping(app: DbPluginApp): Promise<void>;
}

export interface DatabasePluginOptions {
  /** 插件名（也是配置节名 `plugins.<name>.*`），默认 `db`。 */
  name?: string;
  /** 要 `sync()` 的 model（同时也会被注册，供关联解析用）。 */
  models?: readonly Model[];
  /**
   * 注册成应用服务的仓储：`{ notes: Note }` 或 `{ notes: 'notes' }`（按 model 名引用 `models` 里的）。
   * 控制器里用 `ctx.get('notes')` 取。
   */
  repositories?: Record<string, Model | string>;
  /** 方言（不写则读配置 `plugins.<name>.driver`，再默认 `pgsql`）。 */
  dialect?: Dialect;
  /** 连接配置（不写则读配置：有 url 用 url，否则用 filename 走 sqlite）。 */
  connection?: Record<string, unknown>;
  /** 池参数（不写则用 `createDatabase` 的默认值，max 读配置）。 */
  pool?: PoolOptions;
  /** 是否允许 `sync()` 自动补**安全**的列（默认 false；也可由配置 `plugins.<name>.autoMigrate` 打开）。 */
  autoMigrate?: boolean;
  /**
   * 注释策略（默认 `create`）：注释只在**建表时**写，已存在的表不会被自动更新；
   * 想每次同步就显式写 `'always'`（也可由配置 `plugins.<name>.comments` 设置）。
   */
  comments?: CommentMode;
  /** 连接后是否必须健康才继续启动（默认 true：连不上就启动失败，不静默降级）。 */
  requireHealthy?: boolean;
  /** 诊断日志接缝（与内核同形状）。 */
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

/**
 * **让 web 层开箱可用**的数据库插件。
 *
 * 它在 `onReady` 里：读配置 → 建库 → `connect()` → 健康检查 → `sync(models)` → 把 `db` 与每个
 * 仓储注册成应用服务；在 `onStopping` 里优雅关池。于是业务代码只需要：
 *
 * ```ts
 * // app.ts
 * plugins: [ databasePlugin({ models: [Note], repositories: { notes: Note } }) ]
 * // controller.ts
 * const notes = ctx.get('notes') as Repository<typeof Note>;
 * ```
 *
 * 配置（可用环境变量覆盖，双下划线表示层级）：
 * `plugins.db.driver` / `.url` / `.file` / `.poolMax` / `.autoMigrate`
 * 例：`APP_PLUGINS__DB__URL='pgsql://user:pass@host:5432/db'`。
 */
/**
 * 从显式 connection 里**推断**方言（用户给了 `{ filename }` 就是 sqlite；`{ url }` 就按 DSN 推断）。
 *
 * 为什么必须推断：插件默认方言是 pgsql（与包一致）。如果用户直接传 `connection: { filename: 'x.sqlite' }`
 * 而插件硬套默认值，就会拿 pgsql 去解析一个 sqlite 配置 —— 第一版就是这么错的（测试抓到）。
 */
function inferDialect(connection: Record<string, unknown> | undefined): Dialect | undefined {
  if (connection === undefined) return undefined;
  const explicit = connection.dialect;
  if (isDialect(explicit)) return explicit;
  const url = connection.url;
  if (typeof url === 'string' && url !== '') return dialectFromUrl(url);
  if (typeof connection.filename === 'string') {
    // "文件名形式的连接"是哪个方言由能力位决定（不点名 sqlite —— 加方言时这里不用改）
    return DIALECTS.find((dialect) => dialectSpec(dialect).connectionKind === 'file');
  }
  return undefined;
}

export function databasePlugin(options: DatabasePluginOptions = {}): DatabasePluginSpec {
  const name = options.name ?? 'db';
  const configKey = `plugins.${name}`;
  let db: Database | null = null;

  const resolveModels = (): readonly Model[] => options.models ?? [];

  const modelFor = (reference: Model | string): Model => {
    if (typeof reference !== 'string') return reference;
    const found = resolveModels().find((model) => model.name === reference);
    if (found === undefined) {
      throw new DbConfigError(
        `databasePlugin: repository "${reference}" refers to a model named "${reference}" which is not in models[]`,
      );
    }
    return found;
  };

  return {
    name,
    config: {
      // 插件默认 sqlite（零依赖、开箱可用）；要 PG/MySQL 就设 plugins.db.url（并从 DSN 推断方言）。
      // 注意与包级默认值的区别：`createDatabase()` 的默认方言仍是 pgsql（用户要求），
      // 这里是**应用层插件**的默认，偏向"先跑起来"。
      driver: { type: 'string' as const, default: options.dialect ?? 'sqlite' },
      url: { type: 'string' as const, default: '' },
      file: { type: 'string' as const, default: './data/app.sqlite' },
      poolMax: { type: 'number' as const, default: 10 },
      autoMigrate: { type: 'boolean' as const, default: options.autoMigrate === true },
      // 注释策略：never | create（默认）| always
      comments: { type: 'string' as const, default: options.comments ?? 'create' },
    },

    async onReady(app: DbPluginApp): Promise<void> {
      const read = <T>(key: string, fallback: T): T => {
        try {
          const value = app.config.get<T>(`${configKey}.${key}`);
          return value === undefined || value === null ? fallback : value;
        } catch {
          return fallback; // 配置项不存在时用插件默认值（配置节由插件自己声明，正常不会缺）
        }
      };

      const url = read<string>('url', '');
      const file = read<string>('file', './data/app.sqlite');
      // 方言优先级：显式 options.dialect → 从显式 connection 推断（filename/url）→ 配置 driver → pgsql
      const dialect = (options.dialect ?? inferDialect(options.connection) ?? read<Dialect>('driver', 'sqlite')) as Dialect;
      if (url === '' && options.connection === undefined && dialectSpec(dialect).connectionKind === 'host') {
        // 需要 host 的方言却没给 url：给一句能照着做的错误，而不是让它掉进通用解析错误里
        throw new DbConfigError(
          `databasePlugin: driver "${dialect}" needs a connection url — set plugins.db.url ` +
            "(or the APP_PLUGINS__DB__URL environment variable).",
        );
      }
      const base = options.connection ?? (url === '' ? { filename: file } : { url });
      // 显式 connection 里没写方言时补上（有 url 的让 parseConnection 按 DSN 解析，别覆盖）
      const connection =
        base.dialect !== undefined || typeof base.url === 'string' ? base : { dialect, ...base };
      const pool = options.pool ?? { max: read<number>('poolMax', 10) };
      const autoMigrate = options.autoMigrate ?? read<boolean>('autoMigrate', false);
      const comments = (options.comments ?? read<string>('comments', 'create')) as CommentMode;
      if (comments !== 'never' && comments !== 'create' && comments !== 'always') {
        throw new DbConfigError(
          `databasePlugin: plugins.${name}.comments must be one of never|create|always (got "${String(comments)}")`,
        );
      }

      db = createDatabase({
        dialect,
        connection: connection as { url: string },
        pool,
        migrations: { auto: autoMigrate, comments },
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });

      // 连不上就启动失败：不做"看起来起来了其实没连上"的降级
      await db.connect();
      if (options.requireHealthy !== false) {
        const health = await db.healthCheck();
        if (!health.ok) throw new DbConfigError(`databasePlugin: database is not healthy: ${String(health.error)}`);
      }

      const models = resolveModels();
      if (models.length > 0) await db.sync(models);

      if (typeof app.provide === 'function') {
        app.provide(name, db);
        for (const [repositoryName, reference] of Object.entries(options.repositories ?? {})) {
          const model = modelFor(reference);
          const repository: Repository<Model> = db.repository(model);
          app.provide(repositoryName, repository);
        }
      }
    },

    async onStopping(): Promise<void> {
      const current = db;
      db = null;
      if (current !== null) await current.close();
    },
  };
}
