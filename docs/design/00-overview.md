# 架构总览（设计草案，未实现）

> 状态：**设计草案**。本目录只描述设计与取舍，不含实现代码。
> 目标读者：要在其上做业务的团队，以及后续接手实现的人。

## 1. 目标与约束

**产品目标**：一个 Node.js 的 **全栈 Web 框架**，底层是 Actor 运行时。

**硬约束（用户明确要求）**：

1. **Actor 模块必须能单独使用**——不引入 Web 层、不引入数据层，就能写一个纯 Actor 服务（现在的形态）。
2. 在 1 的基础上，提供完整的 Web 开发体验：路由、控制器、校验、鉴权、配置、依赖注入、数据模型、插件、扩展点。

这两条看起来矛盾，其实是**分层 + 单向依赖**的问题：Actor 内核在下，Web/数据层在上，上层依赖下层，反之绝不依赖。第 2 节把这条规则变成可机械检查的约束。

**非目标（明确不做，见 `06-roadmap-and-nongoals.md`）**：ORM/查询构建器、模板引擎、装饰器魔法、管理后台 UI。

## 2. 分层

```
┌──────────────────────────────────────────────────────────────┐
│  L4 应用层（用户代码）                                        │
│     controllers / routes / aggregates / handlers / migrations │
├──────────────────────────────────────────────────────────────┤
│  L3 能力层（可选安装）                                        │
│     @actor/web    路由·控制器·校验·鉴权·WS/HTTP·请求作用域     │
│     @actor/data   仓储·事件溯源聚合·schema 演进·outbox·投影    │
│     @actor/testkit 虚拟时钟·探针·HTTP 测试客户端·测试系统      │
│     @actor/cli    脚手架·代码生成·迁移命令                     │
├──────────────────────────────────────────────────────────────┤
│  L2 运行时服务层（内核自带，Web 与纯 Actor 共用）              │
│     config · container(DI) · plugins · middleware · health     │
│     timers · logging · metrics · tracing · alerting            │
├──────────────────────────────────────────────────────────────┤
│  L1 Actor 内核（已实现，必须能独立运行）                       │
│     Actor/定义 · 邮箱 · 调度器 · 监督树 · 失败语义 · 持久化     │
│     隔离(worker) · 传输(帧+mTLS) · 集群发现(cluster 插件)      │
└──────────────────────────────────────────────────────────────┘
        依赖方向：只能向下。L1 不得出现任何 L2+ 的概念。
```

**关键点：L2 是"共用层"，不是 Web 层。** 纯 Actor 用户也会用到配置、DI、插件、定时器、指标——所以它们不属于 Web，放在内核的运行时服务里（现在已有雏形：`config.js`、`plugins/`、`src/obs/*`）。

## 3. 包结构与依赖规则

### 方案 A（推荐）：monorepo + 独立包

```
packages/
  core/        @actor/core     零必需依赖；Actor 内核 + 运行时服务
  web/         @actor/web      依赖 core；HTTP/WS 层
  data/        @actor/data     依赖 core；仓储/事件溯源/迁移
  testkit/     @actor/testkit  依赖 core（可选 web）
  cli/         @actor/cli      依赖 core(+web/data，按模板)
  plugins/     @actor/plugin-* 每个插件独立包（cluster/pubsub/metrics/…）
examples/
docs/design/
```

**为什么推荐**：只有独立包能**真正保证**"Actor 可单独使用"——独立 `package.json`、独立依赖图、独立发布、独立 CI。单包做不到这一点（用户 `npm i` 就要吞下全部依赖）。

**代价**：仓库结构变复杂、需要 workspace 工具（pnpm/npm workspaces）、跨包改动要一起发版。对一个要长期演进的框架，这个代价值得。

### 方案 B（轻量）：单包 + 子路径导出

```
index.js            # @actor/core 的公共面（现在就是）
packages/core/src/web/…    # require('pkg/web')（方案 B 的单包形态）
packages/core/src/data/…   # require('pkg/data')
```
**代价**：无法从安装层面隔离依赖；只能靠约定 + CI 检查。适合"短期先跑起来"。

### 依赖规则（无论选哪个方案都要有）

