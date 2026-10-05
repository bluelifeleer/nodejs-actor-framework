# app-data：数据层示例（CRUD 仓储 + 事件溯源聚合 + 投影读模型 + 迁移门）

只用 `@actor/app` + `@actor/web` + `@actor/data`（**不接触内核**）。它演示 doc 04 的四个卖点，
而且四个都在 `test/integration-example-app-data.test.js` 里被真实跑过（真子进程、真文件、真 HTTP）。

## 跑起来

```bash
cd examples/app-data
APP_MIGRATE=1 APP_PLUGINS__HTTP__PORT=9000 node main.ts   # 第一次：显式应用迁移
APP_PLUGINS__HTTP__PORT=9000 node main.ts                 # 之后：直接起（迁移已记录）
```

数据目录由 `APP_DATA_DIR` 决定（默认 `./data`）。**注意**：`config/default.ts` 的默认值与
`src/paths.ts` 同源，避免"配置说一个目录、内核写另一个"。

## 四条路径

| 路径 | 走哪一层 | 为什么 |
|---|---|---|
| `POST /notes`、`GET /notes?limit=&cursor=`、`GET/PATCH/DELETE /notes/:id` | **仓储**（file 适配器） | 单实体读写与列表查询；列表用**游标**分页（并发写入下不漏不重） |
| `PATCH /notes/:id` 带 `expectedVersion` | 仓储的乐观锁 | 版本对不上返回 **409**（不是 500：这是业务语义） |
| `POST /orders/:id/items`、`POST /orders/:id/confirm` | **Actor**（事件溯源聚合） | 写路径串行、有状态、可事件溯源；命令只产出事件，状态由 `applyEvent` 推导 |
| `GET /orders/:id/summary` | **投影**（读模型） | 读路径可扩展、可重建；最终一致，追不上时返回 202 |

**刻意没有**"读聚合状态"的接口：那会教出反模式（doc 04 §1 的分工原则）。命令的返回值里已经
能看到新状态。

## 值得注意的三处细节

1. **迁移门**：`main.ts` 在 `start()` 之前跑 `assertApplied()`——有未应用迁移就**拒绝启动**。
   集成测试专门验了这条：没有 `APP_MIGRATE=1` 时进程非零退出且**不会开始监听**。
   迁移本身是幂等的（`src/migrations.ts` 里的 v2 会按实体文件重建 notes 索引）。
2. **快照只是缓存**：聚合配了 `snapshot: { every: 5 }`；恢复时先读快照再只重放增量，
   快照结构对不上就丢弃并从事件重建（日志才是真相）。
3. **事件日志的读取权在内核**：投影要读日志，示例用应用层的逃生通道 `app.kernel.persistenceStore`
   拿 store（见 `src/module.ts` 的 `onStart`）。这是**应用层唯一需要碰内核的地方**，注释里写明了；
   它也是把"数据层"接进来的最小代价。

## 文件

```
main.ts              启动：迁移门 → start() → 打印端口；SIGTERM 优雅停止
config/default.ts    配置（dataDir 与 paths.ts 同源）
src/paths.ts         数据目录的唯一定义（APP_DATA_DIR）
src/order.ts         事件溯源聚合 + 投影（读模型）
src/migrations.ts    两个示例迁移（建目录、重建仓储索引）
src/controllers.ts   CRUD 控制器（仓储）+ 聚合命令控制器 + 读模型控制器
src/routes.ts        路由表
src/module.ts        模块：provider（仓储）+ actor（聚合）+ onStart/onStop（投影生命周期）
```
