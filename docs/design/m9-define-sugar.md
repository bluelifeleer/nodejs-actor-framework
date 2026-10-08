# M9b 设计：应用层语法糖（短名 + 参数简写 + 工厂）

> 用户已定的决策：
> 1. **内核不加糖**（`@actor/core` 的 `defineActor` 等保持原样）—— 糖的意义是**弥合应用层**；
> 2. 风格就是你举的样子：`defineController` → `controller`、`defineModel` → `model`（短名）；
> 3. 先写设计文档，再依次实施。

## 1. 现状：全仓库 19 个 `define*`（实测）

```
defineActor defineAggregate defineApp defineCollection defineConfig defineController
defineEventSchema defineEvolution defineMailTransport defineManagedResource defineMiddleware
defineModel defineModule definePlugin defineResourceAdapter defineRouter defineRoutes
defineUploadStorage defineWebPlugin
```

两个关键观察（决定了糖该怎么做）：

1. **其中好几个是恒等函数**（`definePlugin`/`defineRoutes`/`defineMiddleware` 只做类型标记）→
   所以"再加一层名字"没用，**有用的是把名字变短、把参数变少**；
2. **`@actor/web` 已经同时导出 `routes()`（路由构建器）与 `defineRoutes()`** →
   "两套方言"的苗头已经出现。所以本设计**不只是加短名，还要收口命名**。

## 2. 命名政策（先立规矩，再加糖）

1. **每个概念只有一个规范名（canonical），另一个是别名（alias）** —— 别名与规范名**同一个对象**，
   有测试断言 `alias === canonical`（沿用 M8a0 "别名保形"的做法）。
2. **规范名 = 短名**（应用层）；`defineXxx` 保留为**永久别名**（老代码、文档、教程都不用改）。
   *理由*：短名是新代码推荐写法；但"让 `defineRoutes` 与 `routes` 谁是真身"这种问题必须有唯一答案。
3. **内核不参与**（`@actor/core` 的 `defineActor` 等不加短名）—— 与用户决策一致。
4. **大小写：一律小写（已确认）**。函数名统一 camelCase —— `model()` / `controller()` / `routes()` / `config()` /
   `module()` / `plugin()` / `middleware()` / `router()` / `webPlugin()` / `uploadStorage()` / `collection()` /
   `aggregate()` / `eventSchema()` / `evolution()` / `mailTransport()` / `managedResource()`
   （最后这个按同一规则补：`defineManagedResource` 也要短名；而 `defineResourceAdapter` 的候选短名
   `resourceAdapter` **已被占用** —— 同名的插件装载函数 —— 所以它没有短名，与 `routes` 同类，如实标注）。
   理由：`Model` 在 `@actor/db` 里**已经是类型名**（`packages/db/src/model.ts:135`、`packages/db/src/index.d.ts:362`），
   值/类型同名会让 `import { Model }` 含义含糊；而且**一致性**要求所有短名同一风格。

   两处澄清（你举的例子里有 `actor` / `schema`，但应用层没有对应物）：
   - **`actor`**：`defineActor` 在**内核**（`@actor/core`），而内核不加糖（已定）；应用层没有独立的"注册 actor"入口
     （actor 通过 `defineModule({ actors: { … } })` 注册），所以**不存在** `actor()` 短名。若将来要给模块里的
     actor 注册加糖，那应该是 `module()` 的**参数简写**（属 T2），而不是新造 `actor()`。
   - **`schema`**：19 个 `define*` 里**没有** `defineSchema` —— 数据层声明是 `defineModel`（db）与
     `defineAggregate`/`defineEventSchema`/`defineEvolution`（data），所以 `schema()` 也不存在；
     脚手架里的 `src/schema/` 是**目录**名，保持小写（现状即如此）。
   两条都只是把"小写一致性"落到**真实存在的短名**上，不为整齐造名字。

## 3. 短名映射表（含**冲突审计**，基于实测的现有导出）

