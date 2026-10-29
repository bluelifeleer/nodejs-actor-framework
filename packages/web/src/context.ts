/**
 * 控制器上下文（M2 第 1 步）：请求访问器 + 返回形态。
 *
 * 纯数据与纯函数，不依赖 http 模块 —— 便于单测，也便于将来换服务器实现。
 */

/** 可调用访问器：`qs('k')` 与 `qs().get('k')` 两种写法等价。 */
export interface Accessor<V> {
  (key: string): V | undefined;
  (): AccessorObject<V>;
  get(key: string): V | undefined;
  all(): Record<string, V>;
  has(key: string): boolean;
}

export interface AccessorObject<V> {
  get(key: string): V | undefined;
  all(): Record<string, V>;
  has(key: string): boolean;
}

function makeAccessor<V>(
  source: () => Record<string, V>,
  normalize: (key: string) => string = (key) => key,
): Accessor<V> {
  const lookup = (key: string): V | undefined => source()[normalize(key)];
  const api: AccessorObject<V> = {
    get: lookup,
    all: () => ({ ...source() }),
    has: (key: string) => Object.prototype.hasOwnProperty.call(source(), normalize(key)),
  };
  const callable = ((key?: string) => (key === undefined ? api : api.get(key))) as Accessor<V>;
  return Object.assign(callable, api);
}

export type HeaderValue = string | string[];

import { DbConfigError } from '@actor/resource';

/** 框架保留的 ctx 字段：插件扩展**不能**覆盖它们（覆盖了会让中间件/控制器拿到错东西）。 */
/**
 * **框架保留的 ctx 字段**（唯一来源：`ctx.extend` 与文档都读它）。
 *
 * 提示为什么要有它：`route` 曾经不在这个名单里，而框架自己会往 `ctx.state.route` 写当前控制器的声明
 * （authPlugin 靠它读 `auth: { required }`）—— 于是任何插件执行 `ctx.extend({ route: … })` 都会**静默覆盖**它，
 * auth 随后读到错的声明。**编译器挡不住这种事故**，所以这里显式守住。
 */
export const RESERVED_CONTEXT_KEYS: readonly string[] = [
  'method', 'path', 'requestId', 'body', 'params', 'qs', 'headers', 'header',
  'actor', 'get', 'config', 'state', 'extend', 'extension', 'route',
  // 框架内部槽用带命名空间的键：撞名概率极小，且**同样**受保留名单保护
  '@actor/route',
];

/**
 * 框架内部的"当前控制器声明"槽：**放在 WeakMap 里，不进 `ctx.state`**。
 *
 * 为什么不用 `ctx.state.xxx`：`ctx.state` 的语义是"每请求可变袋，中间件放鉴权结果等"（用户/插件的地盘）。
 * 早先框架把当前路由声明写进 `ctx.state.route`，带来两个问题：① 用户的 `extend({ route })` 会**静默覆盖**它；
 * ② 它还会出现在用户可见的 `Object.keys(ctx.state)` 里。WeakMap 两个问题一起解决（键不存在，也就不可能撞）。
 * 保留名单里仍留着 `route` / `@actor/route`：故意写这两个键会得到**明确报错**，而不是静默覆盖。
 *
 * 这两个函数是**包内**用的（不在 `index.ts` 的公开面上）。
 */
const ROUTE_SPECS = new WeakMap<object, unknown>();

export function setRouteSpec(ctx: object, spec: unknown): void {
  ROUTE_SPECS.set(ctx, spec);
}

export function routeSpecOf<T = unknown>(ctx: object): T | undefined {
  return ROUTE_SPECS.get(ctx) as T | undefined;
}

const CORE_CONTEXT_KEYS = new Set(RESERVED_CONTEXT_KEYS);

/**
 * **框架保留的路由前缀**（唯一来源：内置插件与文档都读它）。
 *
 * 为什么要有它：内置插件占了 `/uploads`（uploadPlugin）与 `/__debug`（debugPlugin）两片命名空间，
 * 而路由表检查的是"模式是否重复"——**撞名字不是重复**（`/uploads` 与 `/uploads/:key` 是两个模式），
 * 于是用户路由与框架路由会**同时存在**，谁先匹配到取决于声明顺序，变成静默的行为漂移。
 * 所以这里显式守住：装配期发现"用户路由落在框架保留前缀里"就**明确报错**，而不是让两套路由共存。
 *
 * 与 `RESERVED_CONTEXT_KEYS` 同一形态（单一来源 + 一致性门禁）：
 * 门禁断言"内置插件实际占用的前缀 ⊆ 这份清单"（见 packages/web/test/run-app.test.ts）。
 *
 * 注意它是**命名空间**保留：改了内置前缀（如 `uploadPlugin({ routePrefix: '/files' })`）就绕开了这层校验
 * —— 那是使用者自愿接管那片命名空间，与本清单无关。
 */
