# app-db：把数据库接进应用（`@actor/db`）

演示：**一行接入数据库**（`databasePlugin`）+ 控制器只用 `ctx.get('notes')` + model 即建表 + 停机优雅关池。

```
examples/app-db/
├── config/default.ts       # 应用配置（数据库参数由插件的配置节 plugins.db.* 提供，不必写在这里）
├── src/models.ts           # model 层：字段/类型/约束/默认值/注释（用户写）
├── src/app.ts              # ★ 数据库只出现在这一行：databasePlugin({ models, repositories })
├── src/module.ts           # 模块里**没有任何数据库接线**，只声明路由
├── src/controllers.ts      # 控制器：只用 ctx.get('notes')，不关心方言
├── src/routes.ts           # 路由
└── main.ts                 # 启动入口（SIGTERM → 优雅停 → 插件关池）
```

## 跑起来

```bash
cd examples/app-db
node main.ts                     # 默认 sqlite（./data/app-db.sqlite）
curl -s localhost:PORT/health
curl -s -X POST localhost:PORT/api/notes -H 'content-type: application/json' -d '{"title":"第一条","tags":["a"]}'
```

端口传的是 0（临时端口），启动日志里会打印真实地址。

## 换 PostgreSQL / MySQL

```bash
npm i pg                          # 或 npm i mysql2
APP_PLUGINS__DB__URL='pgsql://user:pass@host:5432/appdb' node main.ts
```

只需要改配置：驱动是**懒加载**的（框架不引依赖），缺失时的报错会直接告诉你装什么。

## 这个示例里值得注意的点

- **乐观锁**：`PATCH /api/notes/:id` 可以带 `expectedVersion`，版本对不上返回 **409**（不是 500 —— 那是业务语义）。
- **优雅关池**：SIGTERM → 应用停机 → 插件的 `onStopping` → `db.close()`（等查询结束再释放）。
- **自动建表的边界**：示例开了 `autoMigrate: true`（方便本地跑）；生产建议关掉它、显式跑迁移。
  删列/改类型/加 `NOT NULL` 无默认值的列**永远不会自动做**。