| 规范短名 | 别名（保留） | 所在包 | 冲突审计（实测） |
|---|---|---|---|
| `app()` | `defineApp` | `@actor/app` | ✅ 空闲（app 包现有导出里没有 `app`） |
| `config()` | `defineConfig` | `@actor/app` | ✅ 空闲（`ctx.config` 是属性，不冲突） |
| `module()` | `defineModule` | `@actor/app` | ✅ 空闲（`module` 不是保留字，ESM 里安全） |
| `plugin()` | `definePlugin` | `@actor/app` | ✅ 空闲 |
| `controller()` | `defineController` | `@actor/web` | ✅ 空闲 |
| `router()` | `defineRouter` | `@actor/web` | ✅ 空闲 |
| `middleware()` | `defineMiddleware` | `@actor/web` | ✅ 空闲 |
| `routes()` | `defineRoutes` | `@actor/web` | ⚠️ **已被占用**（现有路由构建器）→ 收口：`routes()` 为规范名，`defineRoutes` 变别名 |
| `webPlugin()` | `defineWebPlugin` | `@actor/web` | ✅ 空闲 |
| `uploadStorage()` | `defineUploadStorage` | `@actor/web` | ✅ 空闲 |
| `model()` | `defineModel` | `@actor/db` | ⚠️ `Model` 类型已存在 → 用**小写** `model()` |
| `collection()` | `defineCollection` | `@actor/mongodb` | ✅ 空闲 |
| `aggregate()` | `defineAggregate` | `@actor/data` | ✅ 空闲 |
| `eventSchema()` | `defineEventSchema` | `@actor/data` | ✅ 空闲 |
| `evolution()` | `defineEvolution` | `@actor/data` | ✅ 空闲 |
| `mailTransport()` | `defineMailTransport` | `@actor/mail` | ✅ 空闲 |
| `resourceAdapter()` | `defineResourceAdapter` | `@actor/resource` | ✅ 已经是短名（无需再加） |

**明确不加糖**：内核的 `defineActor`（用户决策）；已经够短的工厂
（`httpPlugin`/`wsPlugin`/`metricsPlugin`/`uploadPlugin`/`authPlugin`/`debugPlugin`/`mailPlugin`/
`redisAdapter`/`databaseAdapter`/`localDiskStorage`/`diskChunkStore`/`fileTransport`/`smtpTransport`）。
再加只会多一套方言。

## 4. 三层糖（按"弥合应用层"的价值排序）

### T1｜短名别名（零风险，纯 `alias === canonical`）
见 §3。**成本**：应用层包里加导出；`@actor/core`/`db`/`resource`/`mongodb`/`mail` 若要加还需同步
手写 `.d.ts`（已知有 `.d.ts` 的包：core、db、db-core、resource、redis、mongodb；app、web、mail **没有** →
所以短名放在 app/web/mail 最便宜；`db`/`mongodb` 的短名要连带补声明面）。

### T2｜参数简写（真正省掉样板的地方）
| 糖 | before → after | 说明 |
|---|---|---|
| **配置默认值即 schema** | `defineConfig({ port: { type:'number', default:3000 } })` → `config({ port: 3000, name: 'app' })` | 从值推 `{type, default}`；需要 env 映射/校验/`min` 时仍写全量对象；两种可混用 |
| **输入声明合一** | `body: ['filename','size']` + `input: { filename:{type:'string'}, size:{type:'number'} }` → `input: { filename: 'string', size: 'int' }`（**默认来自 body**） | 字符串简写展开；要 query/params 就写全量 `{ from:'query', type:'string' }`；既有的"键必须声明来源"校验保留 |
| **中间件阶段简写** | `{ handler, phase: 'auth' }` → `auth((ctx, next) => …)`（阶段即函数名） | 覆盖 pre/auth/parse/handler/post/error 六个 |

### T3｜工厂糖（消灭成规模的重复）
| 糖 | 替代什么 | 证据 |
|---|---|---|
| **`runApp(app, { configDir, port })`** | **8 个示例各写了一遍** `main.ts` 的信号注册/超时/优雅停/退出码样板 | 实测：`grep -l "stopped gracefully" examples/*/main.ts` = 8 |
| **`crudRoutes(prefix, model, opts)`** | list/get/create/update/delete 五条路由 + input + 404/409 + 分页 | 生成的项目与文档里 CRUD 反复出现 |
| `healthRoutes()` | `/health` + 受管资源聚合（复用 `debugPlugin` 的 health 形状） | 小 |

> **Actor 层不做糖**（内核不参与，用户已定）。若以后要，先读 `ActorDefinitionInput` 的现状再谈。

## 5. 等价性与门禁（这是糖能被信任的前提）

