# app-multi-db：一个应用挂多个数据库（含**用户自装适配器**）

演示四件事：

1. **框架没定义的"数据库"也能被管住** —— `src/json-store-adapter.ts` 自己实现 `DatabaseAdapter`
   （JSON 文件存储，驱动就是 `node:fs`，**零 npm 依赖**）：连接、探活、保活、关闭、事件全接进框架；
2. **多实例、按 name 注册** —— `databaseAdapter(adapter, { name })`，客户端分别注册成
   `store` / `cache` / `queue` 服务，控制器用 `ctx.get('store')` 取；
3. **可选实例**：`cache`/`queue` 两个 Redis 只在配置了 URL 时才挂上（不配就不挂，不静默降级）；
4. **落盘与优雅停**：SIGTERM → 应用停机 → 各实例 `onStopping` → 自装适配器把数据落盘。

```
examples/app-multi-db/
├── src/json-store-adapter.ts   ★ 用户自装的适配器（框架未定义的那种库）
├── src/app.ts                  接线：三个实例 + 配置节 plugins.<name>.*
├── src/module.ts               模块里没有任何数据库接线
├── src/controllers.ts          控制器只用 ctx.get('store') / ctx.get('cache')
└── main.ts                     启动 + SIGTERM 优雅停
```

## 跑起来（离线可跑，不需要任何数据库）

```bash
cd examples/app-multi-db
APP_PLUGINS__STORE__URL='file:./data/store.json' node main.ts
```

```bash
curl -s localhost:PORT/health
curl -s -X POST localhost:PORT/notes -H 'content-type: application/json' -d '{"title":"第一条"}'
curl -s localhost:PORT/notes
```

## 再挂两个 Redis（可选）

```bash
npm i redis
APP_PLUGINS__STORE__URL='file:./data/store.json' \
APP_PLUGINS__CACHE__URL='redis://127.0.0.1:6379/0' \
APP_PLUGINS__QUEUE__URL='redis://127.0.0.1:6379/1' \
node main.ts
```

挂上 `cache` 之后，`GET /notes/:id` 会先读缓存（读穿），响应里带 `fromCache` 字段。

## 这个示例验证了什么

`test/unit-example-custom-adapter.test.js` 用**同一套**连接管理契约
（`runManagedConnectionContract`，来自 `@actor/db-core`）跑了这个自装适配器 ——
也就是说：**使用者可以拿框架发布的契约套件给自己的适配器自证合规**。
