# 最小应用示例（app-minimal）

演示 `@actor/app` 的三件事：**用户可配置**、**无侵入装配**、**生命周期**。
用户代码只依赖 `@actor/app`，看不到内核（`nodejs-actor-framework`）。

```
examples/app-minimal/
├── config/default.ts     # defineConfig：默认值 + 校验 + 类型
├── src/actors/counter.ts # 业务 Actor：普通类，无继承
├── src/module.ts         # defineModule：声明 actors / providers / 启停钩子
├── src/plugins/audit.ts  # definePlugin：用户自定义插件（自己的配置 schema）
├── src/app.ts            # defineApp：把配置与模块组装成应用
└── main.ts               # 启动入口：createApp(app).start()
```

运行：

```bash
cd examples/app-minimal
node main.ts
# 可覆盖配置（camelCase → UPPER_SNAKE）：APP_STEP=5 APP_GREETING=hey node main.ts
# 插件配置走同一套机制：APP_PLUGINS__AUDIT__LEVEL=warn node main.ts
```

边界由测试强制（`test/unit-app-boundary.test.js`）：本目录下任何文件出现
`nodejs-actor-framework` / `@actor/core` / `packages/core/src` 都会让测试失败。

## 插件

`src/plugins/audit.ts` 是**用户自定义插件**，和内置能力（`metricsPlugin()` 等）走同一条路：

```ts
export const auditPlugin = definePlugin({
  name: 'audit',
  config: { level: { type: 'string', default: 'info', enum: ['info', 'warn'] } },
  setup(app, config) { /* 在 provider 解析与 Actor spawn 之前 */ },
  teardown(app) { /* 在模块 onStop 与内核停止之后 */ },
});
```

在 `src/app.ts` 里显式启用：`plugins: [auditPlugin, metricsPlugin()]`。
没声明的能力不会挂上——这也是内核加载面可控的原因。
