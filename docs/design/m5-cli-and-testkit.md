# M5 实施：产品化（CLI · TestKit · 发布纪律）

> 目标与验收见 `06-roadmap-and-nongoals.md` 的 M5 行。本文是**实施计划与决策记录**。
> 已经完成的：文档站与 API 参考（`tools/docs-site.mjs`）、CI 门禁与 Pages 部署、6 篇面向使用者的指南。

## 1. 现状与缺口（已核实）

| 能力 | 现状 |
|---|---|
| 文档站 + API 参考 | ✅ `npm run docs:build`（零依赖，断链门禁） |
| CI / 发布检查的前提 | ✅ `npm run ci`（typecheck + 全量测试 + 文档站）已在 GitHub Actions 上跑 |
| 面向使用者的指南 | ✅ `docs/guide/*`（每个示例都被测试真跑） |
| **CLI**（`actor new app` / `migrate` / `doctor`） | ❌ **完全没有**（`actor-main.js` 是演示用运维节点，不是 CLI） |
| **TestKit**（虚拟时钟 / 探针 / 故障注入） | ❌ 没有；内核也**没有可注入时钟**（M0.2 未实现），这是好几处"只能轮询"的根因 |
| OTel 真实导出 / 日志适配 | ❌ 指标与追踪插件是自研最小实现 |
| CHANGELOG / 版本策略 | ❌ 没有 CHANGELOG；版本策略只有 `06` 第 2 节的文字规定 |

## 2. 分步计划

| 步 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **1** | **CLI 骨架 + `actor new app <dir>`**：零依赖参数解析、模板文件、拒绝覆盖非空目录 | 生成的项目**真的能跑**：自带 4 条端到端用例（CRUD 201/200/409/204、Actor、**重启后持久化**、400/404/405）全过 | ✅ §4 |
| 2 | `actor migrate status\|up\|down`（对接数据层迁移框架）+ `actor doctor`（Node/依赖/配置/数据目录/迁移/端口） | 迁移态与"有未应用迁移就拒绝启动"一致；doctor 每项失败都给下一步；`status` 有待处理时退出码 2 | ✅ §5 |
| 3 | **内核可注入时钟**（M0.2 的定时器原语）+ `@actor/testkit`：虚拟时钟、探针、故障注入 | 用虚拟时钟测"等 1 小时"的定时逻辑，**测试瞬时完成**；outbox/投影的轮询可换成可注入定时器 | — |
| 4 | HTTP 测试工具（TestKit 的一部分）+ OTel 真实导出（可选依赖，缺失时明确降级） | 起真 HTTP 断言状态码/头/JSON；OTel 缺依赖时日志说清楚而不是静默 | — |
| 5 | CHANGELOG + 版本策略落地（`CHANGELOG.md` + 发布检查清单脚本） | `npm run release:check` 一条命令跑完发布前检查 | — |

## 3. 第 1 步设计：CLI 与脚手架

### 3.1 命令面（零依赖，不用 commander/yargs）

```
actor new app <dir> [--force] [--no-install]   # 生成可运行骨架
actor migrate <status|up|down> [--dir <path>]  # 第 2 步
actor doctor [--dir <path>]                    # 第 2 步
actor --help | --version
```

约定：**退出码有意义**（0 成功 / 1 用法错误 / 2 环境或用户操作问题），错误写 stderr 且给出**下一步该做什么**，
不打印堆栈（除非 `--debug`）。与仓库其它工具一样：**零依赖、Node 直接跑 TS**。

### 3.2 模板：真实文件（设计时想内嵌，实现后改了）

最初打算把模板**内嵌成字符串**（少一层文件系统假设）。实现时发现代价不对：内嵌意味着生成的
代码里不能出现模板字面量和反引号——**而骨架是给人读的**，不该为了模板机制把代码写变形。
所以改成 `packages/cli/templates/app/` 下的真实文件，并加一条测试盯着"`files` 字段必须包含
`templates`"（`npm pack` 漏带模板是这类脚手架的经典事故）。

生成内容（对齐 M5 验收的"CRUD + Actor + 持久化 + 测试"）：

```
<dir>/
├── package.json          # 依赖 @actor/* + scripts: start / test
├── config/default.ts     # defineConfig：端口与数据目录
├── main.ts               # 迁移门 → start() → 打印地址；SIGTERM 优雅停止
├── src/
│   ├── notes.ts          # CRUD 控制器（仓储 + 游标分页 + 乐观锁 → 409）
│   ├── counter.ts        # Actor + 持久化（快照），演示"写路径走 Actor"
│   ├── module.ts         # defineModule：providers + actors + routes
│   └── app.ts            # defineApp：配置/模块/插件
└── test/app.test.ts      # 真 HTTP 端到端（node:test）：201 → 200 → 409
```

**拒绝覆盖**：目标目录存在且非空 → 报错并提示 `--force`（脚手架最怕的就是"手一抖把项目覆盖了"）。

### 3.3 验收（可执行）

