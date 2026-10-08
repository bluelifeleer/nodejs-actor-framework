/**
 * 路由表与匹配（M2 第一步）——纯函数，不碰 HTTP，便于单测。
 *
 * 支持两种参数来源（docs/design/m2-web-layer.md §2.1）：
 *   get('/rooms/:id')        路径参数
 *   get('/rooms?id=')        查询参数（`?` 后只声明"会读取"，不参与路径匹配）
 *   get('/rooms/:id/players?limit=')   两者混用
 */

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** 路由方法 = HTTP 方法 + WS（WebSocket 路由复用同一套模式语法与启动期检查）。 */
export const ROUTE_METHODS = [...HTTP_METHODS, 'WS'] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

/**
 * 方法归一化：用户可能写小写（JS 侧尤其容易），也可能写错。
 * 归一化后再存表，并在启动期对未知方法报错——否则会变成"路由永远打不中"的静默故障。
 */
export function normalizeMethod(method: string): RouteMethod | null {
  const upper = String(method).trim().toUpperCase();
  return (ROUTE_METHODS as readonly string[]).includes(upper) ? (upper as RouteMethod) : null;
}

export interface RouteIssue {
  message: string;
  route?: string;
}

/** 控制器的最小形状（M1 的 deps/input/handle；M2 后续步骤会扩展 ctx）。 */
export interface ControllerLike {
  readonly deps?: readonly string[];
  readonly input?: Record<string, unknown>;
  /** 显式声明"这些输入来自请求体"（模式里无法声明 body 字段）。 */
  readonly body?: readonly string[];
  readonly handle?: unknown;
}

export interface Route {
  readonly method: RouteMethod;
  /** 原始模式，如 `/rooms/:id/players?limit=`。 */
  readonly pattern: string;
  /** 归一化后的路径（去掉查询声明），如 `/rooms/:id/players`。 */
  readonly path: string;
  readonly segments: readonly string[];
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly controller: ControllerLike | ((input: unknown, ctx: unknown) => unknown);
  /** 路由级中间件（在全局中间件之后、控制器之前的链上）。 */
  readonly middleware?: readonly unknown[];
  /** 归属信息（路由器/模块），用于诊断报错。 */
  readonly meta?: { module?: string; router?: string };
}

/**
 * 结构式读取"这个控制器声明了哪些输入来源"（不 import controller.ts：routes.ts 是被它依赖的下层）。
 * 读不到（普通对象/未归一化的 spec）就当空表。
 */
function readDeclaredInputSources(controller: unknown): Map<string, string> {
  const lookup = (controller as { __inputSources?: unknown }).__inputSources;
  return lookup instanceof Map ? (lookup as Map<string, string>) : new Map();
}

function isControllerObject(value: unknown): value is ControllerLike {
  return typeof value === 'object' && value !== null && 'handle' in (value as Record<string, unknown>);
}

