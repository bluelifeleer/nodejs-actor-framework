# M0.3/M0.4 中间件、扩展插槽、公共面与运维骨架（设计草案）

## 1. 消息中间件（M0.3）

### 1.1 签名

```ts
export type MessageMiddleware = (
  msg: unknown,
  ctx: ActorContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export interface ActorOptions {
  /** 该 Actor 专属中间件，按数组顺序执行 */
  middleware?: MessageMiddleware[];
}

export interface ActorSystem {
  /** 全局中间件，按注册顺序执行；返回取消注册函数 */
  use(middleware: MessageMiddleware): () => void;
}
```

### 1.2 语义与边界

| 项 | 设计 |
|---|---|
| 执行顺序 | 全局（注册序）→ Actor 专属（数组序）→ **校验中间件** → `receive` |
| `next()` 返回值 | 必须是 handler 的返回值，`ask` 的响应要能穿过整条链 |
| 短路 | 允许（校验/鉴权需要）：不调 `next()` 直接返回或抛错；返回 `undefined` ≠ 短路（需要短路就抛错或返回结构化错误） |
| 错误传播 | 中间件抛错 = 该消息失败 → 走现有失败路径（crash/retry 取决于 Actor 配置）。**观察型中间件**（日志/指标）必须自己 try/catch，框架不替它兜（文档明确写进指南并提供 `observed()` 包装器） |
| ask 超时 | 以最外层 `ask` 计时为准，中间件不得延长（避免叠加超时） |
| 零中间件快路径 | 未注册任何中间件时，**完全不构造链、不分配闭包**（用 `if (middlewares.length === 0)` 分支），保证现状性能 |
| 与校验的关系 | 消息 schema 校验（M0.2 §5）实现为**内置中间件**，位置固定在用户中间件之后（用户校验/解包先跑，schema 兜底契约） |
| 与 worker 的关系 | 中间件在主线程执行（消息跨线程前），worker 内的 `receive` 只看到合法消息 |
| 性能预算 | 3 个空直通中间件时，单消息开销增幅 < 15%（基准测试守住） |

### 1.3 测试计划

| 用例 | 断言 |
|---|---|
| 顺序 | 全局与外层/内层顺序符合定义（用数组记录调用序） |
| ask 穿透 | 中间件返回值/`next()` 链路能把 handler 的返回值交给 `ask` 调用方 |
| 短路 | 中间件不调 next → handler 未被调用，调用方收到中间件给的错误 |
| 抛错 → 失败路径 | 中间件抛错时按 Actor 失败语义处理（crash 有重启 / retry 有退避） |
| 观察型不改变语义 | `observed()` 包装器内的日志抛错不影响业务结果（框架吞掉并计数） |
| 取消注册 | `use()` 返回的函数调用后该中间件不再执行 |
| 零中间件快路径 | 与现状对比基准无回归（阈值内） |
| 与超时 | 中间件耗时 + handler 耗时超过 `ask` 超时 → 调用方按超时失败，且只有一次超时定时器 |

---

## 2. 扩展插槽（M0.3）

### 2.1 签名（最小契约，不暴露内部类）

```ts
export interface SchedulerContract {
  schedule(cell: unknown): void;
  drain(timeoutMs: number): Promise<{ drained: boolean; timedOut: boolean }>;
  stop(): void;
  /** 定时器支持（M0.2 起为必需） */
  setTimer(dueAt: number, fn: () => void): TimerId;
  clearTimer(id: TimerId): void;
}

export interface MailboxContract {
  size: number;
  push(envelope: unknown): boolean;
  shift(): unknown | undefined;
  clear(): void;
}

export interface SupervisorStrategy {
  decide(crashedId: string, ctx: { strategy: string; children: string[] }): {
    action: 'restart' | 'escalate' | 'none';
    targets: string[];
  };
}

export interface SystemOptions {
  scheduler?: SchedulerContract;
  mailbox?: (options: { maxSize: number; overflow: string }) => MailboxContract;
  clock?: Clock;                                   // M0.2 §0
  supervisionStrategy?: SupervisorStrategy;        // 覆盖内置策略
}
```
另提供注册表：`registerSupervisionStrategy(name, fn)`，让"自定义策略"能像内置三种一样用名字声明。

