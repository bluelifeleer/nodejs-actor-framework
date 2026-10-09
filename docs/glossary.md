# 术语表

这一页是**查词**用的：每个术语一句话说清，并给出该看哪一页。

> 主线页面里**首次出现**的术语会自动链到这里（只链第一次，不打扰阅读）。
> 想补术语：改这一页的 `### 术语` 段落 + `docs/glossary.json`，门禁会核对两者一致。

### Actor

一个**私有状态 + 串行邮箱 + 明确失败归属**的计算单元：状态只有它能改，消息一条条处理，崩了由监督者决定命运。
**详见**：[00 什么是 Actor](./guide/00-what-is-an-actor.md)

### 邮箱

每个 Actor 一条 FIFO 队列，消息按到达顺序**串行**处理（这是"不用锁"的来源）。满了有三选一语义：
`reject` / `drop-oldest` / `drop-newest`，且每次都留痕。
**详见**：[12 Actor 与状态](./guide/12-actors-state.md)

### tell

**发后不理**：不分配 reply、不设定时器，失败不会回到你手上（消息进死信）。
**详见**：[00 什么是 Actor §3](./guide/00-what-is-an-actor.md#3-消息只有两种语义差别很大)

### ask

**请求-响应**：有超时、有真实错误（handler 抛什么就抛什么）；超时映射成 HTTP 504。
**详见**：[00 什么是 Actor §3](./guide/00-what-is-an-actor.md#3-消息只有两种语义差别很大)

### 监督者

父 Actor 就是子 Actor 的监督者；顶层由系统监督。它决定子 Actor 崩溃后的命运（重启 / 升级 / 停）。
**详见**：[00 什么是 Actor §5](./guide/00-what-is-an-actor.md#5-失败为什么重启出干净实例比catch-住继续更可靠)

### 重启强度

"在 N 秒内最多重启 M 次"的配额（`maxRestarts` / `withinSeconds`）。用尽就**升级**。
**详见**：[internals/01 第一个 Actor](./guide/internals/01-first-actor.md)

### 升级

子 Actor 超出重启强度后，故障**向上传递**给祖父决定；一路到顶层就是 `system_failure` + 如实停机。
**详见**：[internals/05 集群与运维](./guide/internals/05-cluster.md)

### 死信

没能送达、或被丢弃的消息记录（内存环 + 可选落盘）。`tell` 的失败只能从这里对账。
**详见**：[20 错误与日志](./guide/20-errors-and-logging.md)

### 背压

邮箱满时的行为约定（拒绝或丢弃，并计数/记事件）—— 让"快生产者压垮慢消费者"变成**显式选择**而不是静默丢弃。
**详见**：[12 Actor 与状态](./guide/12-actors-state.md)

### 快照

`persistence: { mode: 'snapshot' }`：定期把 `this.state` 整体存下来，恢复时读回。适合状态小、恢复快的场景。
**详见**：[12 Actor 与状态 §4](./guide/12-actors-state.md#4-持久化两种模式)

### 事件日志

`persistence: { mode: 'events' }`：状态由**事件重放**得出（配合 `@actor/data` 的事件溯源），可审计、可重放。
**详见**：[11 数据与 CRUD](./guide/11-crud-database.md)

### 投递保证

本框架的承诺是 **at-most-once + 死信可见**：不假装"精确一次"（那需要业务幂等）。跨节点同理。
**详见**：[00 什么是 Actor §3](./guide/00-what-is-an-actor.md#3-消息只有两种语义差别很大)

### Actor 路径

Actor 的**唯一地址**（如 `arena/alice`、`player_001/pet-1`），也是集群里跨节点的寻址方式。
**详见**：[internals/05 集群与运维](./guide/internals/05-cluster.md)

### ctx

请求或消息的上下文：请求侧有 `ctx.actor` / `ctx.get` / `ctx.state` / `ctx.log`；Actor 侧有 `ctx.self` / `ctx.spawn` 等。
**详见**：[10 路由与请求](./guide/10-http-routing.md)

### provider

模块里声明的**依赖工厂**（`providers: { notes: (deps) => … }`），按依赖图解析；缺依赖在**启动期**报错。
**详见**：[02 项目结构](./guide/02-project-layout.md)

### 模块

`defineModule({ name, providers, actors, routes })`：**显式**装配的一块拼图，挂进应用（不自动扫描目录）。
**详见**：[03 推荐写法与约定](./guide/03-recommended-style.md)

### 插件

能力包（`httpPlugin` / `authPlugin` / `dbPlugin` …）。**显式启用**：不装就没有这个能力。
**详见**：[internals/12 Web 插件](./guide/internals/12-web-plugin.md)

### 保留名

框架自己占的名字与路由前缀（`config`、`log`、`httpServer`、`/uploads`、`/__debug` …）：撞了在装配期报错。
**详见**：[internals/17 应用层语法糖 §6](./guide/internals/17-app-sugar.md)

### 乐观锁

"更新时带上期望版本，版本不符就拒绝"（`expectedVersion` → 409），用来防并发覆盖。
**详见**：[11 数据与 CRUD](./guide/11-crud-database.md)

### 迁移

数据库结构变更（`src/migrations.ts` + `actor migrate up/down`）：有版本表、幂等、可回滚、中断可重入。
**详见**：[11 数据与 CRUD](./guide/11-crud-database.md)

### 虚拟时钟

`@actor/testkit` 的 `createVirtualClock`：把"等一小时"变成 0 真实毫秒，定时器逻辑照样被测。
**详见**：[17 测试](./guide/17-testing.md)

### 受管资源

需要连接/健康检查/保活/优雅关闭的外部依赖（数据库、Redis、邮件）的统一抽象。
**详见**：[internals/11 自装适配器](./guide/internals/11-custom-adapter.md)
