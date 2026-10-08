/**
 * 路由器嵌套与前缀（M2.5 R1–R3）。
 *
 * 决策（用户确认）：
 *   R1 子树中间件——路由器的 middleware 作用于**整棵子树**（外层先执行）；
 *   R2 前缀里允许路径参数（/tenants/:tenantId），跨层参数重名在构建期报错；
 *   R3 同一模块不允许混用 routes 与 router（构建期报错，显式优于隐式）。
 *
 * 中间件在**构建期烘焙**进叶子路由（而不是运行时查树）：dispatch 热路径不变，
 * 顺序在数据里显式可见、可直接断言。
 */

import type { Middleware } from './middleware.ts';
import { ROUTE_METHODS, type RouteMethod } from './routes.ts';

/** 叶子路由声明：[方法, 模式, 控制器, 路由级中间件?]。 */
export type RouteEntry = readonly [RouteMethod, string, unknown, (readonly unknown[] | undefined)?];

/** 归属信息：用于重复路由等诊断（指名道姓）。 */
export interface RouteMeta {
  module?: string;
  router?: string;
  /**
   * 路由所属模块的**诊断可见性**声明（`defineModule({ debug })` 的原样透传，由 debugPlugin 解读）。
   * 应用层不认识它的内容，所以这里是不透明类型。
   */
  debug?: unknown;
}

/** 扁平化后的条目：中间件已在构建期合成完毕。 */
export type FlatRouteEntry = readonly [RouteMethod, string, unknown, readonly Middleware[], RouteMeta];

export interface RouterSpec {
  /** 该路由器下所有路由的公共前缀，如 '/game'。必须以 / 开头、不含 ?。 */
  prefix?: string;
  /** 模块级诊断可见性声明（不透明：应用层/路由器都不解释，只有 debugPlugin 读）。 */
  debug?: unknown;
  /** 作用于整个子树的中间件（外层先执行）。 */
  middleware?: readonly Middleware[];
  /** 叶子路由。 */
  routes?: readonly RouteEntry[];
  /** 子路由器（可多层嵌套）。 */
  children?: readonly RouterSpec[];
  /** 诊断用名字（出现在重复路由等报错里）。 */
  name?: string;
}

export interface RouterIssue {
  message: string;
}

export function defineRouter(spec: RouterSpec): RouterSpec {
  return spec;
}

function normalizePrefix(prefix: string | undefined, issues: RouterIssue[], where: string): string {
  if (prefix === undefined || prefix === '' || prefix === '/') return '';
  if (!prefix.startsWith('/')) {
    issues.push({ message: `路由器${where}的前缀必须以 / 开头：'${prefix}'` });
    return '';
  }
  if (prefix.includes('?')) {
    issues.push({ message: `路由器${where}的前缀不能含查询声明（? 只能出现在叶子路由）：'${prefix}'` });
    return '';
  }
  return prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

const join = (parent: string, child: string): string =>
  child === '' || child === '/' ? parent : `${parent}${child}`;

/**
 * 扁平化路由器：合成前缀、烘焙子树中间件、带上归属信息。
 * 纯函数（无副作用）→ 可单独单测。
 */
export function flattenRouter(
  spec: RouterSpec,
  parent: { prefix?: string; middleware?: readonly Middleware[]; router?: string; debug?: unknown } = {},
): { entries: FlatRouteEntry[]; issues: RouterIssue[] } {
  const issues: RouterIssue[] = [];
  const prefix = join(parent.prefix ?? '', normalizePrefix(spec.prefix, issues, spec.name ? ` '${spec.name}'` : ''));
  const middleware: readonly Middleware[] = [...(parent.middleware ?? []), ...(spec.middleware ?? [])];
  const routerName = spec.name ?? parent.router;
  // 模块级 debug 声明：本层没写就继承父层（模块根声明对整棵子树生效）
  const debug = spec.debug ?? parent.debug;
  const meta: RouteMeta = {
    ...(routerName === undefined ? {} : { router: routerName }),
    ...(debug === undefined ? {} : { debug }),
  };

  const entries: FlatRouteEntry[] = [];
  if (spec.routes !== undefined && !Array.isArray(spec.routes)) {
    issues.push({
      message:
        `路由器${routerName ? ` '${routerName}'` : ''}的 routes 必须是数组` +
        `（若是 routes({...}) 的产物，请放到 children 或用 defineModule 的 router 字段）`,
    });
  }
  for (const entry of (Array.isArray(spec.routes) ? spec.routes : [])) {
    const [method, pattern, controller, routeMiddleware] = entry;
    if (!pattern.startsWith('/')) {
      issues.push({ message: `路由模式必须以 / 开头：'${pattern}'${routerName ? `（${routerName}）` : ''}` });
      continue;
    }
    entries.push([
      method,
      `${prefix}${pattern === '/' ? '' : pattern}` || '/',
      controller,
      [...middleware, ...((routeMiddleware ?? []) as readonly Middleware[])],
      meta,
    ]);
  }
  for (const child of spec.children ?? []) {
    const result = flattenRouter(child, {
      prefix,
      middleware,
      ...(routerName === undefined ? {} : { router: routerName }),
      ...(debug === undefined ? {} : { debug }),
    });
    entries.push(...result.entries);
    issues.push(...result.issues);
  }
  return { entries, issues };
}

/**
 * 把模块声明的路由统一扁平化：数组（元组）原样成为叶子；普通对象（路由器形状）递归展开。
 * 应用层不认识路由器类型，但它组装的普通对象与本文件的结构一致 —— 于是"嵌套是 Web 层概念"
 * 这条边界不需要应用层 import Web 层。
 */
export function flattenRoutes(input: readonly unknown[]): { entries: FlatRouteEntry[]; issues: RouterIssue[] } {
  const entries: FlatRouteEntry[] = [];
  const issues: RouterIssue[] = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      const [method, pattern, controller, routeMiddleware] = item as unknown as RouteEntry;
      if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
        issues.push({ message: `路由模式必须以 / 开头：'${String(pattern)}'` });
        continue;
      }
      entries.push([method, pattern, controller, (routeMiddleware ?? []) as readonly Middleware[], {}]);
      continue;
    }
    if (typeof item === 'object' && item !== null) {
      const result = flattenRouter(item as RouterSpec);
      entries.push(...result.entries);
      issues.push(...result.issues);
      continue;
    }
    issues.push({ message: `无法识别的路由声明：${String(item)}` });
  }
  return { entries, issues };
}

