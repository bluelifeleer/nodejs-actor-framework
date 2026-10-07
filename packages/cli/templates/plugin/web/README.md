# __PLUGIN_NAME__

一个 **web 插件**（贡献路由 + 带阶段中间件 + 请求上下文扩展）。

```bash
npm install
npm test        # 跑框架**已发布**的 web 插件契约套件，自证合规
```

装到应用里：

```ts
import plugin from '__PLUGIN_NAME__';

defineApp({ modules, plugins: [plugin, httpPlugin({ port: 3000 })] });
```

契约套件检查：名字/阶段合法、路由带前缀且插件内不冲突、`context` 钩子注册成服务、
非法阶段与重复路由在**定义期**被拒、阶段排序（真实执行验证）。
