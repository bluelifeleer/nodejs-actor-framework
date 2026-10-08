# Web 插件（用户自定义插件逻辑）

框架的插件契约是 `PluginSpec`（`@actor/app`）；Web 层在它之上加了三个**贡献点**，这就是
`defineWebPlugin()`（`@actor/web`）：

| 贡献点 | 作用 |
|---|---|
| `routes` + `routePrefix` | 插件贡献路由（前缀在**定义时**套到每个模式上） |
| `middleware: [{ handler, phase }]` | 贡献中间件，**阶段由框架保证顺序** |
| `context: (ctx) => values` | 每请求执行一次，往 ctx 上挂派生值（如 `ctx.log`） |

**阶段顺序**：`pre → auth → parse → handler → post → error`。未声明阶段的中间件按 `pre` 处理 ——
所以既有代码的顺序**完全不变**（有测试钉住）。

> 为什么要有阶段：`auth` 必须跑在 `parse`（上传解析）之前 —— 未授权的请求不该触发落盘。
> 靠人肉排中间件顺序，迟早出错。

```js verify
import { defineWebPlugin, orderMiddleware, MIDDLEWARE_PHASES } from '@actor/web';

const plugin = defineWebPlugin({
  name: 'greeting',
  routePrefix: '/greeting',
  context: () => ({ builtAt: 'now' }),
  middleware: [
    { handler: async (ctx, next) => next(), phase: 'pre' },
    { handler: async (ctx, next) => next(), phase: 'auth' },
  ],
  routes: [],
});

console.log('插件名 →', plugin.name, '| 阶段 →', MIDDLEWARE_PHASES.join(' → '));

// 排序语义：未声明阶段的按 pre 处理，稳定（同阶段保持声明顺序）
const order = [];
const tag = (label) => async () => { order.push(label); };
const chain = orderMiddleware([
  tag('unphased-1'),
  { handler: tag('post'), phase: 'post' },
  { handler: tag('auth'), phase: 'auth' },
  tag('unphased-2'),
]);
for (const handler of chain) await handler({}, async () => undefined);
console.log('执行顺序 →', order.join(' → '));
if (order.join(',') !== 'unphased-1,unphased-2,auth,post') throw new Error('阶段排序不对');
```

## 三样东西怎么用

```ts
import { defineController, defineWebPlugin, get } from '@actor/web';

export const myPlugin = defineWebPlugin({
  name: 'my-plugin',                  // 也是配置节名：plugins.my-plugin.*
  routePrefix: '/my',

  // ① 每请求执行一次（挂"启动时就确定"的派生值，例如日志器）
  context: () => ({ log: console }),

  // ② 带阶段的中间件：想给"每个请求变"的值，在这里 extend
  middleware: [
    {
      name: 'auth',
      phase: 'auth',
      handler: async (ctx, next) => {
        const who = ctx.header('x-who') ?? 'anonymous';
        ctx.extend({ who });            // 控制器里可以直接读到这个派生值
        return next();
      },
    },
  ],

  // ③ 路由（前缀自动套上）
  // 读插件自己挂的值：用 extension<T>()（带类型，比直接读 ctx 上的临时属性更好）
  routes: [get('/hello', defineController({ async handle(_input, ctx) { return { who: ctx.extension('who') }; } }))],
});
```

装载：`defineApp({ modules, plugins: [myPlugin, httpPlugin({ port: 0 })] })`。
插件还支持 `requires`/`provides`（拓扑排序）、`config`（配置节）、`setup`/`onReady`/`onStopping`/`teardown`。

## `ctx` 扩展的两条纪律

1. **不能覆盖框架保留字段**：`ctx.extend({ requestId: 'x' })` 会**响亮报错**（不是静默获胜者通吃）；
2. `context` 钩子适合"每请求一样"的值（`ctx.log`）；"每请求不同"的值请放**中间件**里 extend ——
   `auth` 阶段设置、控制器读取，顺序由阶段保证。

## 用户自定义插件怎么自证合规

```ts
import { runWebPluginContract } from '@actor/web';

runWebPluginContract({ name: 'my-plugin', define: () => myPlugin });
```

检查：名字/阶段合法、路由带前缀且插件内不冲突、`context` 钩子注册成服务、
非法阶段与重复路由在**定义期**被拒、阶段排序（真实执行验证）。

完整可跑示例：[`examples/app-plugin`](../../examples/app-plugin/README.md)。

## 与"自装适配器"的关系

两个层次都是"扩展框架"，但场景不同：

| 想扩展 | 用什么 | 落点 |
|---|---|---|
| HTTP 行为（路由/中间件/请求上下文） | `defineWebPlugin()` | `@actor/web` |
| 一种"数据库"/中间件（连接与生命周期） | `defineResourceAdapter()` / `resourceAdapter()` | `@actor/resource` |
| 纯服务与生命周期（无 HTTP） | `definePlugin()` | `@actor/app` |
