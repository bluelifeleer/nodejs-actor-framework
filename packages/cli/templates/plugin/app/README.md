# __PLUGIN_NAME__

`@actor/app` 的**应用插件**骨架（`actor new plugin __PLUGIN_NAME__ --kind app` 生成）。

它展示一个应用插件的三个要点：

1. **配置节**：`config` 里的字段会并进应用配置的 `plugins.__PLUGIN_NAME__.*`，
   所以它和普通配置走**同一套**加载、环境变量映射（`APP_PLUGINS____PLUGIN_NAME__…`）与校验；
2. **生命周期**：`setup`（provider 解析之前）→ `onReady`（Actor 已 spawn、模块 onStart 已完成）
   → `onStopping`（先停收）→ `teardown`（兜底释放），四步的时机与顺序由框架保证；
3. **服务**：`app.provide(name, value)` 注册，控制器里 `ctx.get(name)` 取用。

## 跑起来

```bash
npm test        # 自带契约/行为测试（无需任何外部服务）
```

## 接到应用里

```ts
import { createApp, defineApp, defineModule } from '@actor/app';
import plugin from '__PLUGIN_NAME__';

const app = createApp(
  defineApp({
    config: defineConfig({ /* … */ }),
    modules: [defineModule({ name: 'main' })],
    plugins: [plugin({ /* 也可以在代码里给选项 */ })],
  }),
);
await app.start();
```

配置项用**全量写法**（`{ type, default }`）或**简写**（值即 schema，M9f）都行：

```ts
defineConfig({ plugins: { __PLUGIN_NAME__: { greeting: 'hello' } } })
```
