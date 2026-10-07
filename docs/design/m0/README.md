# M0 详细设计：工具链迁移 + 内核原语（设计草案，未实现）

> 前置决策（已定）：**Q1 = TS 源码** · **Q2 = monorepo 多包** · **Q3 = 无状态控制器为默认**
> 本文是 M0 的施工设计：确切签名、语义、边界、测试计划。**不含实现代码。**

## 1. M0 范围

M0 只做两件事：**把地基换成 TS + monorepo**，**补齐业务必需的内核原语**。
不做 Web 层（M2）、不做数据层（M3）、不做分片（M4）。

| 阶段 | 内容 | 为什么这一阶段 |
|---|---|---|
| **M0.1 工具链与仓库结构** | TS 源码 + monorepo + 无构建的开发/测试循环 + 发布产物；现有 279 个用例（当时数字）迁移 | 越晚做越贵；它决定后面所有代码的形态 |
| **M0.2 内核原语** | 定时器（含可注入时钟）、FSM、stash、receive-timeout、消息校验 | 用户明确点名的五件缺失；都是"写业务立刻会撞到"的 |
| **M0.3 消息中间件与扩展插槽** | 消息级中间件链、可换调度器/邮箱/监督策略注册表、ctx 服务访问 | 中间件是校验/鉴权/指标的落点；插槽是"用户扩展"的落点 |
| **M0.4 公共面与运维骨架** | `index` 公共面瘦身（**breaking**）、readiness/liveness、drain 骨架 | 让"内核独立可用"成立；让运维能接 |

## 2. 退出标准（每阶段都要满足）

| # | 标准 | 验证方式 |
|---|---|---|
| E1 | 现有 279 个用例**全部**迁移后仍通过（可分批，但任一时点不得有红） | `npm test` |
| E2 | 开发与测试**不需要构建**：`.ts` 直接跑 | `node --test 'packages/*/test/**/*.test.ts'` |
| E3 | 发布产物是编译后的 JS + `.d.ts`（因为 node_modules 里的 `.ts` 不会被类型剥离） | 打包后装进临时工程，`require` 与 `import` 都能用 |
| E4 | 只装 core 时，`require('@actor/core')` 加载的模块数 **≤ 15**（当前 32） | 新增一条"加载面"测试（统计 `require.cache`） |
| E5 | 无必需依赖（`dependencies` 为空），无 node_modules 时单测除 9 个 level 用例外全绿 | 隐藏 node_modules 跑一遍 |
| E6 | 定时器在规模测试下不制造 N 个 Node 定时器；1 万 Actor 无性能回归 | 现有 `unit-actor-scale` + 新增定时器规模用例 |
| E7 | 每个原语有：正常路径、边界、崩溃重启后行为、虚拟时钟下的确定性用例 | 见各原语"测试计划" |

## 3. 任务顺序与依赖

```
M0.1 工具链
  └─ monorepo 骨架（packages/core 先空转） → tsconfig 体系 → CI（无构建测试 + 构建产物测试）
       └─ 现有代码分文件迁 .ts（allowJs 过渡）→ 现有用例迁 .test.ts
            └─ M0.2 虚拟时钟（先做，其他原语都依赖它做确定性测试）
                 ├─ 定时器（调度器 timer 轮）
                 ├─ receive-timeout（复用同一 timer 设施）
                 ├─ stash（邮箱能力）
                 ├─ FSM（ctx 能力）
                 └─ 消息校验（定义期 + 死信归类）
                      └─ M0.3 中间件链（校验/鉴权/指标挂载点）
                           └─ M0.4 公共面瘦身（插件改按需加载）→ 运维骨架
```

**先做虚拟时钟**是刻意的：定时器、receive-timeout、退避重试的测试都依赖它，否则每个原语的测试都要 `sleep`，既慢又不稳。

## 4. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| TS 迁移期间新旧文件混用 | 类型覆盖不均、`any` 泛滥 | `allowJs` 过渡 + 每迁一个文件就把该文件加进 `strict` 检查清单；禁止新增 `.js` 源文件 |
| monorepo 拆分导致测试运行器配置复杂 | CI 变慢、路径混乱 | 先单包内分目录（`packages/*` 平铺但共用 tsconfig base），确认稳定后再引入 workspace 工具 |
| 公共面瘦身是 breaking | 现有使用者（含 examples/tests）受影响 | 给兼容期：`require('pkg')` 仍导出插件但**打印一次弃用警告**，下个 major 移除；examples 全部改新路径 |
| 中间件进入热路径 | 性能回归 | 零中间件时走快路径（无链、无分配）；用现有规模用例守住 |
| FSM/stash 语义与 OTP 语义不一致 | 用户预期落差 | 文档逐条对照 OTP 写清差异（尤其 stash 溢出与 unstash 顺序） |

## 5. 本文档结构

| 文件 | 内容 |
|---|---|
| `01-ts-monorepo-toolchain.md` | 实测工具链结论、tsconfig 配方、monorepo 布局、迁移计划、装饰器结论、发布产物 |
| `02-primitives.md` | 定时器 / FSM / stash / receive-timeout / 消息校验：签名、语义、边界、测试计划 |
| `03-middleware-seams-ops.md` | 消息中间件、可换实现插槽、ctx 服务访问、公共面瘦身（breaking 细节与迁移）、readiness/drain |