| 门禁 | 内容 |
|---|---|
| **别名恒等** | `alias === canonical`（同一对象/函数），逐条断言 |
| **行为等价（可证伪）** | 糖产出的对象与长名产出**深比较相等**（例如 `controller({input:{a:'string'}})` 产出的 spec 必须 `deepEqual` 手写全量的结果） |
| **导出基线只增不减** | 复用 M8a0 建立的 `test/unit-package-surfaces.test.js`（新短名进基线） |
| **声明面** | 有手写 `.d.ts` 的包（core/db/db-core/resource/redis/mongodb）必须同步；surface 门禁会盯 |
| **文档** | 指南里**同一段 verify 块同时跑两种写法并断言相等**（保证文档不会只教一种而另一种悄悄坏掉） |
| **旧写法不退化** | 全量既有测试不许改（除断言短名新增的部分） |

## 6. `debug` 的**全局 / 局部**（用户明确要求；放这里一并设计）

现状：`debugPlugin({ enabled, token })` 是**全局**的（挂 `/__debug/*`）。

推荐模型 —— **可见性作用域 + 继承**（**四层**，默认 `inherit`；用户已确认粒度）：

| 层 | 写法 | 效果 |
|---|---|---|
| 全局 | `debugPlugin({ enabled: true, token, expose: { hidePrefixes: ['/internal'] } })` | 挂 `/__debug/*`（默认关闭、需 token、生产拒绝启动，维持 M8d 三层门禁）；`hidePrefixes` 里的前缀不出现在诊断输出里 |
| 路由前缀 | 全局 `expose.hidePrefixes`，模块上可叠加 `defineModule({ debug: { hidePrefixes: [...] } })` | 按**前缀**批量隐藏（如 `/internal/*`、`/admin/*`），比一条条标 `debug:'off'` 省事 |
| 模块 | `defineModule({ debug: { expose: false } })` | 该模块的路由**不出现在** `/__debug/routes`；其配置节在 `/__debug/config` 里打码到只剩"已设置" |
| 控制器 | `defineController({ debug: 'off' })` | 该条路由不出现在 `/__debug/routes`（内部端点用） |

**语义边界（必须写在文档里）**：`debug` 作用域只影响**诊断输出里暴露什么**，
**不影响路由是否可用、也不改变鉴权** —— 它是"减少信息面"，不是安全边界；真正的门是 token + 生产拒绝启动。
（把"隐藏"当安全用是常见误解，这条要显式写清。）

## 7. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| **M9e** | T1 短名 + `runApp` + 别名恒等/行为等价门禁 + 指南改推荐写法 | 别名断言全绿；**8 个示例的 main.ts 收敛到 `runApp`**（示例冒烟不变） |
| **M9f** | T2 参数简写（config 值即 schema / 输入合一 / 阶段函数） | 行为等价断言；既有全量测试不改 |
| **M9g** | T3 `crudRoutes` + `healthRoutes` + debug 全局/局部作用域 | 生成项目的 CRUD 测试仍全过；`/__debug/routes` 可见性用例（模块/控制器两层各一条） |

> 顺序理由：T1/T3 的 `runApp` 是**立刻见效**且风险最低的；debug 作用域依赖 `defineModule`/`defineController`
> 的 spec 扩展（与 T2 的输入简写有交集），放最后。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 短名与既有导出/类型冲突 | §3 的冲突审计表；`Model` → `model()`；实施前对每个名字再跑一次导出清单核对 |
| 两套方言长期并存 | 政策 §2：短名是规范名、`defineX` 是永久别名，指南统一推荐短名；有"别名恒等"测试 |
| 糖与长名行为漂移 | "行为等价"深比较门禁（可证伪） |
| 文档只教一种写法 | 指南 verify 块同时跑两种并断言相等 |
| 内核被顺手加糖 | 明确列出"内核不参与"，并在 review 时按包核对 |

## 8.5 保留名与冲突检测（用户提出：短名都是常见词，要不要做"用户定义 vs 框架关键字"的一致性校验）

**结论：要做，但只做"编译器挡不住"的那一层。** 分三档，别越界：

