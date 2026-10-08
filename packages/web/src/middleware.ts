/**
 * 中间件（M2.5）：Koa 风格 `(ctx, next)`。
 *
 * 为什么不用 Express 式 `next()` 回调：`await next()` 让"前置/后置"逻辑写在同一个函数里，
 * 后置部分自然逆序展开；也不耦合 `req/res`（保持应用层概念）。
 */

import type { RequestContext } from './context.ts';
import type { MiddlewarePhase } from './plugins.ts';

export type Middleware = (
  ctx: RequestContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

export function defineMiddleware(fn: Middleware): Middleware {
  return fn;
}

/**
 * **阶段即函数名（M9f T2）**：`auth(handler)` 等价于 `{ handler, phase: 'auth' }`。
 *
 * 为什么值得加：阶段顺序是框架保证的（不靠使用者记得"鉴权要排在解析上传前面"），
 * 但写成对象字面量既不显眼也容易漏掉 `phase`（漏了就静默按 `pre` 排）。用函数名表达阶段，
 * 顺序在**调用处**就看得见。
 *
 * 实现是"给函数挂 `phase` 属性"（`orderMiddleware` 本来就认这种函数）——所以与对象写法**完全等价**，
 * 且两种写法可以在同一条链里混用。`name` 只影响诊断输出里显示的阶段名。
 */
export function phase(phaseName: MiddlewarePhase, fn: Middleware, name?: string): Middleware {
  // 包一层而不是给原函数挂属性：函数的 `name` 是只读的（实测 `tagged.name = …` 会抛
  // "Cannot assign to read only property 'name'"），而 `name` 是诊断输出要用的显示名。
  const tagged: Middleware & { phase?: MiddlewarePhase; name?: string } = async (ctx, next) =>
    fn(ctx, next);
  tagged.phase = phaseName;
  if (name !== undefined) Object.defineProperty(tagged, 'name', { value: name, configurable: true });
  return tagged as Middleware;
}

/**
 * 六个阶段的简写：`atPre` / `atAuth` / `atParse` / `atHandler` / `atPost` / `atError`。
 *
 * 为什么带 `at` 前缀、而不是直接叫 `post` / `parse` / `error`：这三个名字与**既有导出/全局**冲突 ——
 * `post` 已经是 `@actor/web` 的路由助手（`post('/notes', …)`），`JSON.parse` 与 `error` 也一样常见。
 * 在同一个文件里 `import { post } from '@actor/web'` 会直接撞名（实测：示例因此编译不过）。
 * 名字短一点不值这个代价，所以统一加前缀 —— 阶段一眼可读，且**不与任何既有名字争**。
 */
export const atPre = (handler: Middleware, name?: string): Middleware => phase('pre', handler, name);
export const atAuth = (handler: Middleware, name?: string): Middleware => phase('auth', handler, name);
export const atParse = (handler: Middleware, name?: string): Middleware => phase('parse', handler, name);
export const atHandler = (handler: Middleware, name?: string): Middleware => phase('handler', handler, name);
export const atPost = (handler: Middleware, name?: string): Middleware => phase('post', handler, name);
export const atError = (handler: Middleware, name?: string): Middleware => phase('error', handler, name);

/**
 * 组合中间件链：声明顺序执行，`await next()` 之后的部分逆序展开。
 * 短路：不调用 next() 直接返回响应（或抛 HttpError）即结束。
 * 返回值：最外层中间件的返回值（通常是控制器结果或短路响应）。
 */
export function composeMiddleware(
  chain: readonly Middleware[],
): (ctx: RequestContext, final: () => Promise<unknown>) => Promise<unknown> {
  return async (ctx: RequestContext, final: () => Promise<unknown>): Promise<unknown> => {
    const runAt = async (index: number): Promise<unknown> => {
      const middleware = chain[index];
      if (!middleware) return final();
      let called = false;
      const next = async (): Promise<unknown> => {
        if (called) throw new Error('next() 每个中间件只能调用一次');
        called = true;
        return runAt(index + 1);
      };
      return middleware(ctx, next);
    };
    return runAt(0);
  };
}
