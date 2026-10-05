# 最小应用示例（app-minimal）

演示 `@actor/app` 的三件事：**用户可配置**、**无侵入装配**、**生命周期**。
用户代码只依赖 `@actor/app`，看不到内核（`nodejs-actor-framework`）。

```
examples/app-minimal/
├── config/default.ts     # defineConfig：默认值 + 校验 + 类型
├── src/actors/counter.ts # 业务 Actor：普通类，无继承
├── src/module.ts         # defineModule：声明 actors / providers / 启停钩子
├── src/app.ts            # defineApp：把配置与模块组装成应用
└── main.ts               # 启动入口：createApp(app).start()
```

运行：

```bash
cd examples/app-minimal
node main.ts
# 可覆盖配置（camelCase → UPPER_SNAKE）：APP_STEP=5 APP_GREETING=hey node main.ts
```

边界由测试强制（`test/unit-app-boundary.test.js`）：本目录下任何文件出现
`nodejs-actor-framework` / `@actor/core` / `packages/core/src` 都会让测试失败。
