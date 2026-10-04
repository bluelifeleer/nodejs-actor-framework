# Actor 内核：独立可用性与待补原语（设计草案）

> 对应开放问题 Q1/Q2；是"全 Web 框架但 Actor 能单独使用"这条约束的技术落点。

## 1. 什么叫"能单独使用"

三条可验证的标准（缺一条就退化）：

| 标准 | 现状 | 差距 |
|---|---|---|
| S1 **安装独立**：`npm i @actor/core` 不会带进 HTTP/数据层依赖 | ⚠️ 现在是单包，`package.json` 的 `files` 含 examples/plugins | 需要按方案 A 拆包，或至少把 web/data 放进独立包 |
| S2 **加载独立**：`require('@actor/core')` 只拉起内核 | ❌ **实测：`require('index.js')` 连带加载 32 个模块**，其中 7 个是插件文件，还包含 gossip/TLS/网关全套（`src/cluster/*`）、指标导出器（`src/obs/*`）、存储后端（`src/store/*`）——因为 `index.js:35` 直接 `require('./plugins')` | 公共面必须瘦身：`index.js` 只导出内核；插件与传输走 `@actor/core/plugins`、`@actor/core/cluster` 按需加载。验收方式：加一条「只 require 内核时加载模块数不超过 N」的测试 |
| S3 **依赖独立**：`dependencies` 为空，且无 node_modules 时单测全绿 | ✅ 已具备（`classic-level` 是 optional；移除 node_modules 后实测 274 跑 / **265 pass / 0 fail / 9 skip**，跳过的都是 level 后端用例） | 拆包后要保持这条，并进 CI |

> **S2 是当前最实的缺口**：内核入口把插件一起加载了。这既是"独立可用"的问题，也是启动开销与可选依赖的问题。修它不需要改语义，只需要调整导出面（属于 M0）。

## 2. 内核现状 vs 目标

| 能力 | 现状 | 目标 |
|---|---|---|
| Actor 语义（串行、邮箱、背压） | ✅ | 保持 |
| 监督树（3 策略 + 强度 + 升级） | ✅ | 保持；补**自定义策略**插槽 |
| 失败语义（crash / retry + 死信） | ✅ | 补**消息校验失败**的独立归类 |
| 持久化（none/snapshot/events/mailbox） | ✅ | 补 **schema 版本与 upcast**（见 doc 04） |
| 隔离（inline / worker） | ✅ | 保持；补**自定义隔离**插槽（远期） |
| 传输（帧 + mTLS）与集群发现 | ✅ | 保持；分片治理见 doc 05 |
| **定时器 / 自调度** | ❌ 无 | `ctx.schedule` / `scheduleEvery`，随 Actor 停止自动清理，可虚拟时钟测试 |
| **FSM（become/unbecome）** | ❌ 无 | 行为栈 + 状态声明，非法转移报错 |
| **stash / unstash** | ❌ 无 | 有界暂存，溢出进死信 |
| **receiveTimeout（空闲超时）** | ❌ 无 | 空闲 N 毫秒后投递一条超时消息 |
| **消息级中间件** | ❌ 无 | `system.use` + 按 Actor 挂载；校验/鉴权/审计/指标 |
| **消息 schema 校验** | ❌ 无 | 定义里声明 schema，非法消息 → 死信（不崩 Actor） |
| **可换调度器 / 邮箱 / 监督策略** | ❌ 写死（`new InlineScheduler` / `new Mailbox`） | 构造参数可换，默认实现不变 |
| **ctx 扩展** | ❌ 无 | `ctx.get(name)` 取容器服务 + 允许插件挂 `ctx` 属性 |
| Actor 依赖获取 | ⚠️ 只能靠闭包或全局 | 由容器解析（见 doc 02） |

## 3. 待补原语：API 草案与取舍

以下都是**设计草案**，用于评审；实现顺序建议按编号。

### 3.1 定时器（优先级最高）

