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

M9（脚手架与 CLI + 应用层语法糖）的收尾：**保留名的单一来源与启动期校验**、**T2 参数简写**、
**T3 工厂糖与 debug 四层可见性作用域**、**`actor new plugin` 补齐四种 kind**。

### Added

- **保留名的单一来源**（`@actor/web` / `@actor/app` 导出，文档与门禁都读它）：
  `RESERVED_CONTEXT_KEYS`（本就存在，现公开）、`RESERVED_ROUTE_PREFIXES` / `RESERVED_PREFIX_OWNERS`、
  `RESERVED_SERVICE_NAMES` / `isReservedServiceName` / `reservedServiceNamesIn`，
  以及 `inReservedPrefix` / `prefixesOverlap` / `pluginPrefixCollisions` / `duplicatePrefixOwners`
  与 web 层的 `framework` 标记（框架自带插件用它宣称"保留前缀是我的地盘"）。
- **T2 参数简写**：
  - 配置 **值即 schema**（`config({ port: 3000 })` ≡ `{ type: 'number', default: 3000 }`），
    `ConfigSchemaInput` / `ConfigEntry` / `ConfigValue` 一套类型；`FieldSpec.required: false` 表示可缺省；
  - 控制器 **输入声明合一**（`input: { filename: 'string' }`，默认来自 body；`from: 'query'|'params'` 保留），
    `defineController` 自动补齐 `body`；
  - 中间件 **阶段即函数名**：`atPre` / `atAuth` / `atParse` / `atHandler` / `atPost` / `atError` 与 `phase()`。
- **T3 工厂糖**（`@actor/web`）：`crudRoutes(prefix, store, opts)`（五路由 + 分页 + 404/409 + 逐项覆盖，
  仓储只要结构化最小形状 `list/get/create/update/remove`）、`healthRoutes()`（只报告进程形状的 `/health`）。
- **debug 四层可见性作用域**：全局 `debugPlugin({ expose: { hidePrefixes } })`、
  模块 `defineModule({ debug: { expose, hidePrefixes } })`、控制器 `defineController({ debug: 'off' })`。
- **`actor new plugin --kind app|mail`**：两种骨架补齐（app = 生命周期与配置的行为测试；
  mail = `runMailTransportContract`），`--repo` 接线清单随之多一行"自证合规"。
- `@actor/mail` 新增 `assertSendable(message)`：发送前校验（没有收件人 / 头部注入），
  自定义 transport（走 HTTP API、不渲染邮件）据此堵住两个洞。
- `Application.modules` getter（与 `plugins` 同理：诊断类插件需要读模块级声明）。

### Added

**P1 错误出口**（`createApp(spec, { errors })`）—— 内核的后台失败此前对应用层**完全不可见**：

- 钩子：`onKernelLog`（40+ 内核事件原样透传）/ `onActorCrash`（强类型视图，带**声明名**）/
  `onDeadLetter` / `onSystemFailure` / `onHttpError`；
- Actor 级 `ActorSpec.onCrash`（**只通知，不干预监督**；声明了就会触发，不依赖是否配了 `errors`）；
- `app.deadLetters()` / `app.clearDeadLetters()`（装了 `deadLetters` 插件读落盘那份，否则读内存环）；
- 纪律写死：不注册钩子 = 不转发（默认静默）；**钩子抛错绝不影响内核**（有可证伪用例）。

**P2 统一日志**（`createApp(spec, { logging })`）—— 此前日志接缝各管一摊（内核 / HTTP / requestLog / tracing）：

- `logger`（函数式或 pino/winston/console 对象式）、`level`、`filter`/`exclude`（`*` 通配）、
  `levelOf`、`redactKeywords`、`context`、`framework`（框架自身日志开关）；
- 三类事件汇到一个出口：`app:*` / `kernel:*` / `http:*`（含 `http:request`、`http:access`、`http:error`）；
- `ctx.log` 与访问日志共用同一出口与同一份脱敏名单；给了 logger 时内核日志**不会重复**转发；
- 门禁：**库代码不许裸 `console`**（每个调用必须带 `// console-ok: <理由>`，含证伪用例）。

**P3 生成器**（`actor generate <kind>`，别名 `g`）：

- `controller` / `actor` / `service` / `model` / `schema` / `middleware` / `test` / `command` 八种骨架，
  每种都自带**能跑过**的测试；
- `--field k:type`（可重复）、`--optimistic-lock`、`--no-test`、`--dry-run`、`--force`；
- 布局跟随项目（layered/flat）；已存在文件**默认拒绝覆盖**；`module.ts` 接线**只打印片段**；
- 用例证据：生成后项目 `tsc --noEmit` 通过 + 生成的测试在真项目里跑过（12/12）。

