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
import { orderMiddleware } from './plugins.ts';
import { matchRoute, type HttpMethod, type Route } from './routes.ts';

export interface ControllerSpec {
  /** 依赖的 provider 名字（由 httpPlugin 在启动时解析并注入 ctx.get）。 */
  deps?: readonly string[];
  /** 控制器级中间件（在全局与路由级之后）。 */
  middleware?: readonly Middleware[];
  /**
   * 输入里来自**请求体**的键。
   *
   * 路由表校验会检查：`input` 的每个键必须是路径参数、查询参数，或者出现在这里。
   * （这个字段一直在被 httpPlugin 使用与校验，但**类型里漏了** —— M8b 实施时我据此误判
   * "body 是静默无效的"并删掉了它，结果启动期直接报错，才把类型补齐。）
   */
  body?: readonly string[];
  /** 输入校验：复用应用层的字段描述符。键必须来自路径参数、已声明的查询参数或 `body`。 */
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
  /**
   * 控制器抛异常时的回调（**审计/可观测性**）。
   *
   * 为什么需要它：错误映射会把异常变成 4xx/5xx 响应，但**服务端此前没有任何线索** ——
   * 排查时只能看到一句 `internal error`。httpPlugin 会把它转成 `app.emit('http:error', …)`，
   * 使用者接一条日志即可（库代码不自己写 stdout）。
   */
  onError?: (error: unknown, info: { requestId: string; route?: Route; status: number }) => void;
  /**
   * 插件贡献的请求上下文钩子（`defineWebPlugin({ context })` 会注册成服务，httpPlugin 读出来传进来）。
   * 每个请求在中间件之前执行，用来挂 `ctx.log` 这类派生值。
   */
  contextHooks?: readonly ((ctx: Record<string, unknown>) => Record<string, unknown> | undefined)[];
  /** 流式路由的原始请求体（`stream: true` 的路由才有；httpPlugin 不做缓冲）。 */
  stream?: AsyncIterable<Uint8Array>;
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
    // 流式路由：把原始请求流交给 ctx（httpPlugin 对这些路由不做缓冲）
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  });

  // 插件贡献的上下文（每个请求执行一次；失败即 500，不静默）
  for (const hook of options.contextHooks ?? []) {
    const values = hook(ctx as unknown as Record<string, unknown>);
    if (values !== undefined && values !== null) ctx.extend(values);
  }

  try {
    // 中间件链：全局 → 路由 → 控制器；输入校验紧贴 handle（鉴权/限流可先短路）
    // 阶段排序：未声明阶段的中间件按 `pre` 处理（于是"不写阶段的既有代码"顺序不变）
    const chain: Middleware[] = orderMiddleware([
      ...(options.middleware ?? []),
      ...((route.middleware ?? []) as readonly Middleware[]),
      ...(spec.middleware ?? []),
    ]);
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
    // 只在"服务端问题"上报事件：4xx 是业务语义（调用方能自己处理），5xx 才需要人看
    if (response.status >= 500) options.onError?.(error, { requestId, route, status: response.status });
    return { matched: true, route, status: response.status, requestId, response };
  }
}

export type { HttpMethod };
