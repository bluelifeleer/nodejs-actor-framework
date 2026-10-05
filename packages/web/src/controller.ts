/**
 * 控制器与请求派发（M2 第 2 步）。
 *
 * 控制器是**无状态**的：只描述"需要什么依赖、输入长什么样、怎么处理"；
 * 状态归 Actor，访问 Actor 的唯一桥梁是 `ctx.actor(name)`。
 * 派发是纯函数（不依赖 http 模块），便于单测与替换服务器实现。
 */

import { validateValues, type ConfigIssue, type ConfigSchema } from '@actor/app';

import {
  HttpError,
  createRequestContext,
  toErrorResponse,
  toResponse,
  type HeaderValue,
  type HttpResponse,
  type RequestContext,
} from './context.ts';
import { composeMiddleware, type Middleware } from './middleware.ts';
import { matchRoute, type HttpMethod, type Route } from './routes.ts';

export interface ControllerSpec {
  /** 依赖的 provider 名字（由 httpPlugin 在启动时解析并注入 ctx.get）。 */
  deps?: readonly string[];
  /** 控制器级中间件（在全局与路由级之后）。 */
  middleware?: readonly Middleware[];
  /** 输入校验：复用应用层的字段描述符。键必须来自路径参数或已声明的查询参数。 */
  input?: ConfigSchema;
  handle: (input: Record<string, unknown>, ctx: RequestContext) => unknown | Promise<unknown>;
}

export type Controller = ControllerSpec | ((input: Record<string, unknown>, ctx: RequestContext) => unknown);

export function defineController(spec: ControllerSpec): ControllerSpec {
  return spec;
}

function isControllerSpec(value: Controller): value is ControllerSpec {
  return typeof value === 'object' && value !== null && 'handle' in value;
}

export interface DispatchRequest {
  method: string;
  url: string;
  headers?: Record<string, HeaderValue>;
  body?: unknown;
  requestId?: string;
}

export interface DispatchOptions {
  routes: readonly Route[];
  request: DispatchRequest;
  /** 全局中间件（app 级，声明顺序）。 */
  middleware?: readonly Middleware[];
  /** 由 httpPlugin 提供的接线（Actor 句柄、provider、配置、日志）。 */
  actor?: (name: string) => unknown;
  get?: (name: string) => unknown;
  config?: unknown;
  log?: unknown;
}

/** 派发结果：响应 + 匹配信息（后者便于 httpPlugin 写访问日志）。 */
export interface DispatchResult {
  response: HttpResponse;
  matched: boolean;
  route?: Route;
  status: number;
  /** 每个请求的追踪 id（由服务器回写到响应头，便于跨日志排查）。 */
  requestId: string;
  /** HEAD 命中 GET 路由：响应头照常，body 必须丢弃（由服务器实现处理）。 */
  headOnly?: true;
}

function makeRequestId(): string {
  return `r-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 按路由表派发一次请求：
 *  匹配失败 → 404 / 405（带 Allow）；输入校验失败 → 400（与配置校验同一格式）；
 *  控制器抛 HttpError 或异常 → 走错误映射表；其余按返回值推断形态（默认 JSON）。
 */
export async function dispatch(options: DispatchOptions): Promise<DispatchResult> {
  const { routes, request } = options;
  const [rawPath = '', rawQuery = ''] = request.url.split('?', 2);
  const match = matchRoute(routes, { method: request.method, url: request.url });
  const requestId = request.requestId ?? makeRequestId();

  if (match.kind === 'not_found') {
    return {
      matched: false,
      status: 404,
      requestId,
      response: toErrorResponse(new HttpError(404, `no route for ${request.method.toUpperCase()} ${rawPath}`)),
    };
  }
  if (match.kind === 'options') {
    // 标准行为：预检返回 204 + Allow，而不是 405
    const response = toResponse(undefined);
    response.headers.Allow = match.allow.join(', ');
    return { matched: false, status: 204, requestId, response };
  }
  if (match.kind === 'method_not_allowed') {
    const response = toErrorResponse(new HttpError(405, `method not allowed for ${rawPath}`));
    response.headers.Allow = match.allow.join(', ');
    return { matched: false, status: 405, requestId, response };
  }

  const { route, params, query } = match;
  const querySource = new URLSearchParams(rawQuery);
  const body = request.body;
  const declared: Record<string, unknown> = { ...params };
  for (const name of route.queryParams) {
    const fromQuery = querySource.get(name);
    if (fromQuery !== null) declared[name] = fromQuery;
  }
  // 允许 JSON body 覆盖/补充（POST 场景）
  if (body !== undefined && typeof body === 'object' && body !== null) {
    for (const [key, value] of Object.entries(body)) declared[key] ??= value;
  }

  // routes.ts 里的控制器类型是有意"不透明"的（routes 不依赖 ctx 类型，避免循环引用），
  // 因此在这里收一次类型：路由表只负责匹配，控制器的语义由本模块定义。
  const controller = route.controller as unknown as Controller;
  const spec: ControllerSpec = isControllerSpec(controller)
    ? controller
    : { handle: controller };

  const ctx = createRequestContext({
    method: request.method,
    path: rawPath,
    requestId,
    params,
    query,
    headers: request.headers ?? {},
    body,
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    ...(options.get === undefined ? {} : { get: options.get }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  try {
    // 中间件链：全局 → 路由 → 控制器；输入校验紧贴 handle（鉴权/限流可先短路）
    const chain: Middleware[] = [
      ...(options.middleware ?? []),
      ...((route.middleware ?? []) as readonly Middleware[]),
      ...(spec.middleware ?? []),
    ];
    const run = composeMiddleware(chain);
    const result = await run(ctx, async () => {
      let input: Record<string, unknown> = declared;
      if (spec.input) {
        const { values, issues } = validateValues(spec.input, declared, `请求输入`);
        if (issues.length > 0) {
          throw new HttpError(400, 'input validation failed', { issues: issues satisfies ConfigIssue[] });
        }
        input = values;
      }
      return spec.handle(input, ctx);
    });
    const response = toResponse(result);
    return {
      matched: true,
      route,
      status: response.status,
      requestId,
      response,
      ...(match.headOnly ? { headOnly: true as const } : {}),
    };
  } catch (error) {
    const response = toErrorResponse(error);
    return { matched: true, route, status: response.status, requestId, response };
  }
}

export type { HttpMethod };
