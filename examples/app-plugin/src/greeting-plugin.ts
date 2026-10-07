import { defineController, defineWebPlugin, get, post, reply } from '@actor/web';

/**
 * **用户自定义 web 插件**：三样东西一起贡献 ——
 *   1. `routes`（带 `routePrefix`）；
 *   2. 带**阶段**的中间件（`auth` 阶段一定跑在 `handler` 之前，不用自己排顺序）；
 *   3. `context` 钩子（每请求执行，往 ctx 上挂派生值）。
 *
 * 想给每个请求挂"随请求变化"的值（例如登录用户），请在**中间件**里 `ctx.extend({ user })` ——
 * 这样 `auth` 阶段设置、控制器读取。
 */
export const greetingPlugin = defineWebPlugin({
  name: 'greeting',
  routePrefix: '/greeting',
  context: () => ({ greetingBuiltAt: new Date().toISOString() }),

  middleware: [
    {
      name: 'count',
      phase: 'pre',
      handler: async (ctx, next) => {
        const seen = Number((ctx.state.seen as number | undefined) ?? 0) + 1;
        ctx.extend({ seen });
        return next();
      },
    },
    {
      name: 'whoami',
      phase: 'auth',
      handler: async (ctx, next) => {
        // 示例：从请求头里认人（真实场景换成校验 JWT —— 见 M8c 的 authPlugin）
        const who = ctx.header('x-who') ?? 'anonymous';
        ctx.extend({ who, authenticated: who !== 'anonymous' });
        return next();
      },
    },
  ],

  routes: [
    get(
      '/hello',
      defineController({
        async handle(_input, ctx) {
          return {
            who: (ctx as unknown as { who?: string }).who,
            authenticated: (ctx as unknown as { authenticated?: boolean }).authenticated,
            seen: (ctx as unknown as { seen?: number }).seen,
            greetingBuiltAt: ctx.extension<string>('greetingBuiltAt'),
          };
        },
      }),
    ),
    post(
      '/echo',
      defineController({
        body: ['text'],
        input: { text: { type: 'string' } },
        async handle(input, ctx) {
          return reply.json({ echo: String(input.text), who: (ctx as unknown as { who?: string }).who });
        },
      }),
    ),
  ],
});
