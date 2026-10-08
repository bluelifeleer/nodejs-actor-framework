# 旧指南（按里程碑顺序）

这一组是**框架开发过程里写的指南**，按里程碑顺序排列（M0 → M9），
偏"当初为什么这么设计、实测踩了什么坑"。

**使用者请先看[主线文档](../README.md)** —— 那里按"你要干什么"组织，更短、更直接。
这里保留着是因为：早期教程里有不少**设计意图与实现细节**的说明（例如"为什么路由用游标不用 offset"、
"经典 class 形态的 Actor 为什么不能开快照"），查根因时有用。

| # | 主题 | 什么时候值得翻 |
|---|---|---|
| 0 | [从零生成一个项目](./00-scaffold.md) | 想知道脚手架每个文件的来历与 CLI 全部约定 |
| 1 | [第一个 Actor](./01-first-actor.md) | 想从内核视角理解消息/状态/监督 |
| 2 | [持久化与恢复](./02-persistence.md) | 快照 vs 事件的取舍、class 形态的限制 |
| 3 | [HTTP 应用（@actor/app + @actor/web）](./03-http-app.md) | 装配/模块/错误语义的完整脉络 |
| 4 | [数据层（@actor/data）](./04-data-layer.md) | 仓储、事件溯源聚合、投影、outbox |
| 5 | [集群](./05-cluster.md) | 发现、分片所有权、fencing、优雅交接 |
| 6 | [怎么测](./06-testing.md) | 真内核测试与虚拟时钟的原理 |
| 7 | [可观测性（span/OTLP）](./07-observability.md) | span 生命周期、真实导出 |
| 8 | [数据库（@actor/db）](./08-database.md) | 连接池、model 声明、乐观锁仓储、关联 |
| 9 | [Redis（@actor/redis）](./09-redis.md) | 双驱动、能力面、多实例 |
| 10 | [MongoDB（@actor/mongodb）](./10-mongodb.md) | $jsonSchema、索引、sync 漂移 |
| 11 | [自装适配器 / 受管资源](./11-custom-adapter.md) | defineDatabaseAdapter、契约套件 |
| 12 | [Web 插件](./12-web-plugin.md) | defineWebPlugin：路由/阶段中间件/上下文扩展 |
| 13 | [文件上传](./13-upload.md) | 流式/分片/断点续传的实现视角 |
| 14 | [鉴权与 JWT](./14-auth.md) | 算法白名单、refresh、角色模型 |
| 15 | [日志与诊断](./15-observability.md) | 脱敏、采样、`/__debug` 三层门禁 |
| 16 | [邮件（@actor/mail）](./16-mail.md) | MIME 渲染、transport 契约 |
| 17 | [应用层语法糖（设计对照）](./17-app-sugar.md) | 短名/简写/工厂/保留名的设计记录；**使用者请看主线的 [09 应用层语法糖](../09-app-sugar.md)** |

> 这些页面的相对链接已经按新位置修正；里面的示例同样由 `test/unit-docs-guides.test.js` **真执行**。