## 6. 需要你确认的三件事（确认后即可开工）

| # | 事项 | 我的建议 |
|---|---|---|
| M0-1 | TS 源码用 **ESM**（`"type": "module"`）还是保持 **CJS** 语法 | **ESM 源码 + 双产物发布（ESM + CJS）**，CJS 消费者通过 `require` 条件继续可用。理由见 `01-…md` §2 的实测约束 |
| M0-2 | 装饰器是否进主线 | **不进**（Node 原生 TS 明确不支持装饰器，实测报错）。显式 builder 为主；装饰器作为**可选包**给已有构建链的用户 |
| M0-3 | 公共面瘦身的兼容期 | 给一个 minor 的**弃用警告期**（`require('pkg').plugins` 仍可用但警告），下个 major 移除 |

## 7. 进度

### M0.1 工具链与仓库结构 —— 结构性迁移完成（2025）

已完成：

| 项 | 结果 |
|---|---|
| monorepo 骨架 | 根为私有工作区根（`private: true` + `workspaces: ["packages/*"]`）；`packages/core` 为可发布包（name 保持 `nodejs-actor-framework`） |
| 代码归位 | `lib/**` → `packages/core/src/**`；`plugins/**` → `packages/core/src/plugins/**`；`index.js`/`index.d.ts`/`config.js` → `packages/core/src/` |
| 测试分层 | 17 个包级测试 + `helpers.js` + `fixtures/**` → `packages/core/test/**`；7 个 app/跨包测试留在根 `test/**` |
| 模块解析 | 工作区链接建立（`node_modules/nodejs-actor-framework → packages/core`）；根测试与示例改用**包名**引用公共 API（顺带验证包边界） |
| 分层修正 | 发现并修掉一处**反向依赖**：`core` 的 Telnet 控制台曾 `require` 应用的 `actor-main.js`（拿 DemoActor）→ 改为由使用方注入 `defaultActorDefinition` |
| `config.root` 语义 | 由 `__dirname`（框架包内）改为**应用根目录**（`ACTOR_APP_ROOT` 或 `cwd`）——框架装进 `node_modules` 后 `__dirname` 指向包内，是错的 |
| 工具链配置 | `tsconfig.base.json`（`erasableSyntaxOnly`/`verbatimModuleSyntax`/`isolatedModules`，强制"Node 可直跑"的 TS 子集）+ `tsconfig.json`（dev：`noEmit`，只校验 `.d.ts` 与类型测试） |
| 类型测试 | `test/types/*.ts → *.mts`（ESM，满足 `verbatimModuleSyntax`），导入路径改用包名/显式文件路径 |

验证证据：

- `npm test` → **279 / 279 通过，0 失败，0 取消**（迁移前后用例数一致）
- `npm run typecheck` → 通过
- 示例全部可跑：`game-server`（含 SIGTERM 优雅退出日志）、`cluster-two-nodes`、`alerts`、`actor-main`（boot + ask）
- **独立工程验证**：`npm pack` core → 装进临时工程 → `require('nodejs-actor-framework')` → `createSystem` + `spawn` + `ask` 成功（打包只含 `src/**`）
- 零依赖路径：摘掉 `classic-level` 后 `unit-stores`/`unit-core` 41 pass / 3 skip（level 用例跳过）
- 模块解析体检：190 处相对引用 0 失败；分层边界检查 0 越界（根 app 测试引用 `actor-main.js` 属预期）

尚未完成（M0.1 余下 + 后续）：

| 待办 | 说明 |
|---|---|
| `.js → .ts` 逐文件迁移 | 仍是 `.js`（`allowJs` 过渡）；按叶子→核心顺序，每批保持全绿 |
| 双产物发布 | `tsconfig.esm.json` / `tsconfig.cjs.json` + `exports` 映射 + `dist/`（现在 `main` 直接指 `src/index.js`） |
| 子路径导出 | `@actor/core/ops`、`@actor/core/obs` 等（现在类型测试用显式 `src/...js` 路径绕开） |
| 加载面瘦身（M0.4） | 当前 `require('nodejs-actor-framework')` 仍加载 **32** 个模块（含全部插件/cluster/obs），目标 ≤ 15 |
| 插件拆包（M1） | `plugins/**` 目前仍在 core 包内 |

## 审计后的如实记录（2026-10-07）

审计实测：`require('nodejs-actor-framework')` 之后仍会加载 **37 个** core 模块（E4 的目标是 ≤15）——
第 ① 项"公共面瘦身"（`index.ts` 里 eager `require('./plugins/index.ts')`）**尚未完成**，③④⑤⑥
（中间件 / schema 校验 / 可换调度器·邮箱·监督策略注册表 / readiness·liveness）也**没做**。

为什么没有在修复轮里直接做：这几项都是**对外行为的 breaking 变更**（改导出方式、改加载面、
新增原语），设计文档自己也写着"需要单独确认"（`docs/design/06-roadmap-and-nongoals.md`）。
按"先审计、别顺手改架构"的原则，这里**如实记为待排期**，并给出验收方式（E4：`require` 后模块数 ≤15
的自动化门禁；E5：隐藏 `node_modules` 后只装 core 跑单测）。
