import { defineWebPlugin, get } from '@actor/web';

/**
 * __PLUGIN_NAME__：一个 web 插件。
 *
 * 三个贡献点都能用：`routes`（带前缀）、`middleware`（**带阶段**，顺序由框架保证）、
 * `context`（每请求执行的派生值）。契约套件在 `test/contract.test.ts`（自证合规）。
 */
export const __PLUGIN_CAMEL__ = defineWebPlugin({
  name: '__PLUGIN_NAME__',
  routePrefix: '/__PLUGIN_CAMEL__',

  // 每请求执行一次：挂"启动时就确定"的派生值（要每请求变的，请在中间件里 ctx.extend）
  context: () => ({ __PLUGIN_CAMEL__Ready: true }),

  middleware: [
    {
      name: 'example',
      phase: 'pre',
      handler: async (_ctx, next) => next(),
    },
  ],

  routes: [get('/ping', () => ({ pong: true }))],
});

export default __PLUGIN_CAMEL__;
