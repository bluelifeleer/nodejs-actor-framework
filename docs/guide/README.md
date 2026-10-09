# 使用文档

**你是来用这个框架做东西的**，不是来读设计史的。所以这一页按"你要干什么"组织，
不按框架的开发顺序组织。

> 每条路径里的代码示例都会被 CI **真的执行**（`test/unit-docs-guides.test.js`），
> 所以照着抄不会遇到"文档说得对、跑起来报错"。

## 三条路，按你的处境选

| 你的处境 | 走这条路 | 花多久 |
|---|---|---|
| **第一次用，想先看到东西跑起来** | 01 五分钟上手 → 02 项目结构 | 10 分钟 |
| **已经能跑，要加某个功能** | 下面的「按任务查」表，直接跳 | 按需 |
| **手里有个具体问题/报错** | 19 排错手册（按报错原文查） | 1 分钟 |

## 按任务查：我该改哪

| 我要做的事 | 看这篇 | 你会拿到 |
|---|---|---|
| **先搞懂 Actor 是什么** | [00 什么是 Actor](./00-what-is-an-actor.md) | 三条规则（状态私有/消息串行/失败有归属）、顺序保证到哪为止、什么时候别用 |
| 起项目、跑起来、目录怎么分 | [01 五分钟上手](./01-quickstart.md)、[02 项目结构](./02-project-layout.md) | 一个能跑的项目 + "代码写哪个文件"的答案 |
| **每个环节到底该写哪一种** | [03 推荐写法与约定](./03-recommended-style.md) | 一张"就写这个"的表 + 等价写法的出口 |
| 加一个 HTTP 接口、校验参数、统一错误码 | [10 路由与请求](./10-http-routing.md) | 路由/输入校验/中间件/错误语义 |
| 建表、查库、做 CRUD API | [11 数据与 CRUD](./11-crud-database.md) | 表声明 → 迁移 → 仓储 → 五条路由 |
| 状态该放哪、怎么重启不丢 | [12 Actor 与状态](./12-actors-state.md) | "状态归 Actor"到底怎么落地 |
| 加登录、保护接口、角色 | [13 鉴权](./13-auth.md) | JWT、`ctx.user`、401/403、路由保护 |
| 配置项、环境变量、密钥 | [14 配置与密钥](./14-config-env.md) | 配置分层、env 命名、生产怎么给密钥 |
| WebSocket 推送、文件上传 | [15 实时与上传](./15-realtime-upload.md) | `wsPlugin` / `uploadPlugin` 两条路 |
| 发邮件 | [16 邮件](./16-mail.md) | `mailPlugin` + 自装 transport |
| 怎么测（含定时器不用真等） | [17 测试](./17-testing.md) | 用真内核测、虚拟时钟 |
| 上线：日志、健康检查、优雅停 | [18 可观测与上线](./18-observability-deploy.md) | 日志/诊断路由/停机/上线检查清单 |
| 想少写样板（可选） | [09 可选简写](./09-app-sugar.md) | 在推荐写法之上能省的几处；等价对照在 internals |
| **报错了，不知道为啥** | [19 排错手册](./19-troubleshooting.md) | 按报错原文查 → 原因 + 改法 |
| 让失败看得见：错误钩子、统一日志 | [20 错误与日志](./20-errors-and-logging.md) | `errors` / `logging` 一处配好，崩溃与死信不再静默 |
| 部署到服务器：直跑 `.ts` 还是编译成 JS | [22 部署与构建](./22-deploy-and-build.md) | 两条完整路线、Dockerfile、产物冒烟、选型速查 |
| 生成骨架、加自己的 CLI 命令 | [21 CLI 进阶](./21-cli-generate-and-commands.md) | `actor generate`（7 种骨架）与 `.actor/commands/` 自定义命令 |
| 查某个函数/类型 | [API 参考](./reference/api.md) | 自动从源码生成的导出清单 |

> 编号有跳（03–08 空缺）：那几位留给了**旧指南**（它们已在 `internals/` 里，编号沿用至今）。
> 主线是 `01/02` 上手 → `09` 语法糖 → `10–18` 按任务 → `19` 排错，跳号是为了**不打断旧链接**。

## 照着做的完整示例（比文档更可信的锚点）

仓库里有 **8 个能跑的项目**，每个都能 `npm test`。做类似的活时，直接抄它的结构最快：

| 示例 | 它演示什么 |
|---|---|
| [`examples/app-minimal`](../../examples/app-minimal/README.md) | 最小：一个 Actor + 一个 HTTP 接口 |
| [`examples/app-web`](../../examples/app-web/README.md) | HTTP 全套：CRUD、错误语义、优雅停 |
| [`examples/app-data`](../../examples/app-data/README.md) | 事件溯源聚合 + 投影 + 迁移门 |
| [`examples/app-db`](../../examples/app-db/README.md) | SQL 表 + 仓储 + 乐观锁 |
| [`examples/app-multi-db`](../../examples/app-multi-db/README.md) | 同时连多个库（多实例适配器） |
| [`examples/app-plugin`](../../examples/app-plugin/README.md) | 自己写一个插件（含契约套件） |
| [`examples/app-upload`](../../examples/app-upload/README.md) | 上传：流式 + 分片 + 断点续传 |
| [`examples/app-mail`](../../examples/app-mail/README.md) | 邮件：离线 `.eml` 与 SMTP |

## 术语表（读文档时卡住的词）

| 词 | 一句话 |
|---|---|
| **Actor** | 有状态、消息串行处理的对象；同一个 Actor 的消息不会并发 |
| **模块（module）** | 一组声明（providers + actors + routes）的打包单位，`defineModule` |
| **provider** | 依赖注入里的一个值/服务（数据库连接、仓储…），控制器用 `ctx.get('名字')` 取 |
| **受管资源（managed resource）** | 有生命周期（连/探活/关）的外部依赖：数据库、Redis、Mongo、邮件 |
| **控制器（controller）** | 一个 HTTP 处理函数 + 输入声明，无状态 |
| **声明式路由** | 路由写在模块里（`routes`/`router`），框架在**启动期**统一校验（重复、非法模式、输入来源） |
| **启动期失败** | 框架的默认姿态：配置/依赖/路由有问题就**拒绝启动**并说清怎么改，不留到运行期 |

## 这份文档之外的东西

| 你想看 | 去哪 |
|---|---|
| 某个函数/类型的签名与注释 | [API 参考](./reference/api.md)（从源码生成） |
| 为什么这么设计、当初权衡了什么 | [`docs/design/`](../design/)（维护者视角） |
| 按里程碑顺序写的旧指南（早期教程风格，仍有参考价值） | [`internals/`](./internals/)（开发/设计视角，不面向使用者） |
| 从旧运行时升级过来要改什么 | [迁移指南](../migration.md) |
| 版本变化 | [CHANGELOG](../../CHANGELOG.md) |

## 自己搭这份文档

```bash
npm run docs:serve      # 构建 + 起预览服务（默认 http://127.0.0.1:4321/）
npm run docs:build      # 只构建：docs/**/*.md → site/
```
