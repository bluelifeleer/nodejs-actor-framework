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
| 3 | **内核可注入时钟**（M0.2 的定时器原语）+ `@actor/testkit`：虚拟时钟 | 用虚拟时钟测"等 1 小时"的定时逻辑，**测试瞬时完成**；outbox/投影的轮询换成可注入定时器 | ✅ 3a（§6）；探针/故障注入待做 |
| 4 | HTTP 测试客户端 + **span 生命周期 + OTLP/HTTP 真实导出** + 日志适配 | 起真收集器断言 OTLP 形状；导出失败可见（计数 + 日志）；对象日志器可桥接 | ✅ §7 |
| 5 | CHANGELOG + 版本策略落地（`CHANGELOG.md` + 发布检查脚本） | `npm run release:check` 一条命令跑完发布前检查 | ✅ §8 |

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

## 6. 第 3 步（3a）：可注入时钟 + 虚拟时钟（已实现）

### 6.1 接缝设计

```ts
interface Clock {
  now(): number;
  setTimeout(cb, ms, options?: { unref?: boolean }): TimerHandle;
  clearTimeout(handle): void;
  setInterval(cb, ms, options?: { unref?: boolean }): TimerHandle;
  clearInterval(handle): void;
}
createSystem({ clock })   // 不传 = 真实时钟（生产路径完全不变）
ctx.clock                 // Actor 里读"现在"；ctx.sleep(ms) 等待（都走系统时钟）
```

**范围（刻意划的边界）**：时钟接管**纯逻辑定时**——`ask` 超时、限流令牌、`ctx.sleep`、停机超时、
数据层的轮询。**不接管网络 I/O 的等待**：真实 socket 必须配真实时间，所以网关连接超时、gossip 心跳
继续保持真实时钟。混用会得到"虚拟时钟推不动真实网络"的困惑，与其假装统一，不如把边界写在文档里。

`@actor/testkit` 的 `createVirtualClock()`：到期时间优先、同一时间按注册顺序（确定性）；
`advance(ms)` / `advanceTo(t)` / `drain()` / `runAll()`；单次推进有步数上限，**无限自调度会明确报错**
而不是把测试挂死。

### 6.2 这一步踩到的四个问题（都修在源头）

1. **两个时钟混用（令牌桶）**：桶用 `Date.now()` 初始化、系统用虚拟时钟 → `elapsedMs` 恒为 0，
   令牌永远不补充。**限流从此变成"永久卡住"**——只有在注入时钟时才会暴露。修法：桶的起点时间由
   调用方从系统时钟传入。
2. **`tryConsume()` 内部写死 `Date.now()`**：每次消费都把桶的时间戳**拽回真实时间**，
   于是虚拟时钟推进再多也没用。修法：`tryConsume(count, now)` 与 `msUntil` 用同一个时间来源。
3. **浮点累积**：按 0.1/次累加 10 次得到 `0.9999999999999999` → `msUntil` 返回 1ms，
   表现为"推进到整点还是没轮到"。修法：比较加 `1e-9` 的 epsilon（真实场景也不会为 1e-16 的缺口等待）。
4. **虚拟定时器与真实调度器的交界**：`advance()` 触发回调后，Actor 的续体、消息投递还要走真实
   任务队列。修法：`advance` 每触发一个定时器就让真实队列多跑几轮（`flushTurns`），并提供
   `drain()` 明确这个交界；使用规则两条——**advance 之前先 drain、停系统之前先推进**（都写进指南）。

### 6.3 与测试的关系

`docs/guide/06-testing.md` 里原先那条"诚实说明：还没有虚拟时钟（M0.2 未实现）"已经换成"它可用"，
并带一条**会被测试执行**的示例（`ask` 超时在 0 真实毫秒内触发 + 断言真实耗时 < 200ms）。
数据层 M3 文档 §9.3 里"轮询只能用 `setInterval`"的记录也一并更新为"已解决"。

## 7. 第 4 步：可观测性（已实现）

### 7.1 span 生命周期（这是"导出"的前提）

之前框架**只有 traceId/spanId 的上下文传播**，没有任何"span 开始/结束"——于是"导出到 OTel"无从谈起
（没有东西可导）。现在在**处理一条消息**的边界上开 span：名字 `actorPath:messageType`，
属性带 `actor.path` / `actor.message_type`，失败时 `status=error` + `error.type` / `error.message`，
结束时交给 `system.spanSink`。**没装 sink 时不创建 span**（热路径零开销）。

`system.spanSink` 是**结构型**接缝（任何 `{ onSpan(span) }`），所以想接官方 OTel SDK 不用改内核。

### 7.2 为什么自己写 OTLP 导出而不引 `@opentelemetry/*`

