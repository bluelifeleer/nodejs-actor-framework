/**
 * 控制器与请求派发（M2 第 2 步）。
 *
 * 控制器是**无状态**的：只描述"需要什么依赖、输入长什么样、怎么处理"；
 * 状态归 Actor，访问 Actor 的唯一桥梁是 `ctx.actor(name)`。
 * 派发是纯函数（不依赖 http 模块），便于单测与替换服务器实现。
 */

import {
  validateValues,
  type ConfigEntry,
  type ConfigIssue,
  type ConfigSchemaInput,
  type FieldType,
} from '@actor/app';

import {
  setRouteSpec,
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

/** 输入来源（**默认来自请求体**：写 `input: { filename: 'string' }` 就是在声明一个 body 字段）。 */
export type InputSource = 'body' | 'query' | 'params';

/**
 * **诊断可见性**（M9g）：`'inherit'`（默认，跟随上层）/ `'off'`（这条不出现在 `/__debug/routes`）。
 *
 * 语义边界（必须记住）：它**只减少诊断输出的信息面**，不影响路由是否可用、也不改变鉴权 ——
 * 真正的门是 debugPlugin 的 token 与"生产拒绝启动"。
 */
export type DebugVisibility = 'inherit' | 'off';

/** 输入字段的**来源声明**形态：`{ from: 'query', … }`（`type` 可省，取值简写照旧）。 */
export interface InputFromSpec {
  from: InputSource;
  type?: FieldType;
  default?: unknown;
  /** 可缺省（`false` = 没给就跳过；用于部分更新）。 */
  required?: boolean;
  secret?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  regex?: RegExp | string;
  enum?: readonly (string | number | boolean)[];
  description?: string;
}

/** 输入声明的一项：全量 `FieldSpec`、简写值（值即 schema），或带 `from` 的来源声明。 */
export type InputEntry = ConfigEntry | InputFromSpec;

export interface ControllerSpec {
  /** 依赖的 provider 名字（由 httpPlugin 在启动时解析并注入 ctx.get）。 */
  deps?: readonly string[];
  /**
   * 鉴权要求（由 authPlugin 解释；没装 authPlugin 时它只是个声明）。
   * `required: true` 要求已认证；`roles` 还要求具备其中之一（不符 403）。
   */
  auth?: { readonly required?: boolean; readonly roles?: readonly string[] };
  /** 控制器级中间件（在全局与路由级之后）。 */
  middleware?: readonly Middleware[];
  /**
   * 诊断可见性：`'off'` 让这条路由不出现在 `/__debug/routes`（内部端点常用）。
   *
   * 不是安全边界（见 `DebugVisibility` 的注释）：隐藏的是**诊断输出**，不是路由本身。
   */
  debug?: DebugVisibility;
  /**
   * 输入里来自**请求体**的键。
   *
   * 路由表校验会检查：`input` 的每个键必须是路径参数、查询参数，或者出现在这里。
   * **M9f 起通常不用手写**：输入声明合一后，不带 `from` 的 `input` 字段默认就是 body，
   * `defineController` 会自动把它补进这里（显式写仍然有效，两者取并集）。
   */
  body?: readonly string[];
  /**
   * 输入校验：复用应用层的字段描述符（**支持简写，值即 schema**）。
   *
   * ```ts
   * defineController({ input: { filename: 'string', size: 'int' }, handle })   // 默认来自 body
   * defineController({ input: { id: { type: 'string', from: 'params' } }, handle })
   * defineController({ input: { limit: { from: 'query', type: 'number', default: 20 } }, handle })
   * ```
   *
   * 规则：键必须来自路径参数、查询参数或 `body`；声明了 `from` 就按它取，否则按 body 处理。
   */
  input?: { [key: string]: InputEntry };
  handle: (input: Record<string, unknown>, ctx: RequestContext) => unknown | Promise<unknown>;
}

export type Controller = ControllerSpec | ((input: Record<string, unknown>, ctx: RequestContext) => unknown);

/**
 * 每个控制器**显式声明**的"输入来源"表（`input` 键 → 来源）。
 *
 * 只有 `from` 与"简写的默认 body"写进来；**路由模式里的 `:param` / `?query=` 也是来源声明**，
 * 但那只在 dispatch/规则 3 看得到模式时才参与判定（优先于这里的默认 body，见 `sourcesFor`）。
 *
 * 为什么用 WeakMap 而不是把 `from` 留在 spec 上：`from` 是**连线信息**（这个键从哪取），
 * 不是字段约束 —— 留在 spec 里会流进 `validateValues`（它按 FieldSpec 读，多出来的键没有意义）。
 * 用 WeakMap 则既不改公开形状，又能在 dispatch 时按来源精确组装输入。
 */
const INPUT_SOURCES = new WeakMap<ControllerSpec, Map<string, InputSource>>();

/** 归一化后的输入 schema（与 `INPUT_SOURCES` 同时写入：dispatch 只读这一份，不再看 `spec.input`）。 */
const INPUT_SCHEMAS = new WeakMap<ControllerSpec, ConfigSchemaInput>();

/** 取归一化后的输入 schema（`defineController` 写进去的；手写 spec 没经过归一化时回落到 spec.input）。 */
export function inputSchemaOf(spec: ControllerSpec): ConfigSchemaInput | undefined {
  return INPUT_SCHEMAS.get(spec) ?? (spec.input as ConfigSchemaInput | undefined);
}

/** 控制器声明的诊断可见性（`'off'` 表示不出现在 `/__debug/routes`；没声明就是 `inherit`）。 */
const DEBUG_VISIBILITY = new WeakMap<ControllerSpec, DebugVisibility>();

export function debugVisibilityOf(controller: unknown): DebugVisibility {
  if (typeof controller !== 'object' || controller === null) return 'inherit';
  return DEBUG_VISIBILITY.get(controller as ControllerSpec) ?? 'inherit';
}

/**
 * **输入字段的字符串简写**（M9f T2）：`'string'` / `'int'` / `'number'` / `'bool'` / `'boolean'` / `'json'`
 * → 对应的字段声明（都**不带默认值**，即必填；要默认值就写全量写法）。
 *
 * 为什么需要单独一张别名表：`'int'` / `'bool'` 是"给人看的类型名"，而 `FieldType` 只有
 * `string|number|boolean|json`。不肯定的名字（打错的那种）**明确报错**，不静默当字符串。
 */
function expandTypeAlias(value: string, key: string): { type: FieldType } {
  switch (value) {
    case 'string':
      return { type: 'string' };
    case 'int':
    case 'number':
      return { type: 'number' };
    case 'bool':
    case 'boolean':
      return { type: 'boolean' };
    case 'json':
      return { type: 'json' };
    default:
      throw new Error(
        `defineController: 输入项 '${key}' 的类型简写 '${value}' 不认识` +
          `（支持：string / int / number / bool / boolean / json；要别的写法请用 { type: … } 全量形式）`,
      );
  }
}

/** 数组简写 = JSON 数组（`['x']` 给出一个示例元素，仅用于表意）。 */
function isAlias(value: unknown): value is string {
  return typeof value === 'string';
}

/** 取某个控制器声明的输入来源（没声明过就是空表 → 全部按 body/路径/查询的既有规则）。 */
export function inputSourcesOf(spec: ControllerSpec): Map<string, InputSource> {
  return INPUT_SOURCES.get(spec) ?? new Map();
}

function isFromSpec(value: unknown): value is InputFromSpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { from?: unknown }).from === 'string' &&
    ['body', 'query', 'params'].includes((value as { from: string }).from)
  );
}

function isFieldSpecLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * 声明一个控制器。
 *
 * 定义期做两件事（都是"归一化"，不改变语义）：
 *   ① **输入声明合一**：`input: { x: 'string' }`（值即 schema）与 `{ x: { from: 'query' } }` 都归一成
 *      标准字段声明，并记下来源（`body` 是默认来源）；
 *   ② 把"来自 body 的输入键"补进 `spec.body`，于是路由表的"键必须有来源"校验照旧生效
 *      （用户不再需要手写 `body: [...]` 与 `input` 两处）。
 */
export function defineController(spec: ControllerSpec): ControllerSpec {
  if (!spec.input) {
    if (spec.debug !== undefined) DEBUG_VISIBILITY.set(spec, spec.debug);
    return spec;
  }
  const sources = new Map<string, InputSource>();
  const normalized: ConfigSchemaInput = {};
  for (const [key, value] of Object.entries(spec.input)) {
    if (isFromSpec(value)) {
      const { from, ...rest } = value;
      sources.set(key, from);
      // `{ from: 'query' }`（只写来源）= 该键必填字符串；给了 type/default 就用它。
      // `rest` 本身是合法字段声明（`from` 之外的键就是 FieldSpec 的键），这里只是收一次类型。
      normalized[key] = Object.keys(rest).length === 0 ? { type: 'string' } : (rest as ConfigEntry);
      continue;
    }
    sources.set(key, 'body'); // 默认来自 body（设计已定）
    if (isAlias(value)) {
      normalized[key] = expandTypeAlias(value, key); // 字符串简写 → 对应字段声明
      continue;
    }
    if (isFieldSpecLike(value) || typeof value !== 'object' || value === null) {
      normalized[key] = value as ConfigEntry;
      continue;
    }
    // 普通对象（且没写 from）：输入是一层**扁平的表**，所以按 json 默认值处理（不展开成分组）
    normalized[key] = { type: 'json', default: value };
  }
  const bodyKeys = [...sources].filter(([, from]) => from === 'body').map(([key]) => key);
  const body = [...new Set([...(spec.body ?? []), ...bodyKeys])];
  const next: ControllerSpec = {
    ...spec,
    input: normalized,
    ...(body.length === 0 ? {} : { body }),
  };
  INPUT_SOURCES.set(next, sources);
  INPUT_SCHEMAS.set(next, normalized);
  if (spec.debug !== undefined) DEBUG_VISIBILITY.set(next, spec.debug);
  // routes.ts（被本模块依赖的下层）也要能知道"每个输入键的来源"，但它不能 import 本模块。
  // 所以额外挂一份**不可枚举**的副本：deepStrictEqual/JSON 都看不见它，只有规则 3 会读。
  Object.defineProperty(next, '__inputSources', {
    value: sources,
    enumerable: false,
    configurable: true,
  });
  return next;
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
  /** 已认证用户的 subject（authPlugin 设置了 ctx.user 时才有）。 */
  userId?: string;
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
  // 来源表（M9f）：没声明过来源的控制器按既有规则（路径 → 查询 → body 兜底）；
  // 声明过就**按来源精确组装**（`from: 'query'` 的键不再被同名 body 字段顶掉）。
  const rawController = route.controller as unknown as Controller;
  // 来源表：控制器显式声明的来源优先；**路由模式里的 `:param` / `?query=` 也是来源声明**
  // （没写 from 的旧写法靠它们定位，所以先把它们补进来，显式声明再覆盖）
  // 优先级：**显式 `from`** > 路由模式（`:param` / `?query=`）> 输入的默认来源（body）。
  // 为什么"显式 from"优先：它是使用者写下来的意图（`{ from:'query' }` 就该读查询）。
  // 为什么模式优先于"默认 body"：老写法（没有 from 概念）一直靠模式定位，
  // 而 `defineController` 给每个输入都记了默认 `body` —— 若不让模式插在中间，
  // `get('/rooms/:id?verbose=', controller({ input: { verbose: {type:'boolean'} } }))`
  // 里的 verbose 会被当成 body 字段，查询值直接被丢掉（实测回归）。
  const sources = new Map<string, InputSource>();
  const explicit = isControllerSpec(rawController) ? INPUT_SOURCES.get(rawController) : undefined;
  for (const name of route.pathParams) sources.set(name, 'params');
  for (const name of route.queryParams) sources.set(name, 'query');
  for (const [key, from] of explicit ?? []) {
    if (from !== 'body') sources.set(key, from); // 显式 from 覆盖模式
  }
  for (const [key, from] of explicit ?? []) {
    if (from === 'body' && !sources.has(key)) sources.set(key, 'body');
  }

  const declared: Record<string, unknown> = { ...params };
  for (const name of route.queryParams) {
    const fromQuery = querySource.get(name);
    if (fromQuery === null) continue;
    if (sources.get(name) !== 'query') continue; // 声明为 params/body 的键不接查询
    declared[name] = fromQuery;
  }
  // body：允许覆盖/补充（POST 场景）；声明了来源的键只接自己那一路
  if (body !== undefined && typeof body === 'object' && body !== null) {
    for (const [key, value] of Object.entries(body)) {
      const from = sources.get(key);
      if (from !== undefined && from !== 'body') continue;
      declared[key] ??= value;
    }
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

  // 当前路由的控制器声明：中间件（例如 authPlugin）据此决定"这条路要不要鉴权"。
  // 存在 WeakMap 里（不进 ctx.state）：既不会被用户的 extend({route}) 覆盖，也不会污染用户的可变袋。
  setRouteSpec(ctx, spec);

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
      const inputSchema = inputSchemaOf(spec);
      if (inputSchema) {
        const { values, issues } = validateValues(inputSchema, declared, `请求输入`);
        if (issues.length > 0) {
          throw new HttpError(400, 'input validation failed', { issues: issues satisfies ConfigIssue[] });
        }
        input = values;
      }
      return spec.handle(input, ctx);
    });
    const response = toResponse(result);
    // 已认证用户（authPlugin 会在 auth 阶段 ctx.extend({ user })）：给访问日志/诊断用
    const user = ctx.extension<{ sub?: string }>('user');
    return {
      matched: true,
      route,
      status: response.status,
      requestId,
      response,
      ...(user?.sub === undefined ? {} : { userId: user.sub }),
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
