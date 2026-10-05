> **状态：M1 已实现**（2026）。
>
> 已落地代码：`packages/app/src/config.ts`（配置系统）、`packages/app/src/assembly.ts`
> （装配/DI/模块/生命周期/插件 SDK）、`packages/app/src/plugins.ts`（内置能力包装）。
> 端到端示例：`examples/app-minimal/`；上手文档：`docs/quickstart.md`。
> 验收测试：`packages/app/test/{config,app,plugin,builtin-plugins}.test.ts` + 根侧
> `test/unit-app-boundary.test.js`（导入面守卫）与 `test/integration-example-app-minimal.test.js`。
>
> 尚未实现（属后续里程碑）：插件间依赖排序（当前仅按声明顺序 setup、逆序 teardown）、
> provider 的 transient scope、热重载、插件市场/marketplace 概念。

# 配置、依赖注入与插件 SDK（设计草案）

> 对应开放问题 Q6；回答"用户配置 / 用户扩展 / 自定义插件"这三项到底该长什么样。
> 这三件事是同一个问题的三个面：**如何把外部世界（配置、服务、能力）安全地接进 Actor 世界。**

## 1. 配置系统

### 1.1 现状与问题

现在：`config.js` 从 env 读一批固定键 + `createSystem(options)` 逐项覆盖。

| 问题 | 后果 |
|---|---|
| 没有 schema | 键名写错（`ACTOR_GOSSIP_POR`）静默走默认值，排查半天 |
| 没有分层 | 业务侧配置只能自己想办法（塞 env 或全局变量） |
| 没有按 Actor/插件分节 | 每个 Actor 类型的配置无处声明，只能硬编码或用 spawn 选项 |
| 没有热加载 | 改配置要重启 |
| 敏感值无脱敏 | `inspect()`/日志可能打出密钥 |
| 没有多环境概念 | dev/prod 靠人肉记住哪些 env 要设 |

### 1.2 目标设计

**分层优先级**（低 → 高）：内置默认值 → 配置文件 → 环境变量 → 运行时覆盖（`createSystem` 参数）。

```js
// config/app.config.js —— 单一配置文件也是 schema 定义
const { defineConfig, t } = require('@actor/core/config');

module.exports = defineConfig({
  server: {
    host: t.string({ default: '0.0.0.0', env: 'HOST' }),
    port: t.number({ default: 8080, env: 'PORT', min: 1, max: 65535 }),
  },
  log: {
    level: t.enum(['debug', 'info', 'warn', 'error'], { default: 'info', env: 'LOG_LEVEL' }),
  },
  // 按 Actor 类型分节：spawn 时自动合并
  actors: {
    Player: {
      maxHp: t.number({ default: 100, min: 1 }),
      saveEveryTicks: t.number({ default: 25 }),
    },
    Room: {
      capacity: t.number({ default: 50, min: 1, max: 1000 }),
    },
  },
  // 按插件分节：由插件 manifest 声明（见 §3.2）
  plugins: {
    cluster: { seeds: t.array(t.string(), { default: [] }) },
    metrics: { port: t.number({ default: 9464 }) },
  },
});
```

**校验与错误信息**（这是 schema 系统真正的价值）：

```
ConfigError: plugins.metrics.port
  来源: 环境变量 ACTOR_METRICS_PORT="http"
  期望: number (1..65535)
  实际: "http"
  提示: 该键由插件 metrics 声明；运行 `actor config explain plugins.metrics.port` 查看全部来源
```

每条错误必须给出：**键路径 + 实际来源（默认值/文件第几行/env 变量名/代码覆盖）+ 期望类型 + 提示**。

**多环境**：`app.config.js` + `app.config.production.js`（按 `NODE_ENV` 叠加），再叠 env。不引入"配置中心"概念，但**配置来源可插件化**（`configSources: [fileSource, envSource, consulSource]`）。

**敏感值**：`t.secret({ env: 'AUTH_SECRET' })` → 日志/inspect/错误信息里一律 `***`；只能在代码里通过 `config.get()` 取值，禁止整体序列化。

**热加载**（关键设计取舍）：

```js
// 变更流程：读新配置 → 全量校验 → 通过才替换 → 以消息通知订阅者 → 失败则保留旧值并告警
await system.reconfigure(newConfigSource);
```
- **绝不允许** Actor 在 `receive` 里直接读可变全局配置——那等于引入隐性共享状态。
- Actor 想感知配置变化，必须显式订阅：`ctx.watchConfig('server.port', (next) => ...)` 或收到 `{ type: 'configChanged', key, next }` 消息。
- 校验失败 **不生效**（保留旧值）+ 告警事件 `config_reload_failed`。

