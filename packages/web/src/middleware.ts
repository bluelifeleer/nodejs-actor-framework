/**
 * 中间件（M2.5）：Koa 风格 `(ctx, next)`。
 *
 * 为什么不用 Express 式 `next()` 回调：`await next()` 让"前置/后置"逻辑写在同一个函数里，
 * 后置部分自然逆序展开；也不耦合 `req/res`（保持应用层概念）。
 */

import type { RequestContext } from './context.ts';

export type Middleware = (
  ctx: RequestContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

export function defineMiddleware(fn: Middleware): Middleware {
  return fn;
}

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
