/**
 * **T3 工厂糖（M9g）**：CRUD 五路由 + 健康检查。
 *
 * 为什么值得做成工厂：生成的项目与文档里 CRUD 反复出现（list/get/create/update/delete + 输入校验 +
 * 404/409 + 分页），手写一次要几十行且每处略有出入 —— 工厂把"形状"固定下来，差异留在 opts 里。
 *
 * 纪律（与其它糖一致）：
 *   - 产出的是**普通 RouterSpec**（与 `router()`/`routes()` 同一份数据），所以前缀、中间件、
 *     重复路由检查、启动期校验全部照旧；
 *   - 每一项都能**逐项覆盖**（`opts.routes` 里给同名方法就替换那一条，不是"要么全用要么全不用"）；
 *   - 不碰存储实现：只要求一个**最小仓储形状**（`list/get/create/update/remove`），
 *     适配器由使用者的 provider 提供（与"状态归 Actor/仓储"的既有边界一致）。
 */

import { HttpError, reply } from './context.ts';
import { defineController, type InputEntry } from './controller.ts';
import type { Middleware } from './middleware.ts';
import type { RouteEntry, RouterSpec } from './router.ts';
import { defineRoutes, del, get, post, put } from './routes.ts';

/**
 * CRUD 需要的最小仓储形状（**结构化**，不依赖 `@actor/db`）。
 *
 * 语义约定（工厂据此映射 HTTP 状态码）：
 *   - `get` 返回 `null` 表示不存在 → 404；
 *   - `create` 冲突时**抛带 `status: 409` 或 name 含 Conflict 的错误** → 409（也接受返回 `null` 表示冲突）；
 *   - `update` 返回 `null` → 404；
 *   - `remove` 返回 false → 404。
 */
export interface CrudStore {
  list(input: Record<string, unknown>): unknown | Promise<unknown>;
  get(id: unknown): unknown | Promise<unknown>;
  create(body: Record<string, unknown>): unknown | Promise<unknown>;
  /**
   * 更新一条。`options.expectedVersion` 是**乐观锁**期望版本：
   * 请求里带了 `expectedVersion` 就会传进来；数据层版本不符时请抛**带 `status: 409`
   * 或 name 含 Conflict 的错误**（工厂会翻成 409，而不是 500）。
   */
  update(
    id: unknown,
    body: Record<string, unknown>,
    options?: { expectedVersion?: number },
  ): unknown | Promise<unknown>;
  remove(id: unknown): unknown | Promise<unknown>;
}

/** 分页参数名（默认 `limit` / `offset`）。 */
export interface CrudPagination {
  limitKey?: string;
  offsetKey?: string;
  defaultLimit?: number;
  maxLimit?: number;
}