export const RESERVED_ROUTE_PREFIXES: readonly string[] = ['/uploads', '/__debug'];

/**
 * 谁（哪个框架插件）占用哪个保留前缀 —— 装配期校验与门禁都读它，避免"口径两处写"。
 *
 * 它与 `RESERVED_ROUTE_PREFIXES` 必须互相覆盖（有测试断言：两边集合相等，且各插件的**实际默认前缀**
 * 就落在这里面）—— 所以这份映射是唯一来源，不是又抄一遍。
 */
export const RESERVED_PREFIX_OWNERS: readonly { owner: string; prefix: string }[] = [
  { owner: 'upload', prefix: '/uploads' },
  { owner: 'debug', prefix: '/__debug' },
];

/** 模式是否落在某个前缀的命名空间里（`/__debug` 与 `/__debug/x` 都算，`/__debugger` 不算）。 */
function pathIsUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * 从已装配的插件里读出"**谁声明占用了哪个路由前缀**"（`WebPluginSpec.routePrefix`）。
 *
 * 为什么需要：装配期要判断"这条路由落在保留前缀里、但它是前缀主人的路由" —— 这个判据必须来自
 * 插件自己的声明，而不是硬编码插件名（硬编码一定会分叉：改个 `prefix` 就错）。
 * 应用层不依赖 Web 层，所以插件类型上只可能有 `routePrefix?: string`（结构化读取）。
 */
export function declaredPrefixOwners(
  plugins: readonly unknown[],
): Array<{ owner: string; prefix: string }> {
  const owners: Array<{ owner: string; prefix: string }> = [];
  for (const plugin of plugins) {
    if (typeof plugin !== 'object' || plugin === null) continue;
    const record = plugin as { name?: unknown; routePrefix?: unknown };
    if (typeof record.name !== 'string' || typeof record.routePrefix !== 'string') continue;
    if (record.routePrefix === '' || !record.routePrefix.startsWith('/')) continue;
    owners.push({ owner: record.name, prefix: record.routePrefix.replace(/\/$/, '') || '/' });
  }
  return owners;
}

/**
 * **框架自带**插件的标识清单（`WebPluginSpec.framework === true`）。
 *
 * 只用于一句判断："框架插件占自己的保留前缀是设计如此"。用显式标记而不是插件名 ——
 * 名字可以撞、可以改，标记是插件自己的声明。
 */
export function frameworkPrefixOwners(plugins: readonly unknown[]): string[] {
  return declaredPrefixOwners(plugins.filter(isFrameworkPlugin)).map((entry) => entry.owner);
}

function isFrameworkPlugin(plugin: unknown): boolean {
  return typeof plugin === 'object' && plugin !== null && (plugin as { framework?: unknown }).framework === true;
}

/**
 * 两个前缀是否重叠（相等、或一个是另一个的命名空间）。
 *
 * 前缀先归一化：**去掉尾斜杠**（`/` → 空串）。于是"根前缀 `/`"会与任何前缀重叠 ——
 * 这正是想要的：`routePrefix: '/'` 等于把保留区也包进自己的命名空间。
 * 早先没归一化时 `/` 被当成一个普通段，`/` vs `/uploads` 会算出"不重叠"（假阴性）。
 */
export function prefixesOverlap(left: string, right: string): boolean {
  const normalize = (prefix: string): string => prefix.replace(/\/$/, '');
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return true;
  return a === '' || b === '' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * 校验**插件自己声明的路由前缀**（`WebPluginSpec.routePrefix`）：用户/第三方插件不许认领保留区。
 *
 * 为什么要单独一条，而不是复用"路由模式落在保留前缀里"的检查：插件路由进路由表后**不带插件归属**
 * （`RouteMeta` 只记模块/路由器名），所以在那里无法区分"框架插件的 `/uploads`"与"第三方插件的 `/uploads`"。
 * 而在插件这一层，归属是明确的（就是插件自己），所以这里判得准。
 *
 * 两个方向都拦：
 *   - 用户插件声明的 `/__debug`、`/uploads/*` → 与框架命名空间重叠；
 *   - 用户插件声明的**父前缀** `/` 或 `/__debug/extra` 之类 → 把保留区包进自己的命名空间同样危险。
 */
export function pluginPrefixCollisions(
  plugins: readonly unknown[],
): Array<{ owner: string; prefix: string; reserved: string }> {
  const framework = new Set(frameworkPrefixOwners(plugins));
  const collisions: Array<{ owner: string; prefix: string; reserved: string }> = [];
  for (const { owner, prefix } of declaredPrefixOwners(plugins)) {
    if (framework.has(owner)) continue;
    for (const reserved of RESERVED_ROUTE_PREFIXES) {
      if (prefixesOverlap(prefix, reserved)) {
        collisions.push({ owner, prefix, reserved });
        break;
      }
    }
  }
  return collisions;
}

/** 名字冲突检查：两个插件声明同一个路由前缀 → 必然互相覆盖（启动期报错，不静默）。 */
export function duplicatePrefixOwners(
  plugins: readonly unknown[],
): Array<{ prefix: string; owners: string[] }> {
  const byPrefix = new Map<string, string[]>();
  for (const { owner, prefix } of declaredPrefixOwners(plugins)) {
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), owner]);
  }
  return [...byPrefix]
    .filter(([, owners]) => owners.length > 1)
    .map(([prefix, owners]) => ({ prefix, owners }));
}

