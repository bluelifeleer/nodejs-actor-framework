# __PROJECT_NAME__

用 actor 框架生成的骨架：**CRUD（仓储）+ Actor（持久化）+ 真 HTTP 测试**。

## 跑起来

```bash
npm install
npm start                 # 默认 http://127.0.0.1:3000；换端口用 APP_PLUGINS__HTTP__PORT=8080
npm test                  # 端到端测试（真 HTTP，随机端口）
```

数据写在 `./data`（`APP_DATA_DIR` 可覆盖）。端口是**插件**配置，所以用 `APP_PLUGINS__HTTP__PORT`。

## 有什么

| 路径 | 走哪一层 | 说明 |
|---|---|---|
| `POST /notes`、`GET /notes?limit=&cursor=`、`PATCH /notes/:id`、`DELETE /notes/:id` | **仓储**（文件适配器） | 列表用游标分页；`PATCH` 带 `expectedVersion`，版本过旧返回 **409** |
| `POST /counter/add`、`GET /counter` | **Actor**（`mode: 'snapshot'`） | 有状态、串行、状态会落盘；进程重启后接着数 |
| `GET /health` | 函数式控制器 | 最简形态 |

```
config/default.ts   配置 = 默认值 + 校验（环境变量 APP_* 覆盖）
main.ts             启动入口：SIGTERM/SIGINT 优雅停止
src/app.ts          defineApp：配置 / 模块 / 插件
src/module.ts       defineModule：providers（仓储）+ actors + routes
src/notes.ts        控制器：CRUD + 乐观锁
src/counter.ts      Actor：写路径在这里
test/app.test.ts    端到端测试
```

## 下一步

- **换存储**：`module.ts` 里把 `createFileRepository` 换成 `createSqlRepository`（提供 SQL runner），
  或换成 `@actor/data` 的其它适配器。
- **事件溯源**：把 Actor 换成 `defineAggregate(...)` + `mode: 'events'`（见文档站的"数据层"指南）。
- **结构演进**：`@actor/data` 有迁移框架（版本表 + 默认拒绝启动），CLI 的 `actor migrate` 是后续计划。
- **集群**：装 `clusterPlugin()`（`@actor/app`），按名字跨节点调用；交接要求存储共享。

文档站：在框架仓库里跑 `npm run docs:serve` 看"指南"分组。
