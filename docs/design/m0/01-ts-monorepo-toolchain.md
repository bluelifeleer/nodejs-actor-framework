# M0.1 工具链与仓库结构（设计草案，未实现）

> 本文所有结论都来自**本机实测**（Node v24.15.0 + TypeScript 7.0.2），命令与结果见 §1。
> 目标：TS 源码 + monorepo，同时**保留"开发和测试不需要构建"**这个当前最大的工程优点。

## 1. 实测结论（决定了下面的所有设计）

| # | 验证项 | 结果 | 对设计的影响 |
|---|---|---|---|
| T1 | 直接跑带类型的 `.ts`（interface/泛型/class/私有字段） | ✅ `node plain.ts` 通过，无需 flag | 开发与示例可以无构建运行 |
| T2 | `node --test` 跑 `.test.ts` | ✅ 通过（1/1） | **测试不需要构建**，`.ts` 测试可直接跑 |
| T3 | `enum` | ❌ `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（strip-only 不支持）；`--experimental-transform-types` 下可用 | 源码禁用 `enum`/`namespace`，用 `as const` 对象 + 联合类型 |
| T4 | 装饰器 | ❌ 原生与 `--experimental-transform-types` 下**都报语法错** | **装饰器不能进主线 API**；需要真实转译器（tsc/SWC/esbuild） |
| T5 | `erasableSyntaxOnly` 是否被 tsc 支持 | ✅ 支持，且会拒绝**参数属性**（`constructor(private x)` → TS1294） | 用它强制"只能写 Node 能直跑的 TS 子集" |
| T6 | `tsc` 产出 CJS + `.d.ts` | ✅ `dist/src.js` + `dist/src.d.ts`，`require` 可用 | 发布产物可行 |
| T7 | `node_modules` 里的 `.ts` 能否被加载 | ❌ `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | **发布必须编译**：依赖包里的 TS 不会被剥离 |
| T8 | `moduleResolution: node10` | ❌ TS 7 已移除 | tsconfig 只能用 `nodenext`/`node16`/`bundler` |
| T9 | `verbatimModuleSyntax` + `nodenext` 在 CJS 包里用 `export` | ❌ TS1287（顶层 export 不允许） | 想用 ESM 语法，包必须是 `"type": "module"`（或文件用 `.mts`） |

**T7 + T2 合起来是本设计的核心结论**：
> **开发/测试零构建（直接跑 `.ts`），发布必须构建（编译出 JS + `.d.ts`）。**

## 2. ESM vs CJS 决策（M0-1）

| 方案 | 开发体验 | 发布 | 消费者 | 结论 |
|---|---|---|---|---|
| A. ESM 源码（`"type": "module"`）+ 双产物（ESM+CJS） | ✅ 直接跑 `.ts` | 两次 `tsc`（或一次 + 薄 wrapper） | ESM 与 CJS 都能用 | ✅ **推荐** |
| B. ESM 源码 + 只发 ESM | ✅ | 一次 `tsc` | ❌ CJS 用户（仍不少）无法 `require` | 不推荐 |
| C. CJS 语法写 TS（`export =` / `import x = require()`） | ⚠️ 语法别扭，`verbatimModuleSyntax` 下受限（T9） | 一次 `tsc` | ✅ | 仅在"必须零风险兼容老消费者"时考虑 |
| D. 保持 JS + `.d.ts`（现状） | ✅ | 无需构建 | ✅ | 与 Q1=TS 的决定冲突，放弃 |

**推荐 A**，产物布局：

```
packages/core/
  src/**.ts                # ESM 源码，Node 直跑
  dist/esm/**.js + .d.ts   # tsc -p tsconfig.esm.json
  dist/cjs/**.js + .d.ts   # tsc -p tsconfig.cjs.json（并在 cjs 目录放 {"type":"commonjs"}）
  package.json             # exports 映射：
    { ".": { "import": "./dist/esm/index.js", "require": "./dist/cjs/index.js", "types": ... },
      "./package.json": "./package.json" }
  test/**.test.ts          # 直接 node --test，不编译
```