| 档 | 谁管 | 做法 |
|---|---|---|
| ① 重复标识符 / 同作用域 shadowing（`import { config }` + `const config`） | **TypeScript 编译器** | **不重复做** —— `tsc` 已经会报，框架再查只会重复噪音 |
| ② **框架保留位**（service 名、路由前缀、`ctx` 保留键、插件名） | **框架（启动期，明确报错）** | 现状**部分覆盖**：插件/provider/Actor 重名与服务重复注册**已经大声报错**（`assembly.ts`）；缺的是**保留键的单一来源 + 校验**（见下） |
| ③ 用户代码里与**短名同名**的顶层声明（`export const model`） | **doctor（warning，启发式）** | 正则扫 `src/**/*.ts` 的顶层声明，命中短名清单就提示"import 时会撞车，建议改名或 `import { model as m }`"；**只警告、不作为 CI 失败条件** |

**② 里的一个真洞（已核实，必须修）**：
`packages/web/src/controller.ts` 会写 `ctx.state.route = spec`（authPlugin 靠它读控制器的 `auth: { required }`），
但 `CORE_CONTEXT_KEYS`（`packages/web/src/context.ts`）里**没有 `route`** →
任何插件/中间件执行 `ctx.extend({ route: ... })` 都会**静默覆盖**它，auth 随后读到错的声明。**编译器完全挡不住**。
修法（比"事后检测"彻底）：把这类框架内部槽改成**不可能被撞的键**（如 `ctx.state['@actor/route']`，或干脆用 symbol），
同时把保留键清单补全（`route` 先兜底进 `CORE_CONTEXT_KEYS`）。

**②的实际缺口（已核实，避免重复造门禁）**：

- **service 名这一半已经有人管**：`packages/app/src/assembly.ts` 里 `app.provide` 重复注册会**抛错**
  （"服务 'x' 被重复注册"），内置插件也只提供 `httpServer` / `wsConnections` 两个名字
  → 所以"服务名撞保留名"这件事**已经是响亮失败**，不需要再加一层；
- **只剩"路由前缀"这一半**：内置插件占用的前缀（`/uploads`、`/__debug`，以及 ws 的升级路径）
  与用户插件/路由撞车时，目前**没有专门校验**（路由表检查的是模式重复，不是"与框架保留前缀撞车"）。
  这一半才需要做，且做法与 M9b 的能力闭包同构：**单一来源清单 + 一致性门禁** ——
  `@actor/web` 导出 `RESERVED_ROUTE_PREFIXES`，并有一条测试断言"内置插件实际占用的前缀 ⊆ 这份清单"
  （否则清单会与实现分叉），然后在装配期对撞车**明确报错**（延续"响亮失败优于静默覆盖"）。

**②的落地形态**：
- `@actor/web` / `@actor/app` 导出**单一来源**的保留名常量（`RESERVED_CONTEXT_KEYS` / `RESERVED_SERVICE_NAMES` /
  `RESERVED_ROUTE_PREFIXES`），文档与门禁都读它；
- 启动期校验：插件注册的服务名、插件贡献的路由前缀、`ctx.extend` 的键，撞上保留名一律**报错并说清"下一步"**
  （延续"响亮失败优于静默覆盖"）。

**③的诚实边界**：本仓库的工具链是**文本/正则**的（`typescript@7` 原生端口**没有 JS API**，M8 已确认），
所以它只能是**启发式**（会漏、也可能误报）→ 因此**只警告**，名单**显式写死**（就是 §3 的短名清单），
不去猜"什么看起来像关键字"。

**降冲突面的两条零成本做法**（写进指南，不新增机制）：
1. 小程序/脚手架/示例用**短名**（面向读者）；库代码或大文件里鼓励 `defineX`（面向维护者），
   或自己起别名 `import { defineConfig as config }`；
2. 真撞了就 `import { config as appConfig }` —— 这是用户能自己解决的事，框架只需**守住保留位**。

**分期**：
- ② 里的**那个洞已在 M9c 提前修掉**（它跟短名无关、触发条件很普通）。修法经过一次演进，记录下来：
  最初改成命名空间键 `@actor/route`（放在 `ctx.state` 里），但实现中一条既有用例暴露了同一 bug 的**另一面** ——
  它断言 `Object.keys(ctx.state)` 恰好是用户键 + `route`，也就是**框架内部槽泄漏进了用户的"每请求可变袋"**。
  最终方案是**根本不放进 `ctx.state`**：用模块内 `WeakMap` 存（`setRouteSpec` / `routeSpecOf`，**包内**使用，
  不进公开面）—— 键不存在，既不可能被覆盖，也不可能污染用户可见的 state。
  同时新增**单一来源**的保留名单 `RESERVED_CONTEXT_KEYS`（`@actor/web` 公开导出，含 `route` 与 `@actor/route`）：
  故意写这两个键会得到**明确报错**，而不是静默覆盖。
  回归网：authPlugin 既有用例（真写方 + 真读方）+ 一条用**真实 `ctx.extend`** 写的"保留键不能被 extend 掉"用例。