`packages/cli/test/scaffold.test.ts`：在仓库内生成 → **启动生成的项目**（真子进程）→ 断言
`POST /notes` 201、`GET /notes` 200、`PATCH` 过期版本号 409 → 重启进程 → 数据仍在 →
再跑生成项目自带的 `npm test` 通过。生成目录在仓库内，所以 `@actor/*` 通过 workspace 链接解析得到。

### 3.4 边界（先说清楚）

- 脚手架**不装依赖**（`--no-install` 是默认行为的一部分说明）：仓库内测试用 workspace 链接，
  真实用户 `cd <dir> && npm install`（`--install` 可选，第 2 步加）。
- 生成的骨架**不做**认证、日志适配、指标——那是"你的应用"的事，骨架只保证**跑得起来且结构正确**。

## 4. 第 1 步：CLI 与脚手架（已实现）

`packages/cli`（`@actor/cli`，零依赖）：

```
actor new app <dir> [--force]   ✅ 已实现
actor --help / --version        ✅ 已实现
actor migrate status|up|down    ⏳ 第 2 步
actor doctor                    ⏳ 第 2 步
```

**验收是 M5 里写死的那条**："新人按文档在 30 分钟内跑通 CRUD + Actor + 持久化 + 测试"。
落地方式：`packages/cli/test/scaffold.test.ts` 生成项目后**真的在生成目录里跑 `npm test`**，
断言它自带 4 条用例全过（含一条真的重启应用验证持久化）。生成目录放在仓库内，`@actor/*` 通过
workspace 链接解析——不需要联网装依赖。

### 4.1 这一步踩到的三个坑（都是"看起来对"的）

1. **快照持久化的契约是 `this.state`**：模板第一版把状态放在 `this.count`，单进程测试全绿，
   **真重启后归零**（`{"count":7}` → `{"count":0}`）。只有"停掉再起一个实例"才能抓到，
   所以生成项目自带的那条重启用例不是装饰。
2. **模板里的死配置**：`config/default.ts` 里声明了 `port`，但 HTTP 端口属于**插件**配置
   （`plugins.http.port` / `APP_PLUGINS__HTTP__PORT`）——自己声明一个没人读的字段，
   用户会以为它有效。已删掉并在注释里说明。
3. **孙进程测试输出被吞**：在测试里跑"生成项目的 `npm test`"，只看到 npm 的 banner——
   因为 `node --test` 会把 `NODE_TEST_CONTEXT` 传给子进程，孙进程以为自己在父运行器里，
   输出被接管。清掉该变量即可（测试里写明了原因）。

顺带：根 `npm test` 的 glob 一开始**没包含 `packages/cli/test/*.test.ts`**——新包的测试不会在
CI 里跑。已加入（这类"新包忘了进测试矩阵"是很容易漏的，值得每次加包时检查一次）。

## 5. 第 2 步：`migrate` 与 `doctor`（已实现）

**不重复实现迁移逻辑**：版本表、幂等、中断可重入、"数据比代码新"都在 `@actor/data` 的
`createMigrationRunner` 里；CLI 只负责找到项目、找到迁移、把结果讲清楚。

| 命令 | 行为 |
|---|---|
| `migrate status` | 打印已应用/待应用/中断/"数据比代码新"；**有待处理时退出码 2**（CI 与启动脚本当门禁用）；`--json` 给脚本 |
| `migrate up` | 幂等应用；打印本次应用了哪些版本 |
| `migrate down --to <v>` | **必须显式给 `--to`**：CLI 绝不猜"回滚到哪"；缺 down() 的迁移会明确报错（前滚而不是回滚） |
| `doctor` | Node 版本（对齐 `engines`）、依赖声明（用户项目不该直接依赖内核）、关键文件、配置能否加载（真的 import 项目文件）、数据目录可写、迁移状态、端口能否监听；每项失败都给"→ 下一步做什么"，有问题退出码 2 |

**项目定位**（`src/project/load.ts`）：只在**约定位置**找东西（`package.json` / `config/default.ts` /
`src/migrations.ts` / 数据目录 `--data` > `APP_DATA_DIR` > `<dir>/data`），找不到就说清"我期待什么、
你在哪"。刻意**不向上找** `package.json`——跑到父目录去动别人的项目比报错更糟。

### 5.1 这一步踩到的两个问题

1. **`MigrationStatus.pending` 与同类字段类型不一致**：`applied` / `interrupted` / `unknown` 是版本号
   数组，`pending` 却是**迁移对象**数组——CLI 打印"待应用"时输出 `v[object Object]` 才暴露出来。
   已统一成版本号数组（要详情的话，调用方本来就持有自己传进去的那个数组），并加了一条"四个字段都是
   number[]"的回归测试。
2. **提示只对 `UsageError` 打印**：`ProjectError`（目录不存在、迁移导出有问题）带 hint 却没输出，
   用户只看到一行错误、不知道该干什么。现在任何带 `hint` 的错误都会打印"提示：…"。