> `dist/cjs` 里要放一个 `{"type":"commonjs"}` 的 `package.json`，否则在 `"type": "module"` 的包里 `.js` 会被当成 ESM——这是双产物最常见的坑。

## 3. tsconfig 体系（配方，待落地时按此建）

**base（所有包共用）**——强制"Node 能直跑的 TS 子集"：

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "verbatimModuleSyntax": true,      // 类型导入必须显式 import type
    "erasableSyntaxOnly": true,        // 禁 enum/namespace/参数属性（T3/T5）
    "isolatedModules": true,           // 单文件转译安全（Node 逐文件剥离类型）
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": []                         // 不依赖 @types/node 也能过（现状如此；需要时再加）
  }
}
```

**dev/test**：`tsconfig.json`（`noEmit: true`，含 `src` + `test`）——`npm run typecheck` 用它。
**build**：`tsconfig.esm.json` / `tsconfig.cjs.json`（`outDir: dist/esm|cjs`，`declaration: true`，只含 `src`）。
**迁移期**：`allowJs: true` + `checkJs: false`，`src` 里可临时存 `.js`，逐个迁 `.ts`（见 §5）。

**禁止清单（用 lint 规则 + `erasableSyntaxOnly` 双重保障）**：
`enum`、`namespace`、参数属性、装饰器、`import x = require()`、`.ts` 里用 `require()`。

## 4. monorepo 布局（M0.1 只建 core，其余占位）

```
packages/
  core/                    # @actor/core：内核 + 运行时服务（M0 主要战场）
  web/                     # @actor/web（M2）
  data/                    # @actor/data（M3）
  testkit/                 # @actor/testkit（M0.2 起就有雏形：虚拟时钟）
  cli/                     # @actor/cli（M5）
  plugin-cluster/          # 现有 plugins/cluster 迁出（M1 之后）
  plugin-observability/    # 现有 metrics/tracing/alerting（M1 之后）
