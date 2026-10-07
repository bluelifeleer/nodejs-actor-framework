import { defineController } from '@actor/web';

/**
 * Actor 句柄的最小类型。框架的 `ctx.actor(name)` 有意返回 `unknown`（不把内核类型漏到 web 层），
 * 所以在边界上显式收窄一次 —— 消息类型与 Actor 的 `receive` 对齐。
 */
interface CounterRef {
  ask<R = unknown>(msg: { type: 'add'; by?: number } | { type: 'get' }): Promise<R>;
}

const counterRef = (ctx: { actor(name: string): unknown }): CounterRef => ctx.actor('Counter') as CounterRef;

/**
 * 写路径走 Actor：命令只做校验，状态由 Actor 自己维护并持久化。
 * 查询也走 Actor 只是为了演示 `ask` 的返回值——真实的列表/统计应该走投影或仓储。
 */
export const counter = {
  add: defineController({
    body: ['by'],
    input: { by: { type: 'number', default: 1 } },
    async handle(input, ctx) {
      return { count: await counterRef(ctx).ask<number>({ type: 'add', by: Number(input.by) }) };
    },
  }),

  read: defineController({
    async handle(_input, ctx) {
      return { count: await counterRef(ctx).ask<number>({ type: 'get' }) };
    },
  }),
};