/** 解析一个模式串；返回 null 表示模式本身非法（启动时报错）。 */
export function parsePattern(
  method: RouteMethod | string,
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
  meta?: { module?: string; router?: string },
): { route?: Route; issue?: RouteIssue } {
  const normalized = normalizeMethod(method);
  if (!normalized) {
    return {
      issue: {
        message: `不支持的方法 '${String(method)}'（支持：${ROUTE_METHODS.join(', ')}）`,
        route: pattern,
      },
    };
  }
  const methodValue: RouteMethod = normalized;
  if (!pattern.startsWith('/')) {
    return { issue: { message: `路由必须以 / 开头：'${pattern}'`, route: pattern } };
  }
  const [rawPath = '', rawQuery = ''] = pattern.split('?', 2);
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const segments = path.split('/').filter((seg) => seg.length > 0);
  const pathParams: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (name.length === 0) return { issue: { message: `路径参数缺少名字：'${pattern}'`, route: pattern } };
      if (pathParams.includes(name)) {
        return { issue: { message: `路径参数重复：'${name}'（${pattern}）`, route: pattern } };
      }
      pathParams.push(name);
    } else if (segment.includes(':')) {
      return { issue: { message: `参数必须独占一段（写成 /:name）：'${pattern}'`, route: pattern } };
    }
  }
  const queryParams: string[] = [];
  for (const piece of rawQuery.split('&')) {
    const name = piece.replace(/=$/, '').trim();
    if (name.length === 0) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { issue: { message: `非法的查询参数名：'${name}'（${pattern}）`, route: pattern } };
    }
    if (queryParams.includes(name)) {
      return { issue: { message: `查询参数重复：'${name}'（${pattern}）`, route: pattern } };
    }
    queryParams.push(name);
  }
  // 规则 3：input schema 的键必须有**来源** —— 路径参数、已声明的查询参数、body，或显式的 from 声明。
  //
  // M9f 起 `defineController` 会把"来自 body 的输入键"自动补进 `controller.body`，所以这条校验
  // 主要在"手写 spec 忘了声明来源"时起作用（错字/漏写仍然被拦）。`from` 声明由控制器模块记账
  // （`inputSourcesOf`），这里按结构读一次即可 —— 有意不 import controller.ts，保持 routes.ts 的依赖方向。
  if (isControllerObject(controller) && controller.input) {
    const declared = new Set([...pathParams, ...queryParams, ...(controller.body ?? [])]);
    for (const key of Object.keys(controller.input)) {
      if (declared.has(key)) continue;
      const declaredFrom = readDeclaredInputSources(controller).get(key);
      if (declaredFrom !== undefined) continue; // 显式声明了来源（from: 'query' | 'params' | 'body'）
      return {
        issue: {
          message:
            `input 声明了 '${key}'，但它既不是路径参数、也不是查询参数、也不在 body 声明里（${pattern}）——` +
            `请写成 /:${key}、?${key}= 或 body: ['${key}']`,
          route: pattern,
        },
      };
    }
  }
  return {
    route: {
      method: methodValue, pattern, path, segments, pathParams, queryParams, controller,
      ...(middleware ? { middleware } : {}),
      ...(meta ? { meta } : {}),
    },
  };
}

/** 构建路由表；返回路由与启动期问题（重复、非法模式）。 */
export function buildRouteTable(
  entries: readonly (readonly [
    RouteMethod,
    string,
    Route['controller'],
    (readonly unknown[] | undefined)?,
    ({ module?: string; router?: string } | undefined)?,
  ])[],
): { routes: Route[]; issues: RouteIssue[] } {
  const routes: Route[] = [];
  const issues: RouteIssue[] = [];
  const seen = new Map<string, Route>();
  for (const [method, pattern, controller, middleware, meta] of entries) {
    const { route, issue } = parsePattern(method, pattern, controller, middleware, meta);
    if (issue || !route) {
      if (issue) issues.push(issue);
      continue;
    }
    // 规则 2：按 method + 路径模式判定重复（查询声明不参与）
    const key = `${method} ${route.path}`;
    const existing = seen.get(key);
    if (existing) {
      const owner = existing.meta?.module ?? existing.meta?.router;
      const newcomer = meta?.module ?? meta?.router;
      issues.push({
        message:
          `路由重复：${String(method)} ${route.path}` +
          (owner ? `（已由 ${owner} 注册` : '（已注册') +
          (newcomer ? `，${newcomer} 想再注册一次` : '') +
          `；查询声明不参与匹配，若要区分请求请把参数放进路径）`,
        route: pattern,
      });
      continue;
    }
    seen.set(key, route);
    routes.push(route);
  }
  return { routes, issues };
}

export interface MatchInput {
  method: string;
  /** 请求目标，如 `/rooms/42?verbose=1`。 */
  url: string;
}

