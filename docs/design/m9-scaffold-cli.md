# M9a 设计：脚手架与 CLI（layered 布局 / 能力选择 / `new plugin`）

> 用户已定的决策（本节即"设计记录"）：
> 1. 生成项目的**默认布局是 layered**（一个项目的业务面很多，全挤在扁平 `src/` 里不合理）；
> 2. 能力粒度：**`upload` / `auth` / `debug` 算 web 的插件选项**，不是独立包；其中 `debug` 要支持**全局/局部**设置；
> 3. **要做 `actor new plugin <name>`**；
> 4. 生成器与语法糖分两期做（本文件是生成器，语法糖见 `m9-define-sugar.md`）。

## 1. 现状（实测，不是印象）

| 资产 | 事实 |
|---|---|
| CLI 包 | `@actor/cli`（private、零依赖、`bin: actor`、Node 直跑 TS） |
| 命令 | `actor new app <dir> [--force] [--no-install]`、`actor migrate`、`actor doctor` |
| 模板 | **真实文件**在 `packages/cli/templates/app/`（10 个文件：`.gitignore`、`README.md`、`config/default.ts`、`main.ts`、`package.json`、`src/{app,module,notes,counter}.ts`、`test/app.test.ts`），随包发布（`files` 含 `templates`，有测试盯着） |
| 生成项目 | 依赖**固定** `@actor/app` + `@actor/data` + `@actor/web`；自带 4 条端到端测试（CRUD 201/200/409/204、Actor、重启后持久化、400/404/405） |
| 门禁 | `packages/cli/test/scaffold.test.ts`：文件清单、项目名替换、**拒绝覆盖非空目录**（`--force` 也不删用户文件）、缺目录报用法错误、**并且真的跑生成项目的 4 条测试（`pass 4`）** |
| 文档 | 指南 `docs/guide/00-scaffold.md`；设计 `docs/design/m5-cli-and-testkit.md`（其中提到 `actor new-plugin <name>`，**未实现**） |

**结论**：生成器不是"要不要做"，而是"从固定三件套 → 可选能力 + layered 布局 + 可增量加能力"。

## 2. 能力图：**从 package.json 推导，不人工维护**

能力 = 一个 `@actor/*` 包 + 若干**装配决策**。依赖闭包**不写死在 CLI 里**，而是：

- 仓库内：递归读各包的 `dependencies`（CLI 就在仓库里，读得到）；
- 对外发布：构建时把结果**固化成 `templates/capabilities.json`**，并有测试断言"固化结果 == 各包 package.json 的真实依赖"（否则闭包会烂掉）。

| 能力 | 包 | 闭包（自动推导） | 装配产出 |
|---|---|---|---|
| 内核 | `@actor/core` | 恒在、不可选 | 无需接线（`@actor/app` 会带它） |
| 应用装配 | `@actor/app` | core | `createApp`/配置/插件骨架 |
| HTTP | `@actor/web` | app | `httpPlugin` + 路由 |
| 数据 | `@actor/data` | （按 package.json） | 仓储/迁移接线 |
| SQL | `@actor/db`（+`@actor/db-core`） | data? 见 package.json | `databaseAdapter`/方言 |
| 缓存/队列 | `@actor/redis` | resource | `redisAdapter` 接线 |
| 文档库 | `@actor/mongodb` | resource | `mongoAdapter` + `defineCollection` |
| 邮件 | `@actor/mail` | resource | `mailPlugin` |
| **web 插件选项** | （不是包） | 需要 web | `--web-plugins upload,auth,debug` → 决定是否生成对应接线 + 配置节 + smoke 测试 |

**纪律**：默认**只生成你点名的能力**，不静默多给（现在的"固定三件套"恰恰是最不透明的形态）。

## 3. layered 目录契约（生成的形状）

```
my-app/
├── main.ts                 进程入口：信号注册、优雅停、退出码、启动日志（最薄的一层）
├── server.ts               应用装配：createApp(app) + 插件/模块接线，导出 http 实例（可被测试直接 import）
├── config/
│   ├── default.ts          配置定义（schema + 默认值）
│   └── production.ts       有就覆盖（APP_ENV=production）
├── src/
│   ├── controller/         web 控制器（notes.controller.ts）——与 defineController 对应
│   ├── actor/              actor 定义（counter.actor.ts）——与 defineActor 对应
│   ├── model/              领域类型 + 映射（Row ↔ 领域对象、版本字段、校验）
│   ├── schema/             数据层声明（表/索引/演进意图，迁移由 migrate 命令接管）
│   ├── service/            跨模块逻辑与适配器装配（避免往控制器里塞业务）
│   └── module.ts           模块声明：把上面这些挂进应用（providers/actors/routes/middleware）
├── test/
│   ├── api.test.ts         端到端（HTTP 语义）
│   └── persistence.test.ts 重启后仍能读回
├── package.json  tsconfig.json  .gitignore  README.md
└── data/                   （运行时产生；.gitignore）
```

**分工写死**（避免"到底该放哪"的争论）：`main.ts` 只做进程级的事；`server.ts` 只做装配；业务在 `src/`。
`--layout flat` 保留现在的形状（老项目/最小例子用），但**默认 layered**。

**硬门禁（沿用既有资产）**：生成的任何组合都必须 `typecheck` 通过、自带测试全过、能启动并优雅停。
模板文件是真实文件、随包发布，清单有测试盯着 —— 这条不许退化。

## 4. CLI 面（新增/变更）

