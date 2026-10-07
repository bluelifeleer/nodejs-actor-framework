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
4. **大小写**：函数一律 **camelCase**（仓库既有约定）。你举例写了 `Model`（大写）—— 需要你确认：
   `Model` 在 `@actor/db` 里**已经是类型名**（`packages/db/src/model.ts:135`、`packages/db/src/index.d.ts:362`）。
   TypeScript 允许"值 + 类型"同名，但会让 `import { Model }` 到底拿到哪个变得含糊。
   → **推荐 `model()`（小写）**；若你坚持 `Model`，我照做，但会在文档里明确标注这个副作用。

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

推荐模型 —— **可见性作用域 + 继承**（三层，默认 `inherit`）：

| 层 | 写法 | 效果 |
|---|---|---|
| 全局 | `debugPlugin({ enabled: true, token })` | 挂 `/__debug/*`（默认关闭、需 token、生产拒绝启动，维持 M8d 三层门禁） |
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

## 9. 待你确认

1. `model()` 小写可以吗？（`Model` 在 `@actor/db` 已是类型名）
2. `routes()` 定为规范名、`defineRoutes` 降为别名 —— 同意吗？（这是"收口两套方言"的唯一一处破坏性语义调整，但**代码零破坏**）
3. `runApp` 这个名字可以吗？（备选 `startApp` / `serve`）
4. debug 的三层作用域（全局/模块/控制器）粒度够吗？要不要再加"按路由前缀"？
