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

### 9.3 尝试 A 时发现的一个未解问题（阻塞项，已回退）

按路线 A 转了两个叶子文件（`restart-strategy.ts`、`token-bucket.ts`，并给引用方加显式 `.ts`）后：

- 类型检查通过；278/279 用例通过；
- **稳定失败 1 例**：`worker isolation: a crash inside the worker restarts the actor with fresh state`
  （`packages/core/test/unit-actor-isolation.test.js:72` → `TypeError: Cannot read properties of undefined (reading 'hp')`，即 `ref.state()` 返回 `undefined`）
- **关键矛盾**：把该用例的操作序列（spawn worker 隔离 Actor → `hurt` → `state()`）**逐字**写成独立脚本运行，`state()` 正常返回 `{hp:70,calls:1}`；在测试文件里（即使 `--test-name-pattern` 只跑这一条）稳定失败。环境变量（含 `setupTempEnv` 的全部设置）已复现过，不是原因。

已回退到全绿基线（279/279），**下次动 `.js → .ts` 前必须先解释这个差异**——它的形态（独立脚本通过 / 测试文件失败）更像测试运行器与 worker 线程交互的问题，而不是类型转换本身；但在没弄清之前，贸然批量转换会把一个未知风险扩散到 47 个文件。

### 9.4 本次顺带完成（已保留）

- 加了 `@types/node`（devDependency）并在 tsconfig 里启用 `types: ["node"]`——这是设计文档 §8 T-D 的建议；之后 `.ts` 代码不再需要手写 `process`/`Buffer`/`require` 的结构化声明。
- dev tsconfig 的 `include` 已扩到 `packages/core/src/**/*.ts`（为转换后的文件真正进入类型检查做准备；当前无 `.ts` 源码，是 no-op）。

## 10. 本节待确认

| # | 事项 | 建议 |
|---|---|---|
| T-A | ESM 源码 + 双产物 | 推荐；若不接受双产物复杂度，退化为"ESM 源码 + 只发 ESM"（放弃 CJS 消费者） |
| T-B | 是否现在引入 pnpm workspace | 先用 npm workspaces（少一个工具） |
| T-C | `packages/*/src` 迁移期间是否允许保留 `.js` | 允许一个里程碑的过渡期，之后禁止新增 `.js` |
| T-D | `@types/node` 是否加入 devDeps | 建议加（现在靠手写结构化类型绕过，成本已开始显现：`process`/`Buffer`/`http` 都要手写） |
