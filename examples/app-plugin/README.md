# app-plugin：用户自定义 web 插件

演示 `defineWebPlugin()` 的三个贡献点：

```ts
export const greetingPlugin = defineWebPlugin({
  name: 'greeting',
  routePrefix: '/greeting',          // 路由前缀（定义时套到每个模式上）
  context: () => ({ greetingBuiltAt: new Date().toISOString() }),  // 每请求执行
  middleware: [
    { name: 'count',  phase: 'pre',  handler: async (ctx, next) => { ctx.extend({ seen: 1 }); return next(); } },
    { name: 'whoami', phase: 'auth', handler: async (ctx, next) => { ctx.extend({ who: ctx.header('x-who') }); return next(); } },
  ],
  routes: [get('/hello', defineController({ async handle(_i, ctx) { return { who: ctx.who }; } }))],
});
```

**阶段由框架保证顺序**（`pre → auth → parse → handler → post → error`），不用自己排"鉴权要早于解析上传"。

## 跑起来

```bash
cd examples/app-plugin
node main.ts
```

```bash
curl -s localhost:PORT/health
curl -s localhost:PORT/greeting/hello                     # who=anonymous
curl -s localhost:PORT/greeting/hello -H 'x-who: alice'   # who=alice
curl -s -X POST localhost:PORT/greeting/echo -H 'content-type: application/json' -d '{"text":"hi"}'
```

## 用户自己写的插件怎么自证合规

```ts
import { runWebPluginContract } from '@actor/web';

runWebPluginContract({ name: 'greeting', define: () => greetingPlugin });
```

它检查：名字/阶段合法、路由带前缀不冲突、`context` 钩子注册成服务、非法阶段与重复路由在定义期被拒、
以及中间件阶段排序（真实执行验证）。