| 规则 | 检查方式 |
|---|---|
| `core` 不得 import `web`/`data`/`cli` | 静态检查脚本（扫描 `packages/core/**` 的 import 白名单），进 CI |
| `core` 保持零必需依赖（`dependencies` 为空） | `package.json` 断言 + 无 node_modules 下单测全绿（现在已有这个能力） |
| `web`/`data` 只能通过 `core` 的公共面（`index.js`/`index.d.ts`）访问内核，不得 deep-import `src/actor/*` | lint 规则 + 只在 core 内部使用 `src/` 路径 |
| 每个包能单独 `npm test` | CI 矩阵 |

> 第 3 条很重要：**deep-import 是"独立可用"最常见的破坏方式**。现在 `examples/*` 已经在用 `src/ops/...` 这种路径——那些属于有意公开的传输/运维模块，需要正式提升为公共面（例如 `@actor/core/ops`），否则规则没法执行。

## 4. Actor 与 Web 的关系（本设计最核心的一条）

**HTTP 层不承载 Actor 语义；它通过 `ActorRef` 访问 Actor。**

```js
// 控制器是无状态的普通异步函数，只做"协议翻译 + 调用 Actor"
class UserController {
  async getUser(ctx) {
    const ref = ctx.actor(`user-${ctx.params.id}`);  // ← 桥：返回 ActorRef
    const profile = await ref.ask({ type: 'profile' }); // 请求-响应
    return ctx.json(profile);
  }
}
```

这条桥的意义：`ctx.actor(name)` 返回的 ref **在本地和远端同构**（内核已经具备——`system.resolve()` + cluster 发现 + 懒连接）。所以：

- 开发期：Web 与 Actor 同进程，调试最简单。
- 规模期：把 Actor 拆到独立进程/机器，**控制器代码一行不改**（`ctx.actor` 变成远端 ref）。
- 这就是"全 Web 框架"与"Actor 可单独使用"能同时成立的原因：两者之间只隔一个 ref。

**性能边界（必须写进文档、避免用户踩坑）**：

| 做法 | 结论 |
|---|---|
| 一个实体一个 Actor（user-123、room-4），请求路由到实体 Actor | ✅ 推荐。串行化只发生在同一实体内，符合业务语义 |
| 所有请求都 `ask` 同一个 Actor | ❌ 反模式。Node 单线程 + Actor 串行 = 吞吐塌陷 |
| 每个请求 spawn 一个 Actor | ❌ 反模式。Actor 是长期实体，不是请求对象；请求状态用 `ctx`（请求作用域） |
| 长任务（>1s）同步等 | ⚠️ 用 `tell` + 任务 Actor + 轮询/SSE/webhook 回报，别占着 HTTP 连接 |
| 高频只读查询 | ⚠️ 走投影/读模型（`04-data-and-evolution.md`），别让查询 Actor 成为单点 |

## 5. 关键决策表

| # | 决策 | 备选 | 建议 | 主要理由 |
|---|---|---|---|---|
| D1 | 包结构 | monorepo 多包 / 单包多入口 | **monorepo** | 唯一能机械保证"Actor 单独可用"的方式 |
| D2 | Web 与 Actor 部署形态 | 同进程 / 接入层分离 | **同进程为默认，ref 为缝** | 开发体验优先，且随时可拆；控制器代码不变 |
| D3 | 控制器语义 | 无状态控制器 / Actor 支撑控制器 | **无状态为默认，按路由 opt-in** | 避免把 HTTP 并发塞进单个 Actor；长任务显式声明 |
| D4 | 路由风格 | 显式 builder / 文件路由 / 装饰器 | **显式 builder** | 无构建步骤、纯 CJS 可用、可静态分析；装饰器留作可选 TS 插件 |
| D5 | 源码语言 | JS + `.d.ts`（现状） / TS 源码 + 构建 | **待定，见开放问题 Q1** | 影响装饰器/DI 体验与发布复杂度 |
| D6 | 校验 | 内置极简校验 / 依赖 zod / 适配器 | **内置 + zod/ajv 适配器** | 保持 core 零依赖；web 层可选用生态 |
| D7 | 数据层主线 | 仓储(CRUD) / 事件溯源 | **两者都提供，事件溯源为差异化** | CRUD 用现有 stores 就够了；事件溯源+演进才是框架价值 |
| D8 | ORM | 自研 / 集成 | **不自研，提供适配器接口** | 自研 ORM 是泥潭；用户要 Prisma/Drizzle 就接进去 |
| D9 | 配置 | env-only / 分层 + schema 校验 | **分层 + schema + 校验前置** | 现在的 env-only 对业务配置不够用，且无校验会静默出错 |
| D10 | 配置热加载 | 直接改 / 校验后生效 + 通知 Actor | **校验后生效，变更以消息投递给 Actor** | Actor 不应在任意时刻读全局可变配置 |
| D11 | 扩展点 | 继承 / 组合行为 + 中间件 + 可换实现 | **组合 + 中间件 + 可换** | 现在调度器/邮箱/监督策略写死，是最大扩展性短板 |