**P4 自定义命令**：

- `defineCommand({ name, summary, usage, flags, run })` + 两处发现位置
  （`.actor/commands.ts` 集中声明、`.actor/commands/*.ts` 一文件一命令）；
- `actor commands [--json]` 列出（带来源）；`--help` 由 flags 声明自动生成；
- **子进程执行**（隔离：`process.exit` / 抛错 / 死循环不影响主 CLI；退出码原样透传、堆栈保留）；
- 与内置重名 / 重复定义 / `run` 不是函数 / 未知选项都**明确报错**（不静默）；
- `actor doctor` 新增"自定义命令"一节；`actor generate command <name>` 生成骨架。

**P4+ 三项收尾**：

- **持久化死信开箱可用**：[20 错误与日志](docs/guide/20-errors-and-logging.md) 增加
  `deadLettersPlugin({ path })` 的用法与"重启后仍读得到"的用例；
- **死信形状统一**：内核有两套形状（内存环 `{path,payload,error}` / 落盘队列 `{actorId,msg,reason}`），
  `app.deadLetters()` 现在统一成前者（导出 `normalizeDeadLetter`）；`clearDeadLetters()` 如实返回条数
  （装了插件时内存环为空，早先会返回 0）；
- **自定义命令支持 npm 包来源**：`node_modules/actor-command-*`，**但只认项目 `dependencies` 里
  声明的包或 `"actor": { "commands": [...] }` 显式列出的包**（未声明的包不加载，有用例守着边界）；
- **`actor generate migration <name>`**：生成 `src/migrations/<时间戳>-<名字>.ts`，
  版本号扫已有 `version:` 自动 +1（可用 `--migration-version` 指定），片段里给出要加进
  `src/migrations.ts` 的 import；模板按真实的 `MigrationContext`（只有 `store`/`log`）出签名。

### Fixed

- **命令发现用 `import()` 会被模块缓存命中**：同一进程里改过 `.actor/commands.ts` 后仍读旧内容
  （长驻进程/`doctor` 反复扫描会看到过期命令）。现在按文件 mtime 加缓存键。
- `parseArgs` 的 `--field` 等**可重复选项**此前只有最后一次生效（静默丢数据）；现在收成数组，
  且"给了 `--field` 但没有值"会明确报错。
- 生成的骨架测试里 `configDir: null` 与 `@ts-expect-error` 会造成 `tsc --noEmit` 报错；
  统一改成 `configDir: ''` 与正常写法。

### Docs

- **选型决策树 + 5 分钟改造演练**：
  - 概念页新增「三十秒决策树：用 Actor / 用仓储 / 直接 Express」（四问分流，含"更便宜的等价问法：
    读-改-写之间夹着 `await` 吗"）与「五分钟改造演练：把共享计数器搬进 Actor」
    （起点代码 → 第 1 步先复现丢账 → 认出这属于 Actor 的状态 → 把状态搬进 Actor（HTTP 层几乎不动）→
    加持久化 → verify 块把 A/B/C 三段跑一遍，确定性断言 `before=99 after=80 after-restart=80`）。
  - 官网「为什么选它」一节顶部加入同一棵决策树的纯 CSS 可视化（四问 + 三种出口），并链到演练锚点。
- **修复：文档站把"可执行示例"渲染成了正文文字** —— 围栏信息串只按单个单词匹配（`\w*`），
  于是 ` ```js verify ` 不匹配、整块被当普通段落渲染。**16 个页面**受影响（所有"CI 真执行"的示例块）。
  现在支持"语言 + 标记"两段（并给这类块加"✓ 本块在 CI 里真执行"的可见标记），
  同时支持**最多 3 空格缩进**的围栏（`examples/prometheus/README.md` 把代码块写在有序列表里，
  之前也漏成了正文）。两条都有回归门禁。
- **「什么是 Actor」入门口径 + 官网两节新增**：
  - 新概念页 [00 什么是 Actor](docs/guide/00-what-is-an-actor.md)（主线第一页）：三条规则（状态私有／
    消息串行／失败有归属）、`tell` 与 `ask` 的语义差别、**顺序保证到哪为止**（同 Actor 内 FIFO、
    跨 Actor 无全局顺序）、为什么"重启出干净实例"比 `try/catch` 继续更可靠、状态该放哪、四条常见误解、
    **什么时候不要用**；verify 块是一个**确定性**对照实验（裸共享状态 = 1、共享+手动串行 = 20、Actor = 20）。
  - 官网新增两节：「什么是 Actor（60 秒）」放在 hero 之后（三条承诺卡 + 上面那份对照实验的完整代码），
    「为什么选它 / 什么时候别选」放在能力卡之后（4 种基线做法 × 并发正确性/故障语义/状态放哪/主要代价
    的对比表 + 8 条差异化优势 + 5 条"不要用它"的边界）。
  - 对照实验的示例文件 `tools/landing/snippets/04-shared-vs-actor.ts` 既进 typecheck 又**每天真跑**
    （官网门禁断言页面上的代码与该文件逐字一致，所以页面上的数字就是真实输出）。
- **官网首页**（`site/index.html`）：由 `tools/landing/` 生成（不再是 README 的副本）——
  hero + 9 张能力卡 + 三段可跑代码（tab 切换）+ 工程纪律 + 12 个包的表 + 快速开始；
  样式/脚本**全部内联、零外部请求**（不加载 CDN/字体/追踪脚本，`file://` 直接打开也正常），
  支持深浅色（`?theme=dark|light` 可强制）。