/**
 * 这个路由模式是否落在**框架保留前缀**里（查询声明不参与判定）。
 *
 * 只在装配路由表时使用（那时才看得到全部路由）。刻意**不做前缀归一化之外的猜测**：
 * 只比较路径，不做"语义相似"判断。
 */
export function inReservedPrefix(pattern: string): boolean {
  const raw = String(pattern);
  const path = raw.split('?', 1)[0] ?? raw;
  return RESERVED_ROUTE_PREFIXES.some((prefix) => pathIsUnder(path, prefix));
}

export interface RequestContextInit {
  /** 流式路由的原始请求体。 */
  stream?: AsyncIterable<Uint8Array>;
  method: string;
  path: string;
  requestId: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, HeaderValue>;
  body?: unknown;
  actor?: (name: string) => unknown;
  get?: (name: string) => unknown;
  config?: unknown;
  log?: unknown;
}

export interface RequestContext {
  method: string;
  path: string;
  requestId: string;
  /** 已解析的请求体（JSON 自动解析，否则原始文本；无体时为 undefined）。 */
  body: unknown;
  params: Accessor<string>;
  qs: Accessor<string>;
  headers: Accessor<HeaderValue>;
  /** 取某个请求头的单个值（重复头取第一个）。 */
  header(name: string): string | undefined;
  actor(name: string): unknown;
  get(name: string): unknown;
  config: unknown;
  log: unknown;
  /** 每请求可变袋：中间件放鉴权结果等，控制器读取（**无类型**的逃生通道）。 */
  state: Record<string, unknown>;
  /**
   * 插件/中间件往 ctx 上挂派生值（`ctx.extend({ user })` → `ctx.user`）。
   *
   * 与 `state` 的区别：`extend` 同时写到 `ctx` 本身上（所以 `ctx.user` 能直接用），并**拒绝覆盖框架保留字段**。
   */
  extend(values: Record<string, unknown>): void;
  /** 读扩展值（带泛型；没有就是 undefined）。 */
  extension<T = unknown>(key: string): T | undefined;
  /** 流式路由的原始请求体（仅 `stream: true` 的路由有）。 */
  stream?: AsyncIterable<Uint8Array>;
  /** 约定字段：由 authPlugin 写入（M8c）。 */
  user?: unknown;
  /** 约定字段：由 uploadPlugin 写入（M8b）。 */
  files?: unknown;
  /** 由 viewPlugin 写入：读取模板并注入数据。 */
  render?: (name: string, data?: unknown) => HttpResponse | Promise<HttpResponse>;
}