### 1.3 Actor 配置的取用

```js
system.spawn(Player, { id: 'p1' });          // 自动合并 config.actors.Player
class Player extends Actor {
  async receive(msg, ctx) {
    const maxHp = ctx.config.maxHp;            // 类型安全的节
    const host = ctx.config.server.host;       // 也能读全局
  }
}
```
**取舍**：配置采用**值拷贝**注入（Actor 拿到的是自己那节的快照），避免"一个 Actor 改了配置影响全局"。

## 2. 依赖注入 / 服务容器

### 2.1 为什么需要

现在 Actor 拿依赖只有两条路（见 README 的"依赖怎么传"）：闭包（每连接依赖）或挂在 `system` 上（节点级依赖）。这够用但**没有生命周期、没有作用域、没有测试替换、不能表达依赖关系**。控制器需要请求级作用域，插件需要提供服务——所以要有容器。

### 2.2 目标设计

```js
const { Container } = require('@actor/core');

const c = new Container();
c.value('clock', system.clock);
c.singleton('users', async (c) => new UserRepository(c.get('db')));   // 异步、懒初始化
c.factory('mailer', (c) => new Mailer(c.get('config').smtp));         // 每次新建
c.scoped('tx', (c) => new Transaction(c.get('db')));                   // 请求/消息作用域
await c.init();      // 拓扑初始化，循环依赖在此报错
```

**生命周期与框架绑定**：`system.init()` 时初始化容器；`system.stop()` 时**逆序 dispose**（含超时，避免关停被卡住——与内核 `shutdownTimeoutMs` 一致的语义）。

**Actor 取依赖的两种方式**（都要支持，场景不同）：

```js
// ① 显式惰性取：推荐，可测、无隐式，跨 worker 也能用（走 ctx 代理）
async receive(msg, ctx) {
  const users = ctx.get('users');
}

// ② 声明式注入：类 Actor 的构造期注入，写起来最舒服
system.spawn(Player, { id: 'p1', deps: ['users', 'clock'] });
class Player extends Actor {
  constructor(users, clock) { super(); this.users = users; this.clock = clock; }
}
```
**注意**：② 在 `isolation: 'worker'` 下**不成立**（依赖不可结构化克隆）。规则：worker 隔离的 Actor 只能用 ①，且注入的服务必须是可序列化的"远程代理"或干脆是无状态的；不可序列化的依赖（DB 连接、socket）**不允许**跨线程。这条必须写进文档并在 spawn 时报错。

**作用域**：
- `singleton`：节点级（DB 池、指标）
- `scoped`：请求/消息级（事务、当前用户、trace 上下文）——HTTP 请求与 Actor 消息各有一个作用域
- `factory`：每次新建（无状态工具）

**测试替换**：`createTestSystem({ overrides: { users: fakeUsers } })`，容器可整体替换。

## 3. 插件 SDK

### 3.1 现状与问题

现在的插件是裸对象 `{ name, setup(system), teardown(system) }`：没有依赖声明、没有顺序保证（仅逆序 teardown）、没有配置 schema、没有测试工具、没有版本兼容声明。写第三个插件的人会开始互相猜。

### 3.2 目标设计

```js
const { definePlugin, t } = require('@actor/core/plugin');

module.exports = definePlugin({
  name: 'cluster',
  version: '1.0.0',
  peerRange: '>=1.0 <2',              // 与内核版本兼容区间，不满足则启动即报错

  requires: ['config', 'tracing'],    // 依赖的插件 → 拓扑排序
  provides: ['discovery'],            // 注入容器的服务名 → 其他插件/Actor 可 ctx.get

  config: {                            // 配置节（自动并入 config.plugins.cluster）
    seeds: t.array(t.string(), { default: [] }),
    intervalMs: t.number({ default: 1000, min: 100 }),
  },

  async setup(system, { config, container, logger }) {
    const gossip = new Gossip(config.seeds);
    container.value('discovery', gossip);            // 暴露服务
    system.use(tracingMiddleware());                 // 注册消息中间件
    return {
      routes: [route('/_cluster/info', () => gossip.info())],  // 可选：贡献 HTTP 路由
      healthChecks: [() => ({ name: 'cluster', ok: gossip.converged(), detail: gossip.info() })],
      actors: [{ definition: NullActor, id: 'cluster-guard', persistence: 'snapshot' }],
      async teardown() { await gossip.stop(); },
    };
  },
});
```

