# 指南

面向**使用者**的文档（`docs/design/` 那些是设计/决策记录，给维护者看）。

## 30 分钟路线

| # | 指南 | 读完你会 |
|---|---|---|
| 0 | [从零生成一个能跑的项目](./00-scaffold.md) | 用脚手架生成 CRUD + Actor + 持久化 + 测试的骨架，并知道 CLI 的约定 |
| 1 | [第一个 Actor](./01-first-actor.md) | 起一个系统、spawn/ask/tell/stop，理解消息与状态 |
| 2 | [持久化与恢复](./02-persistence.md) | 快照与事件两种模式、怎么恢复、快照只是缓存 |
| 3 | [HTTP 应用（@actor/app + @actor/web）](./03-http-app.md) | 配置/模块/控制器/错误语义/优雅停止 |
| 4 | [数据层（@actor/data）](./04-data-layer.md) | 仓储、事件溯源聚合、投影、迁移、outbox |
| 5 | [集群](./05-cluster.md) | 发现、分片所有权、fencing、优雅交接 |
| 6 | [怎么测](./06-testing.md) | 用真内核跑测试、用虚拟时钟把"等一小时"变成 0 真实毫秒 |
| 7 | [可观测性](./07-observability.md) | span 生命周期与 OTLP 真实导出、日志适配、指标 |
| 8 | [数据库（@actor/db）](./08-database.md) | 连接池、model 声明与建表、乐观锁仓储、关联、用户可写的映射层 |
| 9 | [Redis（@actor/redis）](./09-redis.md) | 双驱动（redis / ioredis）、能力面与逃生通道、多实例、真库测试 |
| 10 | [MongoDB（@actor/mongodb）](./10-mongodb.md) | 连接与池映射、defineCollection（$jsonSchema/索引/sync 漂移）、诚实边界 |
| 11 | [迁移指南](../migration.md) | 从 v0.x 旧运行时迁过来要改什么、升级检查清单、兼容承诺的范围 |

## 这些示例**真的会跑**

带 `verify` 标记的代码块由 `test/unit-docs-guides.test.js` **逐个执行**：文档里的示例编译不过、
跑不通、断言失败，CI 就是红的。所以不会出现"文档写得很漂亮、照着做却跑不起来"。

写文档时给自己定两条规矩：

1. 示例要**自包含**（能独立运行，不依赖前后文），用 `node:assert` 自己断言；
2. 示例要**用真实 API**（不写"示意用的假函数"）——凡是示例里出现的名字，都必须是当前真实导出的。

> 内核包里 `packages/core/src` 是 CommonJS、其余三个包是 ESM；下面的示例统一用 ESM（`import`），
> 因为它们要引用 `@actor/*`。