export function createRequestContext(init: RequestContextInit): RequestContext {
  const paramsSource: Record<string, string> = { ...(init.params ?? {}) };
  const querySource: Record<string, string> = { ...(init.query ?? {}) };
  const headersSource: Record<string, HeaderValue> = {};
  for (const [key, value] of Object.entries(init.headers ?? {})) headersSource[key.toLowerCase()] = value;

  const notWired = (what: string) => (): never => {
    throw new Error(`${what} 尚未接线（由 httpPlugin 在启动时提供）`);
  };
  return {
    method: init.method,
    path: init.path,
    requestId: init.requestId,
    body: init.body,
    params: makeAccessor(() => paramsSource),
    qs: makeAccessor(() => querySource),
    headers: makeAccessor(() => headersSource, (key) => key.toLowerCase()),
    header(name: string): string | undefined {
      const value = headersSource[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
    actor: (init.actor as RequestContext['actor']) ?? (notWired('ctx.actor') as RequestContext['actor']),
    get: (init.get as RequestContext['get']) ?? (notWired('ctx.get') as RequestContext['get']),
    config: init.config ?? null,
    log: init.log ?? console,
    ...(init.stream === undefined ? {} : { stream: init.stream }),
    state: {},
    extend(values: Record<string, unknown>): void {
      for (const [key, value] of Object.entries(values)) {
        if (CORE_CONTEXT_KEYS.has(key)) {
          throw new DbConfigError(`ctx.extend: "${key}" 是框架保留字段，不能被插件覆盖`);
        }
        (this as unknown as Record<string, unknown>)[key] = value;
        this.state[key] = value;
      }
    },
    extension<T = unknown>(key: string): T | undefined {
      const value = (this as unknown as Record<string, unknown>)[key];
      return value === undefined ? undefined : (value as T);
    },
  };
}

// --- 返回形态 ---------------------------------------------------------------

export interface HttpResponseInit {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

/** 控制器的显式返回：由 content type 决定序列化方式。 */
export interface HttpResponse {
  status: number;
  contentType: string;
  /** string 直接写；Uint8Array 原样写；AsyncIterable 流式写；null 表示空体。 */
  body: string | Uint8Array | AsyncIterable<Uint8Array> | null;
  headers: Record<string, string>;
}

function make(
  status: number,
  contentType: string,
  body: string | Uint8Array | AsyncIterable<Uint8Array> | null,
  init: HttpResponseInit = {},
): HttpResponse {
  return {
    status: init.status ?? status,
    contentType: init.contentType ?? contentType,
    body,
    headers: { ...(init.headers ?? {}) },
  };
}

export const reply = {
  json: (body: unknown, init?: HttpResponseInit): HttpResponse =>
    make(200, 'application/json; charset=utf-8', JSON.stringify(body ?? null), init),
  text: (body: string, init?: HttpResponseInit): HttpResponse =>
    make(200, 'text/plain; charset=utf-8', body, init),
  html: (body: string, init?: HttpResponseInit): HttpResponse =>
    make(200, 'text/html; charset=utf-8', body, init),
  buffer: (body: Uint8Array, init?: HttpResponseInit): HttpResponse =>
    make(200, 'application/octet-stream', body, init),
  /** 流式响应（大文件下载不整份进内存）。 */
  stream: (body: AsyncIterable<Uint8Array>, init?: HttpResponseInit): HttpResponse =>
    make(200, 'application/octet-stream', body, init),
  protobuf: (body: Uint8Array, init?: HttpResponseInit): HttpResponse =>
    make(200, 'application/x-protobuf', body, init),
  /** 完全自定义：状态码、内容类型、响应头。 */
  send: (body: string | Uint8Array | null, init: HttpResponseInit = {}): HttpResponse =>
    make(init.status ?? 200, init.contentType ?? 'application/octet-stream', body, init),
  /** 无内容。 */
  noContent: (init?: HttpResponseInit): HttpResponse => make(204, 'text/plain; charset=utf-8', null, init),
};

export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;
  /** 错误响应也要带的头（例如 401 的 `WWW-Authenticate`）。 */
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
    this.headers = headers ?? {};
  }
}

function isHttpResponse(value: unknown): value is HttpResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'contentType' in value &&
    'body' in value
  );
}

/**
 * 把控制器的返回值规范成响应。约定（docs/design/m2-web-layer.md §2.2）：
 * 显式返回优先；对象/数组 → JSON 200；undefined → 204；其它标量 → 文本 200。
 */
export function toResponse(result: unknown): HttpResponse {
  if (result === undefined) return reply.noContent();
  if (isHttpResponse(result)) return result;
  // 顺序要紧：Uint8Array 也是 object，必须先判字节，否则会被 JSON.stringify 成 {"0":1,...}
  if (result instanceof Uint8Array) return reply.buffer(result);
  if (typeof result === 'string') return reply.text(result);
  if (result === null || typeof result === 'object') return reply.json(result);
  return reply.text(String(result));
}

/** 把任意异常映射成响应（错误映射表见设计 §4）。 */
export function toErrorResponse(error: unknown): HttpResponse {
  if (error instanceof HttpError) {
    return reply.json(
      { error: { status: error.status, message: error.message, details: error.details } },
      { status: error.status, headers: error.headers },
    );
  }
  const name = (error as { name?: string } | null)?.name;
  const message = (error as { message?: string } | null)?.message ?? 'internal error';
  // 内核的 AskTimeoutError 按 name 判定，不 import 内核类型（保持边界）
  if (name === 'AskTimeoutError') {
    return reply.json({ error: { status: 504, message: 'actor did not answer in time' } }, { status: 504 });
  }
  // ActorNotFoundError 来自内核（本地查不到），ActorNotResolvableError 来自应用层
  // （本地没 spawn、集群发现也没有）——两者都是"这个 Actor 不存在"，统一 404 并带上名字。
  if (name === 'ActorNotFoundError' || name === 'ActorNotResolvableError') {
    return reply.json({ error: { status: 404, message } }, { status: 404 });
  }
  return reply.json({ error: { status: 500, message: 'internal error' } }, { status: 500 });
}