```bash
actor new app <dir> [--layout layered|flat] [--with web,data,redis,mail]
                    [--web-plugins upload,auth,debug] [--dry-run] [--force] [--no-install]
actor add <capability> [--web-plugin <name>] [--dry-run]     # 给已有项目加能力（非破坏性）
actor new plugin <name> [--kind app|web|resource|mail]       # 生成插件包骨架（见 §5）
actor doctor                                                  # 扩展现有检查（见 §6）
actor migrate                                                 # 不变
```

- **`--dry-run`**：打印"将创建/将修改"的完整计划，一个字节都不写（脚手架的信任成本最低化）。
- **非破坏性**：`add` 只做增量；凡是需要人手工合并的位置（例如 `server.ts` 里插件数组），**明确打印出来**，不尝试智能改写。
- **离线**：`--install` 才动网络；默认 `--no-install` 只打印 `npm install` 命令（本仓库 CI 也离线）。
- **版本对齐**：生成的 `@actor/*` 依赖版本取自 CLI 自身版本（单一来源），不手写。

## 5. `actor new plugin <name>`（用户明确要求）

生成一个**能自证合规**的插件包骨架 —— 关键是复用框架**已发布**的契约套件（它们就在各包 `src/` 里，随包发布）：

| `--kind` | 骨架内容 | 自证方式 |
|---|---|---|
| `app` | `definePlugin` 骨架（配置节 + setup/onReady/onStopping/teardown + 一个服务） | 生命周期/配置断言测试 |
| `web` | `defineWebPlugin`（routes + 带阶段中间件 + ctx 扩展槽） | **`runWebPluginContract`**（已发布） |
| `resource` | `defineResourceAdapter` 骨架（connect/healthCheck/keepAlive/close/stats） | **`runManagedResourceContract`**（已发布） |
| `mail` | `defineMailTransport` 骨架 | **`runMailTransportContract`**（已发布） |

每种骨架都带：`package.json`（只依赖它真正需要的 `@actor/*`）、`src/index.ts`、`test/contract.test.ts`（跑上面那套契约）、`README.md`、`tsconfig.json`；**仓库内模式**额外生成"矩阵接线清单"（根 `npm test` glob / `tsconfig.json` include / `docs-site.mjs` PACKAGES / 导出基线），因为漏一处就会让新包不进 CI（M8a0 时我自己踩过）。

## 6. `doctor` 扩展：把"声明了能力但没接上"变成可诊断项

现有检查：Node 版本、依赖声明、期望文件、配置、数据目录。新增：

- **能力一致性**：`package.json` 里有 `@actor/redis` 但 `server.ts` 没有 `redisAdapter` 接线 / 配置节缺 `plugins.redis.*` → 报出来（含"下一步怎么办"）；
- **布局一致性**：layered 项目里出现 `src/*.controller.ts` 这类"放错层"的文件 → 提示（不擅自改）；
- **模板漂移**：项目里的 `main.ts` 与本版本模板 diff（提示"模板已更新，可参考"— 不做自动改）。

## 7. 测试与门禁（生成器不腐化的核心）

| 门禁 | 内容 |
|---|---|
| 组合矩阵 | 每个能力**单开** + 一个 `--with web,data,db,redis,mongodb,mail` **全开** + 每种 web 插件组合（至少 upload / auth / debug / 全开）：生成 → **typecheck** → **跑生成项目自带测试** → **启动冒烟**（打印监听地址后 SIGTERM 优雅停） |
| 模板清单 | 文件集合与 `files` 字段（模板必须随包发布） |
| 非破坏性 | 非空目录拒绝、`--force` 不删用户文件、`--dry-run` 不落盘、`add` 不改动无关文件 |
| 闭包正确性 | `capabilities.json` == 各包 `package.json` 依赖的真实闭包 |
| 指南 | `docs/guide/00-scaffold.md` 的 verify 块**跑同一份模板**（指南与模板不能两处真相） |

## 8. 风险与明确不做

- **风险：模板 × 指南 × 示例三处漂移** → 缓解：上面那条"指南 verify 块跑同一模板"+ 组合矩阵。
- **风险：`add` 的智能改写翻车** → 缓解：只做增量与"打印待手工合并处"，绝不猜测重写用户代码。
- **不做**：`--template` 的花哨预设（几十种 starter）✗、自动 `git init`/提交 ✗、联网拉取远程模板 ✗、
  `routesFromDir` 式的目录自动扫描（属语法糖期，且倾向不做）✗。

## 9. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| **M9a** | layered 模板 + `--layout` + 组合矩阵门禁（先不加能力选择，把布局做扎实） | 生成 layered 项目 typecheck + 自带测试全过 + 冒烟；flat 仍可用 |
| **M9b** | 能力选择 `--with` + `capabilities.json` 闭包 + `--web-plugins` + 每能力的 smoke 测试 | 组合矩阵全绿（含"全开"） |
| **M9c** | `actor add` + `doctor` 扩展 + `--dry-run` | `add` 非破坏性用例；doctor 能诊断"声明未接线" |
| **M9d** | `actor new plugin <name> --kind …` + 仓库内矩阵接线清单 | 生成四种骨架，各自跑通对应契约套件 |

## 10. 仍待你确认（小问题，不阻塞 M9a）

1. `server.ts` 这个名字可以吗？（备选：`bootstrap.ts` / 保持现在的 `src/app.ts`）
2. `data/` 与 `src/schema/` 的边界：`data/` 只放运行期产物，`src/schema/` 放声明 —— 同意吗？
3. `--web-plugins debug` 的"全局/局部"具体形态，见 `m9-define-sugar.md` §6（我给了推荐模型，需要你确认作用域粒度）。