```js
class Room extends Actor {
  preStart(ctx) {
    this.ticker = ctx.scheduleEvery(1000, { type: 'tick' });   // 返回句柄
  }
  postStop() {
    this.ticker.cancel();          // 可选：停止时框架也会自动取消
  }
  async receive(msg, ctx) {
    if (msg.type === 'tick') return this.onTick(ctx);
    if (msg.type === 'startBomb') {
      this.bomb = ctx.schedule(5000, { type: 'explode' });     // 一次性
      return 'armed';
    }
  }
}
```

**为什么需要**：现在所有周期逻辑都在 Actor 世界外用 `setInterval` 驱动（`examples/game-server.js`、`game-cluster.js` 都是），用户每人都要自己写一套，且容易泄漏、乱序、忘记在停止时清理。

**落地要点**：
- 定时器由**调度器**统一管理（`Scheduler` 增加 timer 轮），不是每个 Actor 一个 `setTimeout`——否则 1 万个 Actor 就是 1 万个定时器。
- 定时消息**走邮箱**（与普通消息同序、受背压与限流约束），但标记为 `system` 优先级，避免被业务消息饿死。
- Actor 停止 / 重启 / 崩溃时自动取消该 Actor 的所有定时器（防泄漏），重启后不自动重排（除非显式持久化定时器）。
- 句柄 `{ cancel(), deadline, isActive }`；取消后再触发是 no-op。
- **虚拟时钟**：调度器的时钟可注入（`createSystem({ clock })`），TestKit 用它把"等 1 小时"变成"推进 1 小时"。这是定时器能被测试的前提，必须一起做。
- 上限：单 Actor 定时器数量上限（默认 1000），超限报错而非静默丢弃。
- **持久化定时器**（远期，可选）：OTP 的 `PersistentTimer` 语义——定时器作为事件写入，重启后重新武装。需要处理"停机期间到期"的补投策略，先不做，文档写明。

**验收**：定时消息按序到达；Actor 崩溃重启后旧定时器不再触发；虚拟时钟下测试无 sleep；1 万 Actor × 1 定时器不会创建 1 万个 Node 定时器（用调度器轮实现）。

### 3.2 FSM（become/unbecome）

```js
class Door extends Actor {
  preStart(ctx) {
    this.fsm = ctx.stateMachine({
      initial: 'closed',
      states: {
        closed: { open: 'opened', break: 'broken' },
        opened: { close: 'closed', break: 'broken' },
        broken: {},                                  // 终态
      },
      // 未定义转移 = 不处理：按 onUnexpected 策略
      onUnexpected: 'stash',                         // 'stash' | 'deadLetter' | 'error'
    });
  }
  async receive(msg, ctx) {
    switch (this.fsm.state) {
      case 'closed': /* ... */ break;
    }
    this.fsm.transition(msg.type);                   // 非法转移抛 DefinitionError
  }
}
```

**取舍**：两种风格——(a) 显式状态机对象（上图，可校验转移、可导出状态图）；(b) OTP 式 `become(handler)` 行为栈（灵活但不可静态分析）。建议 **(a) 为主，保留 `become` 作为低层 API**，因为可校验/可观测对团队更重要（`inspect()` 能报当前状态）。

### 3.3 stash / unstash

```js
if (!this.ready) { ctx.stash(); return; }   // 暂存当前消息
// ... 某条件满足后
ctx.unstashAll();                            // 按原顺序重新入队（在队首，保持相对顺序）
```
**要点**：有界（默认 1000，可配），溢出 → 死信并计数；`unstashAll` 插回**队首**且保持原顺序；重启清空；`inspect()` 暴露 stash 深度。

### 3.4 receiveTimeout（空闲超时）

```js
ctx.setReceiveTimeout(30_000);   // 30s 内没有消息就投递 { type: 'receiveTimeout' }
```
**用途**：会话过期、连接保活、临时状态回收（比外部定时器省事，且随消息自动重置）。
**要点**：只在"邮箱为空"时计时；收到任何消息重置；`setReceiveTimeout(0)` 关闭。

