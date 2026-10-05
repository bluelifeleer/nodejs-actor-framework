/**
 * 路由表与匹配（M2 第一步）——纯函数，不碰 HTTP，便于单测。
 *
 * 支持两种参数来源（docs/design/m2-web-layer.md §2.1）：
 *   get('/rooms/:id')        路径参数
 *   get('/rooms?id=')        查询参数（`?` 后只声明"会读取"，不参与路径匹配）
 *   get('/rooms/:id/players?limit=')   两者混用
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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
  readonly method: HttpMethod;
  /** 原始模式，如 `/rooms/:id/players?limit=`。 */
  readonly pattern: string;
  /** 归一化后的路径（去掉查询声明），如 `/rooms/:id/players`。 */
  readonly path: string;
  readonly segments: readonly string[];
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly controller: ControllerLike | ((input: unknown, ctx: unknown) => unknown);
}

function isControllerObject(value: unknown): value is ControllerLike {
  return typeof value === 'object' && value !== null && 'handle' in (value as Record<string, unknown>);
}

/** 解析一个模式串；返回 null 表示模式本身非法（启动时报错）。 */
export function parsePattern(
  method: HttpMethod,
  pattern: string,
  controller: Route['controller'],
): { route?: Route; issue?: RouteIssue } {
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
  // 规则 3：input schema 的键必须来自路径参数或已声明的查询参数
  if (isControllerObject(controller) && controller.input) {
    const declared = new Set([...pathParams, ...queryParams, ...(controller.body ?? [])]);
    for (const key of Object.keys(controller.input)) {
      if (!declared.has(key)) {
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
  }
  return {
    route: { method, pattern, path, segments, pathParams, queryParams, controller },
  };
}

/** 构建路由表；返回路由与启动期问题（重复、非法模式）。 */
export function buildRouteTable(
  entries: readonly (readonly [HttpMethod, string, Route['controller']])[],
): { routes: Route[]; issues: RouteIssue[] } {
  const routes: Route[] = [];
  const issues: RouteIssue[] = [];
  const seen = new Map<string, Route>();
  for (const [method, pattern, controller] of entries) {
    const { route, issue } = parsePattern(method, pattern, controller);
    if (issue || !route) {
      if (issue) issues.push(issue);
      continue;
    }
    // 规则 2：按 method + 路径模式判定重复（查询声明不参与）
    const key = `${method} ${route.path}`;
    const existing = seen.get(key);
    if (existing) {
      issues.push({
        message:
          `路由重复：${method} ${route.path}（已由 ${existing.pattern} 注册；` +
          `查询声明不参与匹配，若要区分请求请把参数放进路径）`,
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
  | { kind: 'matched'; route: Route; params: Record<string, string>; query: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: readonly HttpMethod[] }
  | { kind: 'not_found' };

/** 匹配一次请求。未声明的查询参数照常出现在 query 里（规则 1）。 */
export function matchRoute(routes: readonly Route[], input: MatchInput): MatchResult {
  const [rawPath = '', rawQuery = ''] = input.url.split('?', 2);
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const wanted = path.split('/').filter((seg) => seg.length > 0).map(decodeURIComponent);

  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawQuery)) query[key] = value;

  const method = input.method.toUpperCase();
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
  if (pathMatches.length > 0) {
    return {
      kind: 'method_not_allowed',
      allow: [...new Set(pathMatches.map((candidate) => candidate.route.method))],
    };
  }
  return { kind: 'not_found' };
}

export const get = (pattern: string, controller: Route['controller']): readonly [HttpMethod, string, Route['controller']] => ['GET', pattern, controller];
export const post = (pattern: string, controller: Route['controller']): readonly [HttpMethod, string, Route['controller']] => ['POST', pattern, controller];
export const put = (pattern: string, controller: Route['controller']): readonly [HttpMethod, string, Route['controller']] => ['PUT', pattern, controller];
export const patch = (pattern: string, controller: Route['controller']): readonly [HttpMethod, string, Route['controller']] => ['PATCH', pattern, controller];
export const del = (pattern: string, controller: Route['controller']): readonly [HttpMethod, string, Route['controller']] => ['DELETE', pattern, controller];

/** 声明一组路由（在 `defineModule({ routes })` 里使用）。 */
export function defineRoutes(
  entries: readonly (readonly [HttpMethod, string, Route['controller']])[],
): readonly (readonly [HttpMethod, string, Route['controller']])[] {
  return entries;
}
