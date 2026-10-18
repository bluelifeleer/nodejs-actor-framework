# 发布手册（release runbook）

这份文件说明**怎么把这个仓库发出去**，以及每一步的门禁。它不是设计文档，是操作手册：
照着做，每一步都有可验证的结果。

> 现状：发布形态已就绪（12 个包都能 `npm publish --dry-run` 通过），**组织与 scope 还没定**，
> 所以"全私有"这一步还没落地。下面的 §2 是待办，§1 是每次发布都要跑的。

## 0. 先跑一条命令

```bash
npm run release:check          # typecheck + 全量测试 + 文档站 + 打包内容 + 发布路径
npm run release:check -- --skip-ci   # 只跑打包与一致性检查（跳过测试，约 20 秒）
```

`release:check` 会依次做：

| 检查 | 抓什么 |
|---|---|
| 工作区测试矩阵 | 有 `test/` 的包没进根 `npm test` 的 glob（漏跑） |
| `npm pack` 内容 | 凭据 / 数据目录 / 包自己的测试混进 tarball（**例外**：`@actor/cli/templates/**` 里的测试是脚手架模板，故意随包发布） |
| **发布路径** | 12 个包逐个 `npm publish --dry-run`（会执行 `prepublishOnly`，而 `npm pack` **不执行** —— 这条差异抓到过真 bug） |
| CHANGELOG 与版本一致 | 发了但没写变更记录 |
| 各包 engines 一致 | Node 下限有多个来源 |
| 工作区干净 | 从脏树发布 |

## 1. 每次发布（无论私有还是公开）

```bash
# ① 版本：内核与 addons 各自独立版本，但**依赖写的是 `*`**，所以按顺序发即可
npm version <patch|minor|major> -w packages/core     # 等等，见 §3 的顺序说明
# ② CHANGELOG 补一段（`release:check` 会核对最新版本号）
# ③ 全绿
npm run release:check
# ④ 按依赖顺序发（12 个包）
npm publish -w packages/core --access <restricted|public>
# … 其余 11 个
```

> 顺序：`nodejs-actor-framework` → `@actor/resource` → `@actor/db-core` → `@actor/db` →
> `@actor/data` → `@actor/app` → `@actor/web` → `@actor/redis` → `@actor/mongodb` → `@actor/mail` →
> `@actor/testkit` → `@actor/cli`。前置包没发出去，后者装的时候会解析失败。

## 2. 全私有（待办：等 npm 组织 + 付费计划就绪）

**为什么需要一个组织**：npm 只允许**带 scope 的包**私有；`nodejs-actor-framework` 是无 scope 名，
只能公开。所以"全私有 + 名字统一"的唯一做法是：

1. 在 npm 建组织（例如 `actor`）→ 得到 `@actor` scope（需要付费计划，具体档位以 npmjs.com 为准）；
2. **只改内核的名字**：`nodejs-actor-framework` → `@actor/framework`
   （另外 11 个包已经是 `@actor/*`，不动）。改动面：所有 `import ... from 'nodejs-actor-framework'`、
   12 个 `package.json` 的 name/dependencies、`tsconfig` 的 paths、文档与示例 —— 目录里现有
   **88 个文件**提到内核名；
3. 每个包加：

   ```json
   "publishConfig": { "access": "restricted" }
   ```

   并且发布时显式带 `--access restricted`（双保险：不靠默认值）；
4. 发布前把 `release:check` 的"发布形态"断言打开：它现在会核对 `publishConfig.access` 与
   `publish-dry-run` 的输出，防止**误发成公开包**；
5. 消费者要 `npm login`（或 `.npmrc` 带 `//registry.npmjs.org/:_authToken=...`）才能装。

> 如果付费走不通：备选是 GitHub Packages（免费额度内，scope 必须是 GitHub 账号/组织名）
> 或自建 Verdaccio（**唯一能保留无 scope 名字**的方案，但要自己运维）。

## 3. 现在就把无 scope 名占住（可选，推荐）

```bash
npm run release:reserve-name            # 干跑：在临时目录生成 0.0.1 占位包并 `npm pack --dry-run`
npm run release:reserve-name -- --publish   # 真发（需要先 `npm login`）；已存在则跳过
```

占位包只包含 `package.json` + `README.md` + `index.js`（一行提示），**不含本仓库源码**；
它唯一的作用是防止 `nodejs-actor-framework` 被第三方抢注。将来要公开正式版时直接发新版本覆盖即可。

## 4. 我们踩过的坑（发布前值得再看一眼）

1. **`npm pack` 通过 ≠ 发布能过**：`pack` 不执行 `prepublishOnly`，`publish` 执行。
   曾经的 bug：各包 `prepublishOnly` 传 `--package .`，构建脚本不认 → 发布在预处理阶段就失败。
2. **深引对方 `src/*.ts` 在仓库内一切正常，装成包必崩**：Node 不允许对 `node_modules` 里的 `.ts`
   做类型剥离。包之间只许走公开子路径（`nodejs-actor-framework/ops`、`@actor/cli/commands`）。
3. **`publish --json` 的形状与 `pack --json` 不同**：前者是**按包名分组**的对象，后者是数组。
4. **worker 宿主路径、非 TS 资产**这类"运行时读文件"的东西，编译后路径会变；
   `dist/config` 缺资产、`worker-host.ts` 都要在发布前用 `smoke:prod` 验一遍。
5. **构建缓存（`*.tsbuildinfo`）与 `dist/` 都不入库**：它们每次构建都变，进 git 只会制造冲突。
6. **本机 `~/.npmrc` 里的 `allow-scripts` 会让 `npm install` 在 project-scoped 安装时报 EALLOWSCRIPTS**：
   门禁里跑安装时必须隔离 npm 配置（`tools/publish-dry-run.mjs` 已这么做）。

## 5. 发布之后

- 在一个**干净工程**里装一遍验证（不是仓库内）：
  ```bash
  npm i @actor/framework @actor/app        # 或 nodejs-actor-framework（公开时）
  npx @actor/cli new app demo && cd demo && npm test
  ```
- 出问题要撤版本：`npm deprecate` 提示用户，或（发布 72 小时内）`npm unpublish`；
  **不要**直接覆盖同一个版本号 —— npm 不允许。