export interface CrudRoutesOptions {
  /** 资源名（用于错误信息与默认的服务说明，不参与路由模式）。 */
  name?: string;
  /** 主键参数名（默认 `id`）。 */
  idParam?: string;
  /** 分页：`false` = 列表不接受分页参数；省略 = 默认 `limit`/`offset`（默认 20，上限 100）。 */
  pagination?: CrudPagination | false;
  /**
   * **写入字段声明**（create 的请求体形状；`update` 默认把它放宽成"部分更新"）：
   *
   * - **字符串数组**（`['title', 'body']`）= 字段名列表，默认都是必填字符串（写起来最短）；
   * - **对象**（`{ title: 'string', done: 'bool' }`）= 值即 schema（与控制器输入简写同一套规则），
   *   于是能表达必填/默认值/`int`/`bool`/`json` 等 —— 语义就是"这个资源的可写字段"。
   *
   * 为什么要显式声明而不是"照单全收"：框架的输入校验是**严格**的（未声明的键会被拒，防拼写错误），
   * 所以工厂必须知道可写字段才能两者兼得。不声明时 create/update 只接受空体（PUT 仍要求 `:id`）。
   */
  fields?: readonly string[] | Record<string, InputEntry>;
  /**
   * 乐观锁参数名（默认 `expectedVersion`；置 `false` = PUT 不接受版本参数）。
   *
   * 请求体带了这个字段时，工厂把它从"写入字段"里**摘出来**，作为
   * `store.update(id, body, { expectedVersion })` 的第三参传下去 ——
   * 仓储据此做版本比对（不符就抛 `status: 409` / name 含 Conflict 的错误，工厂翻成 409）。
   */
  versionKey?: string | false;
  /** 五条路由的**整体**中间件（list/get/create/update/delete 都挂）。 */
  middleware?: readonly Middleware[];
  /** 鉴权声明（由 authPlugin 解释；没装 authPlugin 时只是声明）。 */
  auth?: { readonly required?: boolean; readonly roles?: readonly string[] };
  /** 逐条覆盖：给哪个方法就替换哪一条（`list`/`get`/`create`/`update`/`delete`）。 */
  routes?: Partial<Record<'list' | 'get' | 'create' | 'update' | 'delete', RouteEntry>>;
  /**
   * `update`（PUT）是否要求**完整**请求体：默认 `false` = 部分更新（只校验给了的字段）。
   * 置 `true` 就与 `create` 同口径（所有 `fields` 都必填）。
   */
  updateRequired?: boolean;
  /**
   * 乐观锁冲突时的**自定义响应**（默认抛 409 `{ reason: 'version_conflict' }`）。
   *
   * 给了它就由你决定返回什么（通常是 `throw new HttpError(409, …)` 带上自己的 details）。
   */
  onConflict?: (info: { id: unknown; expectedVersion?: number }, ctx: unknown) => unknown;
  /** 额外输入声明（会合并进对应路由的 input；同名以这里为准）。 */
  input?: Partial<Record<'list' | 'get' | 'create' | 'update' | 'delete', Record<string, InputEntry>>>;
}

/** 把简写（字符串别名/数组）展开成字段声明（与 `defineController` 的定义期别名同一套规则）。 */
function asFieldSpec(value: string | readonly unknown[]): { type: 'string' | 'number' | 'boolean' | 'json' } {
  if (Array.isArray(value)) return { type: 'json' };
  switch (value) {
    case 'int':
    case 'number':
      return { type: 'number' };
    case 'bool':
    case 'boolean':
      return { type: 'boolean' };
    case 'json':
      return { type: 'json' };
    default:
      return { type: 'string' };
  }
}

/**
 * 判断"这个错误是不是乐观锁/唯一约束冲突"。
 *
 * 判据只有两条，都很直白（不做模糊猜测）：`status === 409`（HTTP 风格的错误，如 `HttpError`）
 * 或 `name` 含 `Conflict`（数据层的 `DbConflictError` / `RepositoryConflictError`）。
 * 框架各数据层的冲突错误名都满足第二条，所以**不用每个项目自己写一遍翻译**。
 */
function isConflictError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 409) return true;
  const errorName = String((error as { name?: unknown } | null)?.name ?? '');
  return /conflict/i.test(errorName);
}

/**
 * 生成 CRUD 五路由（router spec，可直接放进 `defineModule({ router: crudRoutes(…) })`）。
 *
 * | 方法 | 模式 | 输入 | 语义 |
 * |---|---|---|---|
 * | GET | `<prefix>` | `limit`/`offset`（分页） | 列表（把分页参数透传给 `store.list`） |
 * | GET | `<prefix>/:id` | `id`（params） | 取一条；`null` → 404 |
 * | POST | `<prefix>` | 请求体 | 创建；冲突 → 409 |
 * | PUT | `<prefix>/:id` | `id` + 请求体 | 更新；`null` → 404 |
 * | DELETE | `<prefix>/:id` | `id`（params） | 删除；`false`/`null` → 404，否则 204 |
 */