### 2.2 边界与测试计划

| 项 | 设计/断言 |
|---|---|
| 稳定性承诺 | 只承诺**最小契约**（方法集合与语义），不承诺内部类结构；契约写进 `.d.ts` 并有**契约测试**（内置实现必须通过同一套测试） |
| 自定义调度器 | 用一个"逆序/单步"调度器（测试用）验证：消息顺序可控、`drain` 语义正确、`stop` 幂等 |
| 自定义邮箱 | 用"优先级邮箱"验证：背压计数、`push` 返回值语义、与系统消息（stop/timer）共存 |
| 自定义时钟 | 虚拟时钟（M0.2）本身即第一个消费者 |
| 自定义监督策略 | 用一个"偶数次崩溃不重启"的策略验证 `decide` 的三态与升级路径 |
| 契约测试复用 | 同一份契约测试同时跑内置实现与一个"最小实现" |

---

## 3. ctx 服务访问（M0.3）

```ts
export interface ActorContext {
  /** 从容器取服务；未注册 → 抛 ServiceNotFoundError（含可用服务名列表） */
  get<T = unknown>(name: string): T;
  has(name: string): boolean;
}
```
- **禁止**往 `ctx` 上直接写属性（并发消息间会串）；需要扩展就走 `ctx.get()`（容器见 doc 02）。
- M0 只提供 `get/has` 接**已有的 system 服务**（`system.cluster` 等），完整容器在 M1。
- 测试：未知服务报错信息含可用名；`has` 不抛错；worker Actor 里 `ctx.get` 只能取到**可序列化**服务（取到不可序列化对象 → 明确报错而不是丢进线程）。

---

## 4. 公共面瘦身（M0.4，**breaking**）

### 4.1 现状（实测）

```
require('index.js') → 连带加载 32 个模块
  lib/actor 11 · lib/cluster 6 · lib/store 3 · lib/obs 3 · plugins 7 · root 2
原因：index.js:35 直接 require('./plugins')
```

### 4.2 目标

```
@actor/core                     → 只导出内核（Actor/defineActor/createSystem/ActorRef/错误/策略）
@actor/core/ops                 → Telnet 控制台、WS/Token（可选）
@actor/core/obs                 → 指标/日志/告警（可选）
@actor/plugin-cluster           → cluster 插件（独立包）
@actor/plugin-observability     → metrics/tracing/deadLetters/rateLimit
```
**验收**：`require('@actor/core')` 后 `require.cache` 中新模块数 **≤ 15**（写一条加载面测试）。

### 4.3 兼容期方案

| 阶段 | `require('pkg').plugins` | 说明 |
|---|---|---|
| 兼容期（一个 minor） | 仍可用，但**首次访问时打印一次弃用警告**（含替代路径） | 不破坏现有使用者（含本仓库 examples/tests） |
| 下个 major | 移除；迁移指南 + codemod | — |

**同时必须做的**：把 examples、tests、README 全部改成新路径，这样兼容期只是给外部使用者留时间，不是给我们自己留后路。

### 4.4 测试计划

| 用例 | 断言 |
|---|---|
| 加载面 | 只 require core 时模块数 ≤ 15；且 `require.cache` 里没有 `plugins/**`、`src/cluster/**`、`src/obs/**` |
| 弃用警告 | 兼容期访问 `.plugins` 时恰好一条警告（不是每条消息一条） |
| 子路径可用 | `@actor/core/ops`、`@actor/core/obs` 能单独 require（各自加载面也有上限） |
| 零依赖保持 | 无 node_modules 时 core 的单测全绿（除 level 用例） |
| 独立可用端到端 | 临时工程只装 core → 写一个纯 Actor 示例（spawn/ask/持久化/监督）跑通，**不含任何 Web/插件概念** |

---

## 5. readiness / liveness 与 drain 骨架（M0.4）