### 3.5 消息校验

```js
// 定义里声明，非法消息不崩 Actor
system.spawn({
  schema: {
    hurt: { damage: { type: 'number', min: 0, max: 1000 } },
  },
  receive(msg, ctx) { /* 到这里 msg 一定合法 */ },
}, { id: 'player-1' });
```
**要点**：校验失败 → **死信**（`reason: 'schema'`）+ 计数器，不触发 crash/重启（这是与"handler 抛错"不同的归类，便于运维区分"非法输入"和"代码 bug"）；schema 适配器接口（内置极简 + zod/ajv 适配，见 doc 03）；生产建议默认对**外部入口消息**开启。

### 3.6 消息级中间件

```js
// 全局：按注册顺序组成链，next() 前=入、后=出
system.use(async (msg, ctx, next) => {
  const started = Date.now();
  try { return await next(); }
  finally { metrics.observe(ctx.path, Date.now() - started); }
});

// 按 Actor 挂载
system.spawn(Player, { id: 'player-1', middleware: [authorize, auditLog] });
```
**要点**：
- `next()` 返回 handler 的返回值（`ask` 的响应要能穿过中间件链）。
- 语义分两类，必须区分：**改造型**（校验、解包）与**观察型**（日志、指标）。观察型抛错不应改变业务语义（框架吞掉并记日志）。
- 顺序：全局（注册序）→ 定义（数组序）→ handler。
- 中间件**不参与** ask 的超时语义（超时以最外层 `ask` 计时为准）。
- 与插件的关系：插件可注册全局中间件（如 tracing 注入 span、metrics 计时），这是插件 SDK 的扩展点之一。

### 3.7 可换实现（扩展插槽）

```js
createSystem({
  clock: virtualClock,                  // 测试用
  scheduler: myScheduler,               // 必须是 { schedule(cell), drain(ms), stop() }
  mailbox: (options) => myMailbox,      // 默认 lib/actor/mailbox.js
  supervisionStrategy: myStrategy,      // 扩展点：策略注册表
  persistence: adapter,                 // ✅ 已支持
});
```
**建议**：定义**最小接口契约**并写进类型（而不是暴露内部类），避免用户实现被内部重构打断。监督策略做成**注册表**（`registerSupervisionStrategy('my_strategy', fn)`），而不是新增构造函数参数——策略是可组合的小逻辑。

## 4. 兼容性与实施注意

- 以上全部是**新增能力**，不改现有语义（`receive`、监督、持久化行为不变）；定时器/中间件/校验都是可选开关。
- `ctx` 现在是一个普通对象（`src/actor/actor-context.js`）。新增方法不破坏现有代码；但**不要**让用户随意往 `ctx` 上写属性（并发消息间会串），要扩展就通过 `ctx.get(name)` 拿服务。
- 中间件会进入每消息热路径：必须做**零中间件时的快路径**（没有中间件/定时器/校验时，路径与现在一致），并用现有的规模测试（1 万 Actor、fan-out ask）守住性能不回归。
- 定时器+虚拟时钟+TestKit 建议同期落地（3.1 与 doc 05 的 TestKit 互相依赖）。

## 5. 本节待决策

| # | 问题 | 建议 |
|---|---|---|
| A1 | 定时器是否需要持久化（重启后重新武装） | 先不做，文档标注为远期 |
| A2 | FSM 主线用"显式状态机"还是"become 行为栈" | 显式状态机为主，become 作为低层 API |
| A3 | 消息校验默认开还是默认关 | 默认关；外部入口（HTTP/WS/集群帧）建议默认开 |
| A4 | 中间件是"只看不改"还是允许短路 | 允许短路（校验/鉴权需要），但要求返回结构化错误 |
| A5 | 调度器/邮箱是否对外承诺稳定接口 | 承诺"最小契约"，不承诺内部类 |