// --- 语法糖：按方法分组的对象字面量表 -------------------------------------

const WRAPPED = Symbol.for('actor.web.withMiddleware');

export interface WithMiddleware {
  [WRAPPED]: true;
  controller: unknown;
  middleware: readonly Middleware[];
}

/**
 * 给单条路由挂中间件（对象表里没有别的地方能表达"这一条的中间件"）。
 * 用 Symbol 作为标记，避免与"控制器本身是对象"产生歧义。
 */
export function withMiddleware(controller: unknown, middleware: readonly Middleware[]): WithMiddleware {
  return { [WRAPPED]: true, controller, middleware };
}

function unwrapMiddleware(value: unknown): { controller: unknown; middleware?: readonly Middleware[] } {
  if (typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[WRAPPED] === true) {
    const wrapped = value as unknown as WithMiddleware;
    return { controller: wrapped.controller, middleware: wrapped.middleware };
  }
  return { controller: value };
}

type MethodTable = Record<string, unknown>;

export interface RoutesTableSpec {
  prefix?: string;
  middleware?: readonly Middleware[];
  name?: string;
  children?: readonly RouterSpec[];
  GET?: MethodTable;
  HEAD?: MethodTable;
  POST?: MethodTable;
  PUT?: MethodTable;
  PATCH?: MethodTable;
  DELETE?: MethodTable;
  OPTIONS?: MethodTable;
  WS?: MethodTable;
}

/**
 * 语法糖：`routes({ prefix, middleware, GET: { '/x': controller }, children: [...] })`。
 *
 * 它只是 `RouterSpec` 的另一种写法（纯函数、零新概念）——输出的仍是同一份数据，
 * 因此前缀规则、规则 3、重复路由归属报错、WS 嵌套等启动期检查全部照旧。
 * 顺序：按方法枚举顺序（GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS/WS），同方法内按书写顺序。
 */
export function routes(spec: RoutesTableSpec): RouterSpec {
  const entries: RouteEntry[] = [];
  const table = spec as unknown as Record<string, MethodTable | undefined>;
  for (const method of ROUTE_METHODS) {
    const methodTable = table[method];
    if (!methodTable) continue;
    for (const [pattern, value] of Object.entries(methodTable)) {
      const unwrapped = unwrapMiddleware(value);
      entries.push([method, pattern, unwrapped.controller, unwrapped.middleware]);
    }
  }
  return {
    ...(spec.name === undefined ? {} : { name: spec.name }),
    ...(spec.prefix === undefined ? {} : { prefix: spec.prefix }),
    ...(spec.middleware === undefined ? {} : { middleware: spec.middleware }),
    ...(spec.children === undefined ? {} : { children: spec.children }),
    routes: entries,
  };
}