### 5.1 接口

```ts
export interface HealthCheck {
  name: string;
  check(): Promise<{ ok: boolean; detail?: unknown }> | { ok: boolean; detail?: unknown };
}

export interface ActorSystem {
  addHealthCheck(check: HealthCheck): void;
  /** live：进程活着；ready：可接流量 */
  health(): Promise<{ live: boolean; ready: boolean; checks: Array<{ name: string; ok: boolean; detail?: unknown }>; draining: boolean }>;
  /** 进入排水：readiness=false，仍可服务在途请求 */
  drain(opts?: { timeoutMs?: number }): Promise<{ drained: boolean; timedOut: boolean }>;
}
```
- **M0 只做内核侧**（`health()`/`drain()` + 状态机）；HTTP 端点与 LB 交互在 M2 接。
- readiness 判据：插件 setup 完成 + 持久化存储可写 + （若装了 cluster）gossip 收敛在容忍范围内 + 必需迁移已应用（M3 起）。
- drain 顺序（内核部分）：readiness=false → 停止接受（网关层拒新请求）→ 等在途消息排空（有界）→ 停 Actor（写快照）→ 逆序关插件。**每步有子预算，超预算记录并继续**（复用现有 `system_stop_timeout` 的日志与 busyActors）。

### 5.2 测试计划

| 用例 | 断言 |
|---|---|
| live 恒真 | 未 drain 时 `live=true` |
| ready 受检查影响 | 注入一个失败的 healthCheck → `ready=false`，`live` 仍 true |
| 检查超时 | 一个永不返回的检查 → 整体在预算内返回（该检查标记失败），不挂住 |
| drain 状态 | drain 期间 `draining=true`、`ready=false`、在途 ask 仍能完成 |
| drain 有界 | 卡死的 Actor 不会拖住 drain（预算内返回 + 记录 busyActors） |
| 重复 drain | 幂等，第二次立即返回 |
| 与 SIGTERM 集成 | 收到信号后进入 drain → 日志与状态可观测（examples 里演示） |

---

## 6. M0 交付清单（实现完成后要拿出的证据）

| # | 交付 | 证据 |
|---|---|---|
| 1 | TS + monorepo 工具链 | `npm test`（无构建跑 `.ts`）· `npm run typecheck` · `npm run build` · 临时工程 require+import 冒烟 |
| 2 | 可注入时钟 | 虚拟时钟单测；确定性重复执行 |
| 3 | 定时器 | §1.3 全部用例 + 1 万 Actor 规模无回归 |
| 4 | FSM | §2.3 全部用例（含 persist 跨重启） |
| 5 | stash | §3.3 全部用例 |
| 6 | receive-timeout | §4.3 全部用例 |
| 7 | 消息校验 | §5.3 全部用例 + 基准（有/无 schema） |
| 8 | 中间件 | §1.3 全部用例 + 基准（零中间件无回归） |
| 9 | 扩展插槽 | 契约测试（内置 + 最小实现各跑一遍） |
| 10 | 公共面瘦身 | 加载面测试（≤15）· 弃用警告 · 独立可用端到端示例 |
| 11 | 运维骨架 | health/drain 用例 + examples 里的 SIGTERM 演示 |

## 7. 本节待确认

| # | 事项 | 建议 |
|---|---|---|
| S1 | 校验中间件的位置（用户中间件之后） | 是：用户先做业务解包/鉴权，schema 兜底契约 |
| S2 | 观察型中间件抛错是否吞掉 | 吞掉并计数（提供 `observed()`），避免日志/指标故障引发业务失败 |
| S3 | 调度器/邮箱契约是否公开 | 公开最小契约（写进 `.d.ts` + 契约测试） |
| S4 | 订阅路径与插件包拆分现在做还是 M1 做 | 拆分放 M1（M0 先做**加载面**：core 不 eager 加载插件，插件仍在同仓但独立入口） |
| S5 | drain 是否需要与 cluster 交接联动 | M0 不联动（M4 再做）；M0 只保证"本节点优雅停" |
