# 迁移指南

> 审计（里程碑 M5）指出：设计文档把"迁移指南"列为交付物，但 `docs/` 下并没有这份文件。
> 这一页补上它。

## 一、从 v0.x（旧运行时）迁到 1.0

旧运行时指 `index.js` 时代那套：一个文件里混着监督树、优先级邮箱、队列式 Actor、动态热更新。
1.0 是**瘦身过的内核**（`packages/core/src`），下面这些能力**已被删除**，需要按"等价写法"改造。

| 旧能力 | 现状 | 等价写法 / 迁移动作 |
|---|---|---|
| `PriorityMailbox`（优先级邮箱） | ❌ 不移植 | Actor 模型是**每 Actor 单 FIFO**。要优先级请在业务层自己分两个 Actor（或一个 Actor 内分两条队列），别指望邮箱排序 |
| 队列式 Actor 的批量消费（`onBatch` / `ACTOR_BATCH_*`） | ❌ 从未实现 | 需要攒批就在 Actor 自己里攒（`ctx` 里存 buffer + 定时 flush），框架不提供"批量触发"契约 |
| `supervisor.js`（旧监督实现） | ❌ 删除 | 用 `createSystem({ supervision: { strategy, maxRestarts, withinSeconds } })` 与 `Actor` 的 `preRestart`/`postStop`；升级语义是 OTP 的（超限 → 升级给父，根侧停系统） |
| 热更新（`new Function` 动态编译） | ❌ 删除 | 用 `isolation: 'worker'` + 模块路径：改完文件后重启该 Actor（`spawn(path, { isolation: 'worker' })`） |
| 熔断 + 冷却自愈 | ❌ 删除 | 它会"让超限的 Actor 悄悄复活"，与 OTP 语义冲突。现在超限**可见地**升级/停系统；要自愈请自己写 supervisor 策略 |
| `Monitor` 监控（含 reason） | ❌ 从未实现 | 用 `system.on('actor_stopped' | 'system_failure')` 或父 Actor 的 `preRestart` 观察 |
| `lib/` 目录 | ❌ 不存在 | 源码在 `src/`；公开面是 `src/index.ts`（`index.mjs` 是 ESM 包装），其余都是内部实现 |

**深引用**：`require('nodejs-actor-framework/src/ops/token')` 这类写法必须带 `.ts`
（本仓库直跑 TypeScript，不做扩展名补全）—— 审计里 README 的三处示例就因此报 `MODULE_NOT_FOUND`。
更稳的做法是别深引用内部模块：`FilePersistence`、`TokenAuthority`、`WebSocketServer` 等**已在包根导出**。

## 二、从 0.x 的工作区包（`@actor/*`）迁到当前形态

| 变化 | 迁移动作 |
|---|---|
| `@actor/app` 的 `definePlugin` 现在支持 `requires` / `provides` | 有依赖关系的插件请显式声明；声明顺序不再重要（会拓扑排序），成环会在 `start()` 时把环打印出来 |
| 插件的 `config` schema 合并进 `plugins.<name>.*` | 配置项读法与原来一致，无需改动 |
| `@actor/web` 的 `ctx.actor()` / `ctx.repository()` | 未变；注意它们**不属于内核声明面**（`@actor/web` 目前不发布 `.d.ts`） |
| 持久化能力字段 | `system.persistenceCapabilities()` 如实上报：`file`/`memory` 只保证**同进程**（`'in-process'`），跨进程原子性要换支持 CAS 的后端 |

## 三、升级检查清单

1. `npm run typecheck` —— 声明面与源码两份配置都要过（1.0 起 `test/types/**` 真的接进了 `npm run typecheck`）。
2. `npm test` —— 620+ 用例；示例也有冒烟门禁（`test/unit-examples-smoke.test.js`）。
3. 跑一遍 `node packages/cli/src/cli.ts doctor`：Node 版本、依赖、配置、数据目录、迁移、端口。
4. 数据迁移用 `actor migrate status|up|down --to <v>`（回滚必须显式给 `--to`，CLI 不猜）。
5. 集群升级：TLS 必须配；非回环 + 无 TLS 现在会**拒绝启动**（要裸奔得显式 `allowInsecureBinding: true`，
   并且知道同网段任何人都能 `tell/deliver/stop` 你的 Actor）。

## 四、兼容性承诺的范围

见 [CHANGELOG.md](../CHANGELOG.md) 开头"版本与发布策略"一节：**只有内核 `nodejs-actor-framework` 的兼容性被承诺**，
`@actor/*` 是 0.x 实验包（Q7 未定：是否公开到 npm 直接决定承诺强度）。
