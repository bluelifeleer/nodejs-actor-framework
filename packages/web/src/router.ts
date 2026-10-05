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
import type { RouteMethod } from './routes.ts';

/** 叶子路由声明：[方法, 模式, 控制器, 路由级中间件?]。 */
export type RouteEntry = readonly [RouteMethod, string, unknown, (readonly unknown[] | undefined)?];

/** 归属信息：用于重复路由等诊断（指名道姓）。 */
export interface RouteMeta {
  module?: string;
  router?: string;
}

/** 扁平化后的条目：中间件已在构建期合成完毕。 */
export type FlatRouteEntry = readonly [RouteMethod, string, unknown, readonly Middleware[], RouteMeta];

export interface RouterSpec {
  /** 该路由器下所有路由的公共前缀，如 '/game'。必须以 / 开头、不含 ?。 */
  prefix?: string;
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
  parent: { prefix?: string; middleware?: readonly Middleware[]; router?: string } = {},
): { entries: FlatRouteEntry[]; issues: RouterIssue[] } {
  const issues: RouterIssue[] = [];
  const prefix = join(parent.prefix ?? '', normalizePrefix(spec.prefix, issues, spec.name ? ` '${spec.name}'` : ''));
  const middleware: readonly Middleware[] = [...(parent.middleware ?? []), ...(spec.middleware ?? [])];
  const routerName = spec.name ?? parent.router;
  const meta: RouteMeta = {
    ...(routerName === undefined ? {} : { router: routerName }),
  };

  const entries: FlatRouteEntry[] = [];
  for (const entry of spec.routes ?? []) {
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
    const result = flattenRouter(child, { prefix, middleware, ...(routerName === undefined ? {} : { router: routerName }) });
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