export type MatchResult =
  | {
      kind: 'matched';
      route: Route;
      params: Record<string, string>;
      query: Record<string, string>;
      /** HEAD 请求命中了 GET 路由：响应照常计算，但不得返回 body。 */
      headOnly?: true;
    }
  | { kind: 'method_not_allowed'; allow: readonly HttpMethod[] }
  /** OPTIONS 预检：无专门路由时按标准返回 Allow 列表（204）。 */
  | { kind: 'options'; allow: readonly HttpMethod[] }
  | { kind: 'not_found' };

/** 匹配一次请求。未声明的查询参数照常出现在 query 里（规则 1）。 */
export function matchRoute(routes: readonly Route[], input: MatchInput): MatchResult {
  const [rawPath = '', rawQuery = ''] = input.url.split('?', 2);
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const wanted = path.split('/').filter((seg) => seg.length > 0).map(decodeURIComponent);

  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawQuery)) query[key] = value;

  const method = (normalizeMethod(input.method) ?? input.method.trim().toUpperCase()) as HttpMethod;
  const pathMatches: { route: Route; params: Record<string, string> }[] = [];
  for (const route of routes) {
    if (route.segments.length !== wanted.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (const [index, segment] of route.segments.entries()) {
      const actual = wanted[index] as string;
      if (segment.startsWith(':')) params[segment.slice(1)] = actual;
      else if (segment !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) pathMatches.push({ route, params });
  }

  const exact = pathMatches.find((candidate) => candidate.route.method === method);
  if (exact) return { kind: 'matched', route: exact.route, params: exact.params, query };

  // HEAD 没专门路由时按 GET 处理（标准行为：curl -I / 健康检查），由服务器丢弃 body
  if (method === 'HEAD') {
    const asGet = pathMatches.find((candidate) => candidate.route.method === 'GET');
    if (asGet) {
      return { kind: 'matched', route: asGet.route, params: asGet.params, query, headOnly: true };
    }
  }
  if (pathMatches.length > 0) {
    // Allow 只列 HTTP 方法（WS 不是 HTTP 方法）；若该路径只有 WS 路由，对 HTTP 请求就是 404
    const allow = [...new Set(pathMatches.map((candidate) => candidate.route.method))].filter(
      (m): m is HttpMethod => m !== 'WS',
    );
    if (allow.length > 0) {
      // OPTIONS 无专门路由时按标准返回 Allow（204），而不是 405
      if (method === 'OPTIONS') return { kind: 'options', allow };
      return { kind: 'method_not_allowed', allow };
    }
  }
  return { kind: 'not_found' };
}

export const get = (
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
): readonly [(HttpMethod | RouteMethod), string, Route['controller'], (readonly unknown[] | undefined)?] =>
  ['GET', pattern, controller, middleware];
export const post = (
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
): readonly [(HttpMethod | RouteMethod), string, Route['controller'], (readonly unknown[] | undefined)?] =>
  ['POST', pattern, controller, middleware];
export const put = (
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
): readonly [(HttpMethod | RouteMethod), string, Route['controller'], (readonly unknown[] | undefined)?] =>
  ['PUT', pattern, controller, middleware];
export const patch = (
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
): readonly [(HttpMethod | RouteMethod), string, Route['controller'], (readonly unknown[] | undefined)?] =>
  ['PATCH', pattern, controller, middleware];
export const del = (
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
): readonly [(HttpMethod | RouteMethod), string, Route['controller'], (readonly unknown[] | undefined)?] =>
  ['DELETE', pattern, controller, middleware];
export const head = (
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
): readonly [(HttpMethod | RouteMethod), string, Route['controller'], (readonly unknown[] | undefined)?] =>
  ['HEAD', pattern, controller, middleware];
export const options = (
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
): readonly [(HttpMethod | RouteMethod), string, Route['controller'], (readonly unknown[] | undefined)?] =>
  ['OPTIONS', pattern, controller, middleware];

/** WebSocket 路由：与 HTTP 路由共用模式语法（路径参数 / 查询参数 / 启动期检查）。 */
export const ws = (
  pattern: string,
  controller: Route['controller'],
  middleware?: readonly unknown[],
): readonly [(HttpMethod | RouteMethod), string, Route['controller'], (readonly unknown[] | undefined)?] =>
  ['WS', pattern, controller, middleware];

/** 声明一组路由（在 `defineModule({ routes })` 里使用）。 */
/**
 * 声明一组路由（运行时是恒等的）。
 *
 * 注意它必须接受**助手函数的产出形状**：`get/post/put/...` 返回的是
 * `[method, pattern, controller, middleware?]`（第 4 位可选）。早先这里只接受 3 元组，
 * 于是 `defineRoutes([get(...)])` 是类型错误 —— 而示例没进 typecheck 矩阵，一直没暴露。
 */
export function defineRoutes<T extends readonly (readonly unknown[])[]>(entries: T): T {
  return entries;
}

/**
 * 检查"落在框架保留前缀里"的**模块/路由器路由**，转成启动期 issue。
 *
 * 为什么单独一条检查：路由表查的是**模式重复**，而撞名字不是重复（`/uploads` 与 `/uploads/:key` 是两个模式）
 * —— 于是用户路由与框架路由会同时存在，匹配到谁取决于声明顺序，属于静默漂移。
 * `httpPlugin` / `wsPlugin` 都用这一条（两处装的是同一份路由表，不该有两套口径）。
 *
 * 输入是 `flattenRoutes` 的**扁平元组** `[method, pattern, controller, middleware?, meta?]`。
 * 早先这里按 `{ pattern }` 对象读，而调用方传的是元组 → `pattern` 恒为 `undefined`，校验**看着装了、
 * 其实一条都没查**（"绿但不覆盖"那类事故）。现在同时接受两种形状，并有"必须能拦住"的用例盯着。
 *
 * **没有放行名单**：这条检查只对"带归属信息"的路由生效（即模块/路由器声明的路由），
 * 它们落在保留区一律报错。框架自带插件的路由**不带归属**（`RouteMeta` 只记模块/路由器名），
 * 因此不经过这里 —— 它们在**插件层**被 `pluginPrefixCollisions` 校验（那一层归属明确）。
 *
 * 两次静默失效的教训（都是实测踩到的）：
 *   ① 早先按 `{ pattern }` 对象读元组 → `pattern` 恒为 `undefined`，校验一条都没查；
 *   ② 早先把保留清单算作"已认领/可放行" → 所有 `/__debug/*` 都成了合法。
 * 所以这里坚持：判据只有一个，就是"模式是否落在保留前缀里"。
 */
export function reservedPrefixIssues(
  entries: readonly unknown[],
  reserved: readonly { owner: string; prefix: string }[],
  isReserved: (pattern: string) => boolean,
): RouteIssue[] {
  const issues: RouteIssue[] = [];
  for (const item of entries) {
    let pattern: string | undefined;
    let owner: string | undefined;
    if (Array.isArray(item)) {
      // 扁平元组：[method, pattern, controller, middleware?, meta?]
      pattern = typeof item[1] === 'string' ? item[1] : undefined;
      const meta = item[4] as { module?: string; router?: string } | undefined;
      owner = meta?.module ?? meta?.router;
    } else if (typeof item === 'object' && item !== null) {
      const record = item as { pattern?: unknown; meta?: { module?: string; router?: string } };
      pattern = typeof record.pattern === 'string' ? record.pattern : undefined;
      owner = record.meta?.module ?? record.meta?.router;
    }
    if (pattern === undefined || !isReserved(pattern)) continue;
    issues.push({
      message:
        `路由 "${pattern}" 落在框架保留前缀里 —— 这片命名空间由内置插件占用` +
        `（${reserved.map((entry) => `${entry.owner}=${entry.prefix}`).join(' / ')}），` +
        `请换一个前缀，或给对应插件传 routePrefix/prefix 换到你的命名空间` +
        (owner === undefined ? '（这条路由没有归属信息）' : `（路由归属：${owner}）`),
      route: pattern,
    });
  }
  return issues;
}