export function crudRoutes(prefix: string, store: CrudStore, options: CrudRoutesOptions = {}): RouterSpec {
  const normalized = prefix.replace(/\/$/, '');
  if (!normalized.startsWith('/')) {
    throw new Error(`crudRoutes: 前缀必须以 / 开头（got "${prefix}"）`);
  }
  const name = options.name ?? (normalized.replace(/^\//, '') || 'resource');
  const idParam = options.idParam ?? 'id';
  const pagination = options.pagination === false ? null : {
    limitKey: options.pagination?.limitKey ?? 'limit',
    offsetKey: options.pagination?.offsetKey ?? 'offset',
    defaultLimit: options.pagination?.defaultLimit ?? 20,
    maxLimit: options.pagination?.maxLimit ?? 100,
  };
  const auth = options.auth === undefined ? {} : { auth: options.auth };
  const middleware = options.middleware === undefined ? {} : { middleware: options.middleware };

  /** 写入字段 → 输入声明（字符串数组 = 必填字符串；对象 = 值即 schema）。 */
  const bodyFields: Record<string, InputEntry> = (() => {
    const fields = options.fields;
    if (fields === undefined) return {};
    if (Array.isArray(fields)) {
      // 数组写法 = "字段名列表，默认都是必填字符串"。注意要展开成字段声明，
      // 不能把字符串当"值即 schema 的默认值"传下去（那会被当成该字段的默认值，类型仍是 string —— 实测踩到：
      // `fields: ['tags']` 变成"tags 默认值是字符串 'tags'"，于是传数组进来会被 400 拒掉）。
      return Object.fromEntries(fields.map((key) => [key, asFieldSpec('string')]));
    }
    return { ...(fields as Record<string, InputEntry>) };
  })();

  const listInput: Record<string, InputEntry> = {
    ...(pagination === null
      ? {}
      : {
          [pagination.limitKey]: { from: 'query', type: 'number', default: pagination.defaultLimit, min: 1, max: pagination.maxLimit },
          [pagination.offsetKey]: { from: 'query', type: 'number', default: 0, min: 0 },
        }),
    ...(options.input?.list ?? {}),
  };
  const getInput: Record<string, InputEntry> = {
    [idParam]: { from: 'params', type: 'string', min: 1 },
    ...(options.input?.get ?? {}),
  };
  const bodyInput: Record<string, InputEntry> = { ...bodyFields, ...(options.input?.create ?? {}) };
  // update 默认是"部分更新"：把 `fields` 声明放宽成可缺省（只保留类型约束）——
  // 否则 PUT /notes/:id 每次都必须带全所有字段，与 PATCH 语义混在一起了。
  const optionalUpdateFields: Record<string, InputEntry> = Object.fromEntries(
    Object.entries(bodyFields).map(([key, spec]) => {
      // 简写（字符串/数组）先按定义期的别名规则展开，再加 `required: false`
      if (typeof spec === 'string' || Array.isArray(spec)) {
        return [key, { ...asFieldSpec(spec), required: false }];
      }
      if (typeof spec !== 'object' || spec === null) return [key, spec];
      return [key, { ...(spec as Record<string, unknown>), required: false }];
    }),
  );
  const updateFields = options.updateRequired === true ? bodyFields : optionalUpdateFields;
  const versionKey = options.versionKey === false ? null : (options.versionKey ?? 'expectedVersion');
  const updateBodyInput: Record<string, InputEntry> = {
    [idParam]: { from: 'params', type: 'string', min: 1 },
    ...updateFields,
    ...(versionKey === null || options.input?.update?.[versionKey] !== undefined
      ? {}
      : { [versionKey]: { type: 'number', min: 0, required: false } }),
    ...(options.input?.update ?? {}),
  };

  /** 列表：整条 query 透传（分页键已按声明校验/补默认值），调用方还能传自己的过滤条件。 */
  const listRoute: RouteEntry = get(
    `${normalized}?${pagination === null ? '' : `${pagination.limitKey}=&${pagination.offsetKey}=`}`.replace(/\?$/, ''),
    defineController({
      ...middleware,
      ...auth,
      input: listInput,
      handle: async (input) => store.list({ ...input }),
    }),
  );
  const getRoute: RouteEntry = get(
    `${normalized}/:${idParam}`,
    defineController({
      ...middleware,
      ...auth,
      input: getInput,
      handle: async (input) => {
        const found = await store.get(input[idParam]);
        if (found === null || found === undefined) throw new HttpError(404, `${name} 不存在：${String(input[idParam])}`);
        return found;
      },
    }),
  );
  const createRoute: RouteEntry = post(
    normalized,
    defineController({
      ...middleware,
      ...auth,
      input: bodyInput,
      handle: async (input) => {
        try {
          const created = await store.create(input);
          if (created === null || created === undefined) throw new HttpError(409, `${name} 已存在`);
          return reply.json(created, { status: 201 });
        } catch (error) {
          // 冲突要**响亮且可预期**（409，而不是 500）：把数据层的冲突错误翻过来
          if (isConflictError(error)) throw new HttpError(409, `${name} 已存在`);
          throw error;
        }
      },
    }),
  );
  const updateRoute: RouteEntry = put(
    `${normalized}/:${idParam}`,
    defineController({
      ...middleware,
      ...auth,
      input: updateBodyInput,
      handle: async (input, ctx) => {
        const { [idParam]: id, ...rest } = input;
        // 乐观锁参数从"写入字段"里摘出来（仓储不该把它当普通列处理）
        const { [versionKey ?? 'expectedVersion']: expectedVersion, ...body } = rest;
        let updated: unknown;
        try {
          updated = await store.update(
            id,
            body,
            expectedVersion === undefined ? undefined : { expectedVersion: Number(expectedVersion) },
          );
        } catch (error) {
          // 乐观锁冲突：数据层抛的 DbConflictError / RepositoryConflictError 一律翻成 409
          if (isConflictError(error)) {
            if (options.onConflict !== undefined) return options.onConflict({ id, ...(expectedVersion === undefined ? {} : { expectedVersion: Number(expectedVersion) }) }, ctx);
            throw new HttpError(409, `${name} 已被别人改过`, { reason: 'version_conflict' });
          }
          throw error;
        }
        if (updated === null || updated === undefined) throw new HttpError(404, `${name} 不存在：${String(id)}`);
        return updated;
      },
    }),
  );
  const deleteRoute: RouteEntry = del(
    `${normalized}/:${idParam}`,
    defineController({
      ...middleware,
      ...auth,
      input: getInput,
      handle: async (input) => {
        const removed = await store.remove(input[idParam]);
        if (removed === false || removed === null || removed === undefined) {
          throw new HttpError(404, `${name} 不存在：${String(input[idParam])}`);
        }
        return reply.noContent();
      },
    }),
  );

  // 逐项覆盖：给了就替换那一条（其余保持工厂产出）
  const routes = defineRoutes([
    options.routes?.list ?? listRoute,
    options.routes?.get ?? getRoute,
    options.routes?.create ?? createRoute,
    options.routes?.update ?? updateRoute,
    options.routes?.delete ?? deleteRoute,
  ]);

  return {
    prefix: '',
    name,
    routes: routes as readonly RouteEntry[],
  };
}

export interface HealthRoutesOptions {
  /** 诊断路由（`/__debug/health`）用的受管资源注册表服务名；默认取框架约定值。 */
  registryService?: string;
  /** 前缀（默认空：产出 `/health`）。 */
  prefix?: string;
  middleware?: readonly Middleware[];
  auth?: { readonly required?: boolean; readonly roles?: readonly string[] };
}

/**
 * 生成健康检查路由（默认 `GET /health`）。
 *
 * 刻意**只报告进程自身的形状**（uptime + 受管资源数量）：
 *   - 受管资源的**深度**健康（`checkHealth`）在 `/__debug/health?check=1`（需要 token，不该公开）；
 *   - 这里不暴露配置、版本细节或资源名（公开端点越少信息越好）。
 */
export function healthRoutes(options: HealthRoutesOptions = {}): RouterSpec {
  const prefix = (options.prefix ?? '').replace(/\/$/, '');
  const registryService = options.registryService ?? '@actor/resource:registry';
  const startedAt = Date.now();
  return {
    prefix: '',
    name: 'health',
    routes: defineRoutes([
      get(
        `${prefix}/health`,
        defineController({
          ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
          ...(options.auth === undefined ? {} : { auth: options.auth }),
          handle: (_input, ctx) => {
            let resources: unknown = null;
            try {
              const list = ctx.get(registryService);
              resources = Array.isArray(list) ? list.length : null;
            } catch {
              resources = null; // 没装受管资源插件：如实返回 null，不假装 0
            }
            return {
              status: 'ok',
              uptimeMs: Date.now() - startedAt,
              resources,
            };
          },
        }),
      ),
    ]) as readonly RouteEntry[],
  };
}