**插件能力清单**（即"插件能往系统里加什么"）：

| 能力 | 用途 | 落点 |
|---|---|---|
| `provides` 服务 | 给其他插件/Actor 提供依赖 | 容器 |
| `config` 节 | 自己的配置 + 校验 + 文档生成 | 配置系统 |
| 消息中间件 | 跨切面（鉴权、指标、追踪） | 内核消息链 |
| HTTP 路由 | 暴露自身端点（`/_cluster/info`） | Web 层 |
| 健康检查 | 参与 readiness | 运维层 |
| Actor 声明 | 插件自带 Actor（如单例守护） | 内核 spawn |
| 定时任务 | 周期性工作 | 内核定时器 |
| CLI 命令 | `actor cluster peers` | CLI |
| 迁移 | 插件自己的存储结构 | 数据层 |
| 钩子 | `onActorSpawned` / `onActorStopped` / `onConfigChanged` | 内核事件 |

**顺序与失败策略**：
- 依赖图**拓扑排序**；成环 → 启动失败并打印环路径（不是警告）。
- 缺依赖 → 启动失败（`requires: ['tracing']` 但未安装）。
- `setup` 抛错 → 已成功的插件**逆序回滚**，然后系统启动失败（不允许"半个系统"在跑）。
- 运行期 `teardown` 失败 → 记录并继续（关停不能被一个插件卡住）。

**插件不该做的事**（写进贡献指南）：deep-import 内核内部（`src/actor/*`）、假设 Actor 是单线程以外的语义、在 `setup` 里同步阻塞、把不可序列化对象注入 worker Actor、私自注册全局 `process.on`。

### 3.3 插件怎么发布

- 每个插件一个包：`@actor/plugin-cluster`、`@actor/plugin-metrics`…（与方案 A 一致）。
- `peerRange` 声明兼容的内核版本；不满足 → 启动失败并给出升级建议。
- 插件自带 README + 配置表（可由 `config` schema **自动生成**，避免文档过期）。
- 插件模板：`actor new-plugin <name>`（CLI，M5）。

## 4. 扩展点总表（回答"用户扩展"）

| 扩展点 | 期望用途 | 优先级 | 备注 |
|---|---|---|---|
| Actor 行为/特质（timers、FSM、stash） | 组合能力而不改继承 | P0 | 见 doc 01 §3 |
| 消息中间件 | 跨切面逻辑 | P0 | 全局 + 按 Actor |
| 消息 schema | 校验外部输入 | P0 | 失败进死信 |
| 容器服务（自定义依赖） | 注入任何东西 | P0 | doc 02 §2 |
| 插件 | 打包可复用能力 | P0 | doc 02 §3 |
| 持久化适配器 | 换存储 | 已有 | ✅ 现状 |
| 邮箱实现 | 特殊排队策略（优先级、去重） | P1 | 需稳定最小契约 |
| 调度器 / 时钟 | 虚拟时钟、特殊公平策略 | P1 | TestKit 依赖它 |
| 监督策略 | 自定义重启决策 | P1 | 注册表，不是新构造参数 |
| 序列化/codec | 自定义帧编码 | P1 | 已有 JSON/Protobuf，加注册表 |
| 传输 | 换掉 TCP 网关（如 QUIC） | P2 | 需要 transport 接口 |
| HTTP 中间件 / 路由 | Web 扩展 | P1 | doc 03 |
| 投影/读模型 | 查询侧扩展 | P1 | doc 04 |
| ctx 扩展（只读服务） | 通过 `ctx.get` 暴露 | P0 | 禁止直接改 `ctx` 属性 |
| CLI 命令 | 运维脚本 | P2 | doc 06 |

## 5. 本节待决策

| # | 问题 | 建议 |
|---|---|---|
| B1 | 配置用"代码即 schema"（`defineConfig`）还是独立 schema 文件 | 代码即 schema（零构建、可复用类型） |
| B2 | 热加载是否做 | 做，但**校验通过才生效**，Actor 只能通过消息/订阅感知 |
| B3 | 容器是否需要自动扫描/自动注册 | 不需要（显式注册，便于审计与测试） |
| B4 | 插件是否允许贡献 HTTP 路由 | 允许，但统一挂在 `/_` 前缀下，避免与业务路由冲突 |
| B5 | Actor 依赖用 `ctx.get` 还是构造注入 | 两者都支持；worker 隔离下只允许 `ctx.get`（并在 spawn 时报错） |