docs/design/
examples/                  # 全部改为依赖 workspace 包，验证"独立可用"
```

**M0.1 的阶段性妥协**：先**不引入 pnpm workspace 工具**，只用目录约定 + 共享 tsconfig base + npm workspaces（npm 自带 workspace 支持，避免新增工具链）。确认稳定后再考虑 pnpm。

**依赖规则进 CI**（对应总览的规则）：
1. `packages/core/src/**` 不得 import `@actor/web|data|cli|testkit`。
2. 只有 `packages/core/src/index.ts` 是公共面；其他包不得 deep-import `core/src/**`。
3. `packages/core/package.json` 的 `dependencies` 必须为空。
4. 加载面测试（E4）：`require('@actor/core')` 后 `require.cache` 里模块数 ≤ 15。

## 5. 迁移计划（strangler，任一时点测试全绿）

| 步骤 | 动作 | 验证 |
|---|---|---|
| 1 | 建 `packages/core` 骨架（`package.json`/tsconfig/空 `src/index.ts`），npm workspaces 指向 `packages/*` | `npm test` 不受影响 |
| 2 | 一次性把 `lib/**` 整体复制成 `packages/core/src/**`（仍是 `.js`，`allowJs`），根 `lib` 删除、根 `index.js` 改为 `module.exports = require('./packages/core/src/index.js')` 之类的过渡入口 | 279 用例全绿 |
| 3 | 逐文件 `.js → .ts`：先叶子（`errors`、`restart-strategy`、`mailbox`）后核心（`actor-cell`、`system`） | 每迁完一批跑全量 |
| 4 | 测试逐文件 `.test.js → .test.ts`（可用 `import type` 提类型收益） | `node --test` 全绿 |
| 5 | 插件从 `plugins/**` 迁到 `packages/plugin-*`，公共面瘦身（E4） | 加载面测试达标 |
| 6 | 建 `tsconfig.esm/cjs` + `exports`，做一次"装进临时工程"的发布验证（E3） | 新工程能 `require` 与 `import` |

**为什么先复制而不是原地改**：原地改会让根 `index.js` 与 279 个测试同时面对路径与语法两处变化，排错成本翻倍。复制后保持一个可运行基线，再逐个换。

## 6. 装饰器结论（M0-2）

实测 T4：Node 原生 TS **不支持装饰器**（`--experimental-transform-types` 也不支持）。因此：

- **主线 API 不依赖装饰器**（这也印证了 Q4 推荐"显式 builder"）：路由、DI、校验全部用显式函数/对象表达，零构建即可运行与测试。
- 装饰器作为**可选包**（`@actor/web-decorators`），使用者用 tsc/esbuild/SWC 自行构建；该包不进 core，也不进默认模板。
- 若将来 Node 原生支持装饰器（提案仍在演进），再把装饰器提升为可选官方风格。

## 7. 发布与 CI

**发布检查清单**（沿用现有清单，加 TS 相关项）：
1. `npm run typecheck`（dev tsconfig）
2. `npm test`（无构建，直接跑 `.ts`）
3. `npm run build`（esm + cjs + d.ts）
4. 产物验证：临时工程 `require` + `import` 各一次；`npm pack --dry-run` 确认不含 `src/**`（或按需包含）与测试证书
5. `npm test -- --no-build` 之外的"零依赖路径"跑一遍（隐藏 node_modules）
6. 加载面测试（E4）与规模测试（E6）

**CI 矩阵**：Node 当前 LTS × {有依赖, 无依赖} + typecheck + build + 产物冒烟。


## 9. `.js → .ts` 迁移：实测的解析规则与路线修正

### 9.1 实测规则（Node v24.15.0）

| 场景 | 结果 |
|---|---|
| `.js` require `'./leaf'`，只有 `leaf.ts` | ❌ 失败 —— **CJS 解析不补 `.ts`** |
| `.js` require `'./leaf.ts'`（显式扩展名） | ✅ 成功 |
| `.ts` require `'./leaf2'`，`leaf2.js` 存在 | ✅ 成功 |
| `.ts` require `'./leaf'`，只有 `leaf.ts` | ❌ 失败 |

结论：**半途迁移不是免费的**——每转一个文件成 `.ts`，其所有引用方必须写显式 `.ts` 扩展名。

### 9.2 两种可行路线

| 路线 | 写法 | 代价 |
|---|---|---|
| **A. 过渡期 CJS `.ts`** | 类型用 `export type`/`import type`（会被擦除），运行时用 `module.exports`/`require('./x.ts')` | 引用方要写 `.ts` 扩展名（CJS 里很别扭）；跨文件**运行时值**仍是 `any`，只有文件内部有类型；ESM 化时还要再改一遍语法 |
| **B. 直接 ESM `.ts` + 显式 `.ts` 导入 + `rewriteRelativeImportExtensions`** | `import { X } from './x.ts'`（TS 编译时重写为 `./x.js`） | 需要包改 `"type": "module"`；**CJS 消费者（根测试/示例/actor-main）要么一起转 ESM，要么消费 `dist/cjs`**（即需要构建） |

**决定：走路线 B。** 理由：A 的扩展名写法在 CJS 里是纯粹的过渡债，而且跨文件无类型（等于只拿到一半收益）；B 是 Node 原生 TS 的正规形态，且与设计里"ESM 源码 + 双产物发布"一致。B 的执行前提是先定"根侧 CJS 文件怎么办"（转 ESM 还是消费 dist），这需要单独一步。

### 9.3 该问题已定位并修复：崩溃重启窗口内读状态会静默返回 undefined（阻塞项解除）

按路线 A 转了两个叶子文件（`restart-strategy.ts`、`token-bucket.ts`，并给引用方加显式 `.ts`）后：

- 类型检查通过；278/279 用例通过；
- **稳定失败 1 例**：`worker isolation: a crash inside the worker restarts the actor with fresh state`
  （`packages/core/test/unit-actor-isolation.test.js:72` → `TypeError: Cannot read properties of undefined (reading 'hp')`，即 `ref.state()` 返回 `undefined`）
- **关键矛盾**：把该用例的操作序列（spawn worker 隔离 Actor → `hurt` → `state()`）**逐字**写成独立脚本运行，`state()` 正常返回 `{hp:70,calls:1}`；在测试文件里（即使 `--test-name-pattern` 只跑这一条）稳定失败。环境变量（含 `setupTempEnv` 的全部设置）已复现过，不是原因。

**已定位：这是框架的真实缺陷，与 TypeScript 无关，转换只是把窗口拉宽了。**

根因（两处叠加，都在"崩溃 → 重启"的时间窗内）：

1. `ActorCell._restart()` **先** `restarts += 1`，**之后**才 teardown + `_init()`。观察者（测试的 `waitFor(restarts === 1)`）可以在新 incarnation 就绪前就继续往下走。
2. `ActorCell.fetchState()`（`ref.state()` / `saveSnapshot()` 的底层）在窗口内 `instance` 与 `delegate` **都是 null**，于是直接 `return undefined` —— 静默把"暂时没有 incarnation"表达成"这个 Actor 没有状态"，甚至会让 `saveSnapshot()` 跳过写盘。

为什么独立脚本当时通过：脚本在崩溃后 `await` 了 400ms 才读状态，窗口已过；测试在 `restarts` 一变就立刻读，正落在窗口内。为什么 TS 转换后必然失败：worker 加载 `.ts` 模块（类型剥离）更慢，窗口更宽。

**修复（两处都修，覆盖两个变体）**：

- cell 层：新增 incarnation 门闩 —— `fetchState()` 在重启窗口内先 `await _awaitIncarnation()`（有界，默认 `shutdownTimeoutMs`），`_init()`/`_initWorker()` 完成与 `_finishStop()` 时唤醒等待者。
- delegate 层：`WorkerDelegate` 新增就绪标记（`ready` + 等待者），`getState()`/`invoke()` 在 worker 完成启动前不投递（避免 worker 里 `instance` 还是 null 时回一个空状态）。

**回归测试**：`unit-actor-isolation.test.js` 新增「崩溃后**不做任何等待**立刻读状态」用例——断言拿到的是新 incarnation 的干净状态而不是 `undefined`。全量 280/280 通过。

这条经验值得记住：**类型迁移会放大原有的时序缺陷**（它改变了启动耗时），所以"转换后失败"未必是转换本身的问题。

### 9.4 本次顺带完成（已保留）

- 加了 `@types/node`（devDependency）并在 tsconfig 里启用 `types: ["node"]`——这是设计文档 §8 T-D 的建议；之后 `.ts` 代码不再需要手写 `process`/`Buffer`/`require` 的结构化声明。
- dev tsconfig 的 `include` 已扩到 `packages/core/src/**/*.ts`（为转换后的文件真正进入类型检查做准备；当前无 `.ts` 源码，是 no-op）。


### 9.5 路线 B 的前置工作：ESM 侧实测与两个已修问题

按 B1（根侧也转 ESM）先做了**一个完整试点**：`examples/alerts.js → examples/alerts.mjs`。实测暴露并修掉两个真问题：

**(1) 包的 ESM 具名导出只有 12/30 可见（互操作缺陷，已修）**

`module.exports = { Actor, ..., plugins, cluster: plugins.cluster, ..., ...errors }` 这样的写法依赖 cjs-module-lexer 的启发式分析。实测结果：

```
require 导出: 30 | ESM 具名可见: 12 | 缺失: plugins, cluster, pubsub, metrics, tracing,
deadLetters, rateLimit, MemoryPersistence, FilePersistence, ChildSupervisor, Mailbox,
ActorFrameworkError, DefinitionError, MailboxFullError, AskTimeoutError, ActorStoppedError,
ActorNotFoundError, PersistenceError, EscalationError
```

即 `import { ActorStoppedError } from 'nodejs-actor-framework'` 会直接抛错，而 `require` 完全正常——**只有 ESM 用户会踩，且报错指向包本身**。把 `...errors` 改成显式成员导出并**没有**解决（lexer 在 `plugins` 之前就放弃），说明不能依赖它的猜测。

**修复**：新增 `packages/core/index.mjs`，把 30 个公共名**显式**重导出（`import cjs from './src/index.js'; export const { ... } = cjs; export default cjs;`），并在 `package.json` 加 `exports` 映射：`"." → { import: ./index.mjs, require: ./src/index.js, types: ./src/index.d.ts }`，另加 `"./src/*"` 通配以保留深路径访问。验证：**具名导出 30/30、身份一致**，`files` 白名单已含 `index.mjs`， 打包 55 个文件。

**(2) ESM 侧的模块解析必须显式扩展名（已在试点中确认）**

`import MetricsExporter from '../packages/core/src/obs/metrics-exporter.js'` —— 省掉 `.js` 会失败（ESM 不做扩展名补全），与 §9.1 的 CJS 侧规则正好相反。

**试点同时确认可用**：具名导入 CJS 包（经 `index.mjs`）、`import.meta.filename`（`process.argv[1] === import.meta.filename` 在主模块判断中成立，另有 `import.meta.main === true`）。

**B1 批量转换配方（已可用，待执行）**

| CJS 构造 | ESM 写法 |
|---|---|
| `const { a, b } = require('pkg')` | `import { a, b } from 'pkg'`（经 index.mjs 已可用） |
| `const X = require('pkg')`（默认导出型） | `import X from 'pkg'` |
| `require('./local')` | `import ... from './local.js'`（**必须带扩展名**） |
| `module.exports = { main }` | `export { main }` |
| `require.main === module` | `process.argv[1] === import.meta.filename` |
| `__dirname` | `import.meta.dirname` |
| 函数内动态 `require(x)` | `import { createRequire } from 'node:module'` 或提到顶层静态导入 |

待转换清单（根侧，18 个文件约 120 处构造）：`actor-main.js`、`examples/*.js`（8）、`examples/actors/*.js`（2）、`test/*.test.js`（7）、`tools/migrate-store.js`。执行顺序建议：`examples/actors/*` → `examples/*` → `tools` → 根 `test/*` → `actor-main.js`，每批跑全量保持绿。


### 9.6 路线 B 在 core 的落地：侦察结果与已开始的转换

**根侧已全部 ESM**（见提交 `7d06a22`）。core 侧先做侦察，量化风险：

| 构造 | 数量 | 迁移策略 |
|---|---|---|
| 顶层 `const X = require(...)` | 全部 | → 静态 `import` |
| **动态 `require`（函数内）** | 10 处 | 见下（分四类） |
| `module.exports = {..}` | 46 处 | → `export {..}` + `export default {..}` |
| `module.exports.X = Y` | 5 处 | → `export { Y as X }`（已在导出列表中的直接删） |

10 处动态 `require` 的分类与处理：

| 类别 | 位置 | 处理 |
|---|---|---|
| **打破循环依赖** | `actor/actor-cell.js:183,644`、`actor/system.js:142`（懒加载 `worker/worker-delegate`） | **保留懒加载**，用 `createRequire(import.meta.url)`；改成静态 import 会引入循环 |
| **可选依赖** | `store/backends/level-store.js:42`（`classic-level`） | 同上（可选依赖必须保持"用到才加载"） |
| **按路径加载用户模块** | `ops/telnet-console.js:246`、`worker/worker-host.js:126` | 同上（路径运行时才确定，必须动态） |
| **可静态化** | `ops/ws-server.js:397`（`tls`/`net` 二选一） | → 静态 import（无循环） |
| 注释里的示例代码 | `index.js:6`、`plugins/index.js:7`、`actor/restart-strategy.js:9` | 仅更新文案 |

结论：core 的转换风险可控——**只有 5 处需要 `createRequire`**，其余都能静态化。

**已开始的转换（过渡期 `.ts`，CJS 语法）**：`actor/restart-strategy.ts`、`actor/token-bucket.ts`
（`export type` + `module.exports`；引用方写显式 `.ts`）。这次 PoC 与 §9.3 那次失败的转换是同一批文件——
**现在 281/281 全绿通过**，反证了当时的失败来自崩溃重启的竞态缺陷，与类型转换无关。

**剩余步骤**（core 约 45 个文件）：

1. 批量转 `.ts`（过渡期 CJS 语法）→ 跑全量；
2. 切 ESM 语法（`module.exports` → `export`、`require` → `import`，5 处保留 `createRequire`）+ `packages/core/package.json` 加 `"type": "module"`；
3. 包内 16 个测试文件转 `.ts`（`node --test` 直接跑，无构建）；
4. 双产物构建（`tsconfig.esm/cjs` + `rewriteRelativeImportExtensions`）替换手写的 `index.mjs`，并做发布验证（临时工程 install + `require`/`import` 双路径）。

每一步沿用本次做法：**codemod + dry-run + 残留检查 + 全量回归**，任一时点保持绿。


### 9.7 core 已全部转为 `.ts`（过渡期 CJS 语法）——转换完成，类型补齐待续

**结果**：`packages/core/src` 45 个 `.js` → `.ts`（`git mv`，保留重命名历史），125 处 `require`、
27 处 ESM `import` 说明符改为显式 `.ts`，`worker-host.js` 这类硬编码文件名、`index.mjs`、
`package.json` 的 `main`/`exports` 一并更新。**全量 281/281 通过**。

踩到的三个坑（都已修，供后续 codemod 参考）：

1. 根侧已是 ESM，**`import ... from '...'` 也要重写**——只处理 `require()` 会漏 27 处；
2. 扫描范围要含 `actor-main.js`、`examples/**`（它们也引用 core 内部路径）；
3. 非 `require` 的**硬编码文件名**（`path.join(__dirname, 'worker-host.js')`）不会被正则覆盖。

**类型债务（诚实记录）**：45 个文件原本是 JS，转到 `.ts` 后就进入类型检查视野，而它们几乎
没有类型标注，当前 `strict` 下 **1982 个错误**、放宽后 **1239 个**。因此：

- **严格类型门已恢复并真的通过**：`npm run typecheck`（严格）→ 0 错误 ✅。
  它当前覆盖"声明面（`.d.ts`）+ 声明文件引用到的实现"，也就是 `ops/token.ts`、`ops/ws-server.ts`
  （这两个文件已补齐类型：33 → 0、61 → 0）。
- 仍未纳入严格门的：`packages/core/src/**/*.ts` 的其余文件与 `test/types/**`。
  实测把 `test/types/**` 收回后会通过 `obs/alerting.ts` 等再拉进约 71 个错误——这就是**下一批类型债**，
  清单与数字是逐文件收口的进度指标：
  - `npm run typecheck:migration`（宽松，信息性）暴露全部剩余债务；
  - 做法已验证：把同名 `.d.ts` 的类型搬进 `.ts` 实现，再删掉多余的 `.d.ts`（将来由构建产出声明）。
- 现已清零的文件：`ops/token.ts`、`ops/ws-server.ts`（后者含 Buffer 索引读改 `readUInt8`、
  解构类型、`Promise<void>` 泛型等真实改进，不只是让编译闭嘴）。

**下一步**：把 core 切成 ESM 语法（`module.exports` → `export`、`require` → `import`，6 个文件保留
`createRequire`：`actor-cell`/`system`（循环依赖）、`level-store`（可选依赖）、`telnet-console`/`worker-host`
（按路径加载）、`config`），再转包内 16 个测试文件，最后做双产物构建替换手写的 `index.mjs`。

## 10. 本节待确认

| # | 事项 | 建议 |
|---|---|---|
| T-A | ESM 源码 + 双产物 | 推荐；若不接受双产物复杂度，退化为"ESM 源码 + 只发 ESM"（放弃 CJS 消费者） |
| T-B | 是否现在引入 pnpm workspace | 先用 npm workspaces（少一个工具） |
| T-C | `packages/*/src` 迁移期间是否允许保留 `.js` | 允许一个里程碑的过渡期，之后禁止新增 `.js` |
| T-D | `@types/node` 是否加入 devDeps | 建议加（现在靠手写结构化类型绕过，成本已开始显现：`process`/`Buffer`/`http` 都要手写） |