## 6. 术语

| 术语 | 含义 | 与现有代码的关系 |
|---|---|---|
| Actor | 有状态、串行处理消息的实体 | `src/actor/actor.js` |
| Controller | 无状态的请求处理器，把 HTTP 语义翻译成 Actor 消息 | 新增（L3） |
| Route | method + path → controller action 的映射 | 新增（L3） |
| Service | 注册在容器里的可注入依赖（含 ActorRef） | 新增（L2） |
| Plugin | 可插拔能力（setup/teardown + 配置 schema + 依赖声明） | 现有 `plugins/*`，需 SDK 化 |
| Aggregate | 事件溯源的一致性边界，通常由一个 Actor 承载 | 新增（L3/data） |
| Projection | 订阅事件、维护查询用读模型的组件 | 新增（L3/data） |
| Middleware | 消息/请求处理链上的一环（校验、鉴权、审计、指标） | 消息级为新增；HTTP 级为新增 |
| Shard | 分片：一批 Actor 的所有权单元，可迁移 | 新增（M4） |

## 7. 开放问题（需要决策后才能进入实现）

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| Q1 | 源码语言 | A. 保持 JS+CJS+`.d.ts`（现状）<br>B. 转 TS 源码 + 构建产物 | B 的装饰器/DI/类型体验好得多，但要引入构建与 `dist/`，且与"零依赖、无构建"的现状冲突。**这条决定整个 Web 层的 API 风格** |
| Q2 | 包结构 | 方案 A（monorepo）/ 方案 B（单包多入口） | 决定仓库与发布流程的改造量 |
| Q3 | 控制器默认 | 无状态（推荐）/ Actor 支撑 | 决定 HTTP 并发模型与文档叙事 |
| Q4 | 路由风格 | 显式 builder（推荐）/ 文件路由 / 装饰器 | 与 Q1 强相关 |
| Q5 | 数据主线 | 事件溯源优先 / 仓储优先 | 决定文档与示例重心，以及 M3 的实现顺序 |
| Q6 | 校验依赖 | 内置极简 / 要求 zod | 影响 web 包是否"零依赖" |
| Q7 | 目标用户 | 团队内部 / 公开发布 npm | 决定版本策略、文档投入、兼容承诺强度 |
| Q8 | 集群范围 | 只做发现（现状）/ 加分片所有权与交接 | 分片交接（M4）是"全栈框架做生产"的分水岭，但复杂度高 |

## 7.5 已确认的决策（用户已拍板）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 源码语言 | **TS 源码**（工具链实测见 `m0/01-ts-monorepo-toolchain.md`） |
| Q2 | 包结构 | **方案 A：monorepo 多包** |
| Q3 | 控制器语义 | **方案 A：无状态控制器为默认**，按路由 opt-in 到 Actor |
| — | 补充确认 | 内核缺失的定时器 / FSM / stash / receive-timeout / 消息校验 → 进 **M0**（详见 `m0/02-primitives.md`）|

> 详细施工设计见 [`m0/`](m0/README.md)：M0.1 工具链与仓库结构 · M0.2 内核原语 · M0.3 中间件与插槽 · M0.4 公共面与运维骨架。

## 8. 文档索引

| 文件 | 内容 |
|---|---|
| `01-actor-core-standalone.md` | 如何保证内核独立可用；内核待补的原语（定时器/FSM/stash/receive-timeout/中间件/可换实现） |
| `02-config-di-plugins.md` | 配置系统、依赖注入容器、插件 SDK |
| `03-web-layer.md` | 路由、控制器、Actor 访问桥、校验与鉴权、错误映射、反模式 |
| `04-data-and-evolution.md` | 仓储、事件溯源聚合、schema 演进/upcast、迁移、outbox、投影 |
| `05-cluster-ops-testkit.md` | 分片与 singleton、readiness/drain、可观测性、TestKit |
| `06-roadmap-and-nongoals.md` | 里程碑与验收标准、版本与弃用策略、明确不做的事、开放问题汇总 |