OTLP/HTTP+JSON 是**公开协议**：`POST <endpoint>/v1/traces`，body 是 `{ resourceSpans: [...] }`。
自己发一个 JSON 请求就能接上任何收集器，而内核保持零依赖。测试是**协议级**的：起一个真的 HTTP
收集器，断言收到的 body 形状（traceId 32 位十六进制、时间是纳秒字符串、status.code、属性…）——
形状错了收集器就收不下，这种错误在 mock 里最容易被放过。

失败**必须可见**：`otlp_export_failed` 日志 + `stats()` 的 `failed`/`dropped` 计数（不静默丢 span）。

### 7.3 日志适配

内核的日志接缝是**一个函数** `(event, meta) => void`（零依赖、零约定），`createLogAdapter()` 把
pino/winston/console 这类对象日志器桥接过来（级别默认按事件名猜，可覆盖）。另外每条日志**同时以事件
形式**发出（`system.on('log', …)`）——测试里断言日志用这个，不必假装成日志器。

### 7.4 HTTP 测试客户端

`createHttpClient(base)`：真请求、解析 JSON、`expect(status)` 失败时**把响应体带进错误**
（否则排查只能靠猜）。刻意不做 mock：起真服务测的是跨层契约（路由、校验、错误映射、状态码）。

### 7.5 这一步的两个"我以为对"的点

1. **`logger` 是函数不是对象**：测试里我传了 `{ warn(event, meta) }`，内核调用时抛错并被静默吞掉
   （"坏日志器不能影响 Actor"这条保护生效了）→ 断言日志改用 `system.on('log')`，并顺势做出日志适配器。
2. **span 是在"处理结束"后才交给 sink 的**：失败的 `ask` 会**先拒绝**、再走完 `finally`，
   所以断言前要让事件循环走一格——否则会看到"只导出了一个 span"。

## 8. 第 5 步：CHANGELOG 与发布检查（已实现）

### 8.1 版本策略（写进 `CHANGELOG.md` 的开头，先读那一节）

- **当前发布状态如实写**：只有 `nodejs-actor-framework`（内核，1.0.0）是可发布的；`@actor/app|web|data`
  是 0.1.0 **未标 private 但从未发布**（按 0.x 实验包对待）；`@actor/cli|testkit` 是 `private: true`。
  是否把 `@actor/*` 公开到 npm 是开放问题 **Q7**，在这条决定之前 **CHANGELOG 只对内核承诺兼容性**。
- 什么改动对应什么版本（新增可选能力 → minor；改默认值/签名/错误类型 → major；用户自己的消息契约不受约束）；
- 弃用流程三步（标 `@deprecated` → 升级警告 → 下个 major 移除并给迁移指南）；
- 新能力头两个 minor 标 `experimental`。

### 8.2 `npm run release:check`

一条命令：`npm run ci`（typecheck + 全量测试 + 文档站）+ 五项"发了会不会出事"的检查：

| 检查 | 拦什么 |
|---|---|
| 工作区测试矩阵 | 有 `test/` 的包必须出现在根 `npm test` 的 glob 里（**踩过**：新包忘了进矩阵，CI 根本没跑它） |
| `npm pack` 内容 | tarball 里**不能**有测试、fixtures、数据目录、凭据（`*.pem/key/crt`） |
| CHANGELOG 版本一致 | 要发布的版本（内核）必须在 CHANGELOG 里有条目——**没切版本就不许发** |
| `engines` 一致 | 所有包的 Node 下限与根一致（Node 下限只能有一个来源） |
| 工作区干净 | 发布从干净树出发（`--allow-dirty` 可显式跳过） |

每条检查都是**纯函数 + 可注入输入**，测试因此能验证"该拦会拦"（用注入的假数据），而不是只验证
"在好数据上通过"——**门禁自己不失败就没有意义**。

### 8.3 它立刻找出的两处真实不一致

1. **`engines` 不一致**：`core/app/web/data` 四个包都写 `>=20`，而根与 CLI/testkit 是 `>=24`
   ——源码直接跑 TS 且用 `node:sqlite`，`>=20` 是错的（和之前修根 `engines` 是同一类问题，
   只是这次是四个包各写了一遍）。已统一为 `>=24`。
2. **CHANGELOG 与真实发布状态不符**：我在 CHANGELOG 里写"`@actor/*` 都是 `private: true`"，
   实际 `app/web/data` **没有** private 标记（技术上可发布）。已按真实状态改写，并把
   "只对内核承诺兼容性"写成明确规则。

另外：`npm pack --dry-run` 会往 `$HOME/.npm` 写日志/缓存，在受限环境里不可写——检查里把 npm 的
日志与缓存目录指到工作区内的 `.tmp-npm/`，于是这条检查不依赖"家目录可写"这种无关前提。

### 8.4 与 CI 的关系

`release:check` **不进 CI**：它在"还没切版本"时会故意失败（这正是发布检查该拦的状态），
放进每次 PR 只会制造噪音。CI 跑的是 `npm run ci`（质量门禁），发布检查是**发布时**的那道门。