- ② 的**其余部分**（保留名常量扩到 service 名/路由前缀 + 启动期校验）并进 **M9e**（短名落地那一期）；
- ③（用户代码与短名同名的启发式提示）并进 doctor 扩展（与 M9c 余下 / M9d 一起）；本条结论写进指南的"命名与保留名"一节。

## 8.6 实施结果（M9f / M9g 已落地；本节是"设计 vs 实现"的对照）

| 期 | 设计里的糖 | 实现（文件） | 与设计的差异（如实记） |
|---|---|---|---|
| M9e | 短名 | 各包 `index.ts` | 按设计落地；`test/unit-sugar-aliases.test.js` 用 `===` 钉住 |
| M9e | 保留名 + 启动期校验（§8.5 ②） | `@actor/web` 的 `RESERVED_ROUTE_PREFIXES`/`RESERVED_PREFIX_OWNERS`、`@actor/app` 的 `RESERVED_SERVICE_NAMES` | **服务名改在"声明层"拦**（插件名/provides/provider 名）：运行时 `provide()` 分不出"框架插件"与"用户插件"，在那里拦会把 `httpPlugin` 自己拒掉。路由前缀两层拦（插件声明的前缀 + 模块路由落在保留区） |
| M9f | config 值即 schema | `packages/app/src/config.ts` | 普通对象**永远是分组**（不做"对象默认值"推断）——要对象默认值写 `{ type: 'json', default }`；另加 `FieldSpec.required: false`（部分更新用） |
| M9f | controller 输入合一 | `packages/web/src/controller.ts` | 字符串简写是**别名表**（`string/int/number/bool/boolean/json`），打错的名字**定义期报错**；`input` 归一化后的来源表不上公开面（WeakMap + 一份不可枚举副本给 routes.ts 的规则 3） |
| M9f | 中间件阶段简写 | `packages/web/src/middleware.ts` | 名字改成 `atPre`/`atAuth`/`atParse`/`atHandler`/`atPost`/`atError`（**不是**设计里的 `pre`/`post`/`parse`：`post` 已是路由助手、`parse` 撞 `JSON.parse` —— 实测示例直接编译不过）；实现是**包一层**而不是给原函数挂属性（函数 `name` 只读，挂属性会抛） |
| M9g | `crudRoutes(prefix, model, opts)` | `packages/web/src/factories.ts` | 第二个参数是**结构化最小仓储**（`list/get/create/update/remove`），不是 `@actor/db` 的 `Model`（保持"工厂不依赖具体数据层"）；字段用 `fields` 显式声明（数组 = 必填字符串；对象 = 值即 schema），PUT 默认**部分更新** |
| M9g | `healthRoutes()` | 同上 | 只报告"进程形状"（`status`/`uptimeMs`/受管资源**数量**）；深度健康留给 `/__debug/health?check=1`（需要 token，不该公开） |
| M9g | debug 四层作用域 | `packages/web/src/debug.ts` | 四层全部落地（全局 `expose.hidePrefixes`、模块 `debug.hidePrefixes/expose`、控制器 `debug:'off'`）；**模块归属**用的是 `RouteMeta.router`（`module` 字段历史上从没被写过，如实记下）；`/__debug/config` 的**模块级打码**没做（路由可见性已覆盖设计意图，配置打码留下一轮） |

## 9. 已确认（用户拍板）

1. ✅ `model()` **小写**（`Model` 在 `@actor/db` 已是类型名）；且**所有短名统一小写**（见 §2 第 4 条）；
2. ✅ `routes()` 定为**规范名**、`defineRoutes` 降为**永久别名**（代码零破坏，只是文档改推荐写法）；
3. ✅ `runApp` 用这个名字；
4. ✅ debug 作用域粒度 = **全局 / 路由前缀 / 模块 / 控制器**（四层，见 §6）。

> §2 第 4 条对 `actor` / `schema` 的两处澄清一并记录：应用层没有这两个入口，不为整齐造名字。