- **官网自己的门禁**（`test/unit-site-landing.test.js`）：三段示例既进 typecheck 又**真跑**，
  并断言"页面里的代码 == 跑过的代码"（逐字比对，防止页面与示例漂移）；
  事实门禁断言页面上写的"零运行时依赖 / Node ≥ 24 / 12 个包 / 内核唯一可选依赖 classic-level"
  与仓库真实状态一致（数字过时会红，而不是继续骗人）；首页相对链接零断链。
- 文档页侧边栏新增"← 官网首页"入口；`site/index.html` 不再由 README 覆盖（README 仍有独立页面）。
- 新增 [20 错误与日志](docs/guide/20-errors-and-logging.md)（哪些失败会出现在哪、"同步 vs 后台"两条路径、
  钩子与统一日志的完整用法，带真跑示例）与 [21 CLI 进阶](docs/guide/21-cli-generate-and-commands.md)
  （八种骨架 + 自定义命令，两段 verify 块会真建项目跑一遍）。

**文档改版：`docs/guide/` 从"按里程碑顺序的开发文档"重建成"按用户任务组织"的使用文档。**

- 新的主线（`docs/guide/*.md`）：导航页 + `01 五分钟上手`（真跑脚手架、真起进程、真优雅停）
  + `02 项目结构` + `09 应用层语法糖` + `10 路由与请求` + `11 数据与 CRUD`（内存 SQLite 真建表真读写）
  + `12 Actor 与状态` + `13 鉴权` + `14 配置与密钥` + `15 实时与上传` + `16 邮件`
  + `17 测试` + `18 可观测与上线` + `19 排错手册`（按报错原文查）+ `reference/api.md`。
  每页都带**会被 CI 执行**的 `verify` 块（真起应用、真请求、真断言）。
- 旧的 17 篇按里程碑写的指南**原样搬进 `docs/guide/internals/`**（内容一字未改，只修相对链接），
  并配了子索引；文档门禁升级为"两层都查"：顶层主线必须被索引页全量链上，internals 必须有
  子索引且逐篇可达。
- 顺手修掉写文档时暴露的**三个真问题**（见下面 Fixed）。

### Fixed

- **路由前缀撞车不再静默**：模块/路由器路由落在 `/uploads`、`/__debug` 里会在**启动期报错**
  （此前会与框架插件路由**同时存在**，匹配到谁取决于声明顺序）；第三方插件声明保留前缀、
  两个插件声明同一前缀也会报错。
- `debugPlugin` 的默认路由改为**裸模式**（`/routes` 等）+ `defineWebPlugin({ routePrefix })`，
  修掉"前缀被套两次"（`/__debug/__debug/routes`）；`uploadPlugin` 同理（`/uploads/uploads/…`）。
- **保留服务名**改在**声明层**拦（插件名/provides/模块 provider 名撞保留名即报错）：
  运行时 `provide()` 分不清调用者，早先在那里拦会把框架插件自己（`httpServer`）也拒掉。
- `crudRoutes`：数组形式的 `fields: ['tags']` 之前会被当成"字符串默认值"，传数组进来直接 400；
  现在按"必填字符串字段"正确展开（要 `json` 就用对象形式 `{ tags: ['x'] }`）。
- `crudRoutes`：**乐观锁**参数（默认 `expectedVersion`）现在被自动声明为可选输入，并从写入字段里
  摘出来作为 `store.update(id, body, { expectedVersion })` 的第三参；数据层的
  `DbConflictError`/`RepositoryConflictError` 自动翻成 **409**（可用 `onConflict` 自定义）。
- `uploadPlugin`：缺 `storage` 时在**定义期**报错（此前留到第一个上传请求才 500）；
  `storage` 在类型上也标成必需。

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
  面向使用者的 8 篇指南（**带 `verify` 标记的示例**都会被测试执行）、CI 门禁与 GitHub Pages 部署。

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
