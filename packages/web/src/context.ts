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
  /** string 直接写；Uint8Array 原样写；null 表示空体。 */
  body: string | Uint8Array | null;
  headers: Record<string, string>;
}

function make(status: number, contentType: string, body: string | Uint8Array | null, init: HttpResponseInit = {}): HttpResponse {
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
