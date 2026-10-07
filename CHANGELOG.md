# Changelog

本文件记录**对外可见的变化**。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 版本与发布策略（先读这一节）

**当前发布状态**（如实说明，别当成已发布）：

| 包 | 版本 | npm 状态 |
|---|---|---|
| `nodejs-actor-framework`（内核） | 1.0.0 | 可发布；**本 CHANGELOG 承诺它的兼容性**，从这次开始记录 |
| `@actor/app` `@actor/web` `@actor/data` | 0.1.0 | 技术上是可发布的包（未标 private），但**从未发布**；按 0.x 实验包对待 |
| `@actor/cli` `@actor/testkit` | 0.1.0 | `private: true`，仅 workspace 内可用 |

> 是否把 `@actor/*` 也公开到 npm，是开放问题 **Q7**（见 `docs/design/06-roadmap-and-nongoals.md`）：
> 目标用户是"团队内部"还是"公开发布"直接决定兼容承诺的强度。在这条决定之前，本文件只对
> **内核**的兼容性做承诺。

### 什么改动对应什么版本

| 变化 | 版本 |
|---|---|
| 新增可选能力、新增插件、修 bug | minor / patch |
| 改默认值、改错误类型、改方法签名 | **major** |
| 内核语义变化（如监督默认策略） | **major** |
| 用户自己的消息契约 | 不受框架版本约束（用户自己管） |

### 弃用流程

1. minor：标记 `@deprecated`（类型 + 运行期首次使用时警告一次），文档写替代方案；
2. 下一个 minor：保留但警告升级为"将在下个 major 移除"；
3. 下一个 major：移除，并写进迁移指南（能给 codemod 就给）。

**实验性标记**：新能力头两个 minor 标 `experimental`，明确"可能 breaking"，避免过早依赖。

### 发布前检查

```bash
npm run release:check          # = npm run ci（typecheck + 全量测试 + 文档站）+ 打包/一致性检查
npm run release:check -- --skip-ci   # 只跑打包与一致性检查（本地快速自检）
```

检查项：工作区测试矩阵（每个有测试的包都在 `npm test` 的 glob 里）、`npm pack` 内容
（不含测试/证书/数据目录）、CHANGELOG 最新版本与 `packages/core/package.json` 一致、
各包 `engines` 一致、工作区干净。

## [Unreleased]

（下一次发布的改动写在这里。）

## [1.0.0] - 2026-10-07

内核的第一个正式版本。这一版的兼容承诺由本文件与 `packages/core/src/index.d.ts` 共同表达：
**运行时导出 34 项全部有类型声明**，且由两道门禁锁住（`test/unit-kernel-surface.test.js` 与
`npm run release:check`）。


### Added

- **数据层**（`@actor/data`）：Repository（memory/file/SQL + 游标分页 + `version` 乐观锁）、
  事件溯源 `defineAggregate`（`expectedVersion` 条件写）、事件版本与 upcast 注册表、
  快照版本策略（迁移 / 重建 / 拒绝启动）、迁移框架（默认拒绝启动）、
  outbox（事件日志即 outbox + 至少一次 + 消费幂等）、投影（断点续跑 / 去重 / 从 0 重建）。
- **集群治理**（内核）：一致性哈希环与分片所有权、所有权守卫与 fencing token（`(shard, ownerNodeId, epoch)`）、
  优雅交接（`cluster.drain()`：冻结/重定向/排空/落盘/释放 + 新 owner 自动加代）、单例、少数派拒写、
  可迁移性声明与 `cluster.metrics()`。
- **CLI**（`@actor/cli`）：`actor new app`（生成可运行骨架）、`actor migrate status|up|down`、
  `actor doctor`。
- **可注入时钟 + 虚拟时钟**：`createSystem({ clock })`、`ctx.clock` / `ctx.sleep()`、
  `@actor/testkit` 的 `createVirtualClock()`（把"等一小时"变成 0 真实毫秒）。
- **测试工具**（`@actor/testkit`）：探针（记录消息/回复/抛错/耗时）、故障注入
  （`fail`/`delay`/`drop`，可按次数与 `match`）、HTTP 测试客户端。
- **可观测性**：span 生命周期 + `plugins.otlp()`（OTLP/HTTP+JSON 零依赖真实导出）、
  `createLogAdapter()`（桥接 pino/winston/console）。
- **文档**：零依赖文档站（`npm run docs:build`，含断链门禁与自动 API 参考）、
  面向使用者的 8 篇指南（每个示例都被测试真跑）、CI 门禁与 GitHub Pages 部署。

### Changed

- `package.json` 的 `engines.node` 从 `>=20` 修正为 `>=24`（源码直接跑 TypeScript 且 SQL 适配器用
  `node:sqlite`，Node 20/22 起不来）。
- gossip 现在交换 peer 地址并按轮剔除过期成员（此前 N≥3 的成员视图永不收敛、`node_timeout` 永不触发）。

### Fixed

- 令牌桶的时间来源统一到系统时钟（此前混用 `Date.now()`：注入时钟后**限流会永久卡住**），
  并对浮点累积加了 epsilon。
- `MigrationStatus.pending` 与同类字段统一为版本号数组（此前是迁移对象，CLI 打印成 `v[object Object]`）。
- 事件类型在数据层显式给出（`EventLogEntry.type` / `OutboxEntry.type`），投影的"按类型订阅"不再依赖
  payload 里的隐式约定。
- 把 `defineConfig()` 的结果当 schema 传给 `validateValues()` 时给出明确错误（此前会**栈溢出**）。
