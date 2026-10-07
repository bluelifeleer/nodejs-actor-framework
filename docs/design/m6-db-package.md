# M6 设计：`@actor/db` —— 应用层数据库能力（方言 / 连接池 / model / ORM 映射）

> 目标（用户拍板）：① 常用 SQL 适配器，支持 **pgsql（默认）/ mysql / sqlite**；
> ② 连接配置由用户给、驱动由用户装，**框架负责连接与连接池管理**、以及 ORM 映射层的转换；
> ③ 新增 **model 层**与 **ORM 解析层**，这两层**用户可写自己的代码**，框架自动处理其余部分。

## 1. 分层与职责（谁写什么）

```
用户代码            defineModel({...})            relation/parse/serialize 钩子
                    ────────────────            ──────────────────────────
                         │                              │
框架（@actor/db）   Model 层：解析声明 → 表结构/列类型/约束/索引   ← 用户声明的"真相"
                         │
                    ORM 映射层：实体 ↔ 行（列名映射、JSON 编解码、时间戳、version 乐观锁）
                         │
                    查询构造层：全参数化的 SELECT/INSERT/UPDATE/DELETE/聚合
                         │
                    方言层：占位符（$n vs ?）、标识符引号（"x" vs `x`）、类型映射、RETURNING/upsert 差异
                         │
                    驱动层：懒加载 pg / mysql2；sqlite 用 Node 24 内置 node:sqlite
                         │
                    连接池：创建 / 健康检查 / 优雅关闭（框架负责）
```

**边界**（与 `@actor/data` 的分工，避免重复造）：
- `@actor/data` 继续负责"**仓储语义**"（游标分页、乐观锁冲突错误、outbox、投影、迁移 runner、事件演进）。
- `@actor/db` 负责"**连接与方言**"和"**model → 表/映射**"。它对外提供一个 **`SqlRunner` 形状的对象**
  （`all/run/transaction`，与 `@actor/data` 的 `SqlRunner` **结构兼容、不互相 import**），于是：
  ```ts
  const db = createDatabase({ dialect: 'pgsql', connection: { url } });
  await db.connect();
  const notes = createSqlRepository({ runner: db.runner(), table: 'notes', fields: [...] }); // @actor/data
  ```
  两者组合，而不是让 `@actor/db` 重新实现一套分页/冲突语义。
- `@actor/db` 自己再提供一层 model 驱动的仓储（`db.repository(Note)`），用于"声明即用"的场景。

## 2. 驱动层（用户装、框架懒加载）

| 方言 | 驱动来源 | 说明 |
|---|---|---|
| `sqlite` | **Node 24 内置 `node:sqlite`** | 零依赖、可离线测；单连接（写串行），用 `busy_timeout` 处理竞争 |
| `pgsql` | 懒加载用户安装的 `pg` | `new Pool(config)`；事务必须用**专用 client** 并在 finally `release()` |
| `mysql` | 懒加载用户安装的 `mysql2/promise` | `createPool(config)`；事务 `getConnection()` + `release()` |

- 驱动**不写进 `dependencies`**（与仓库"零运行时依赖"一致）。缺失时的错误必须明确：
  `cannot load driver "pg" for dialect pgsql: run \`npm i pg\``。
- 可注入驱动实现（`driver: { createPool() }`）—— 这既是给测试用的缝，也让用户能换成自己的连接实现。
- **连接配置**：`{ url }`（DSN）或 `{ host, port, user, password, database, ... }` 字段式；两者都支持，
  DSN 优先。密码**不进日志**（错误信息里只出现 host/port/database）。

## 3. 连接池（框架负责）

`createDatabase({ pool: { min, max, idleTimeoutMs, connectionTimeoutMs, maxUses? } })`：
- 建池时不连接（懒），`connect()` 做一次 `SELECT 1` 健康检查；失败即抛，不静默降级。
- `close()` 优雅关闭：等已有查询结束（有上限），然后释放；重复调用幂等。
- `healthCheck()` 返回 `{ ok, latencyMs, error? }`；供 readiness 探针/CLI `doctor` 使用。
- 池参数映射到各驱动的真实字段（`pg`: `max/idleTimeoutMillis/connectionTimeoutMillis`；
  `mysql2`: `connectionLimit/idleTimeout/connectTimeout`；`sqlite`: 单连接 + `busy_timeout`）。

## 4. Model 层（用户写声明，框架生成表）

```ts
const Note = defineModel({
  name: 'notes',                       // 表名默认 = name
  fields: {
    id:        { type: 'uuid', primaryKey: true },
    title:     { type: 'string', length: 200, notNull: true },
    body:      { type: 'text', default: '' },
    tags:      { type: 'json', default: [] },        // JSON 列（sqlite 存 TEXT + 编解码）
    ownerId:   { type: 'string', column: 'owner_id' },
    createdAt: { type: 'timestamp', auto: 'create' },
    updatedAt: { type: 'timestamp', auto: 'update' },
    version:   { type: 'integer', version: true },    // 乐观锁
  },
  indexes: [{ fields: ['ownerId'], unique: false }],
  parseRow: (row) => ...,               // 用户可写的"解析层"（整行级）
  serializeRow: (entity) => ...,
});
```

- **自动建表**：`await db.sync([Note, ...])` 执行 `CREATE TABLE IF NOT EXISTS` + 索引。
- **漂移检测**：introspect 现有表（pg/mysql 走 `information_schema`，sqlite 走 `PRAGMA table_info`），
  与 model 比对；**缺列/类型不符 → 明确报错**（列出"model 有、库里没有"的差异），不静默。
- **自动迁移（ALTER）**：只有 `migrations: { auto: true }` 才执行；默认 `false`（`sync` 只建不改）。
  开启后也只做**安全操作**：加列（带默认值）/加索引；**删列、改类型、加 NOT NULL 一律拒绝并报错**。
- 字段类型集合（跨三方言映射）：`uuid / string / text / integer / bigint / real / boolean / timestamp / date / json / blob`。
- 每字段钩子：`parse`（列值 → 领域值，如 JSON 解码/日期解析）、`serialize`（领域值 → 列值）。

## 5. ORM 映射层（用户可写自定义映射）

- **实体 ↔ 行**：列名映射（`column`）、JSON 列编解码、时间戳自动填充（`auto: 'create' | 'update'`）、
  `version` 乐观锁（`update` 带 `WHERE version = ?` 且 `version = version + 1`，冲突 → `DbConflictError`）。
- **关联声明**：`relations: { comments: { hasMany: 'comments', foreignKey: 'noteId' }, author: { belongsTo: 'users', foreignKey: 'ownerId' } }`
  —— 本轮只做**声明 + 查询构造支持**（`db.query(Note).with('comments')` 生成参数化 join/二次查询），
  不做 N+1 自动优化、不做级联写。
- **逃生通道**：`db.raw(sql, params)`（返回行）与 `db.rawRun(sql, params)`（返回影响行数）；
  两者都**只做参数化**，不做字符串拼接。
- 用户也可整体覆盖映射：`db.repository(Note, { map: { toEntity(row), toRow(entity) } })`。

## 6. 验收（可跑的测试）

1. `sqlite`：**真数据库**（`node:sqlite` 内存库）跑完整 CRUD、model 建表、漂移检测、乐观锁冲突、
   JSON 列、时间戳自动填充、`raw()`、事务回滚、`with('hasMany')`。
2. `pgsql` / `mysql`：**假驱动模块**（可注入）验证——池参数映射、占位符风格（`$n` / `?`）、
   标识符引号（`"x"` / `` `x` ``）、事务用专用连接且必定 release、`insert` 走 `RETURNING` 或 `insertId`、
   类型映射（DDL 文本逐条对照）。
3. **驱动缺失**：错误信息必须包含方言、驱动名与安装命令。
4. **配置**：DSN 与字段式两种都能建池；密码不出现在错误/日志里。
5. 门禁：新包进根 `npm test` 与 `typecheck` 矩阵、公开面声明（`src/index.d.ts`）、文档站指南一篇。

## 7. 不做（明确记录）

- 不做 ORM 的"关系级联写 / 迁移自动生成器 / 查询构造器的完整表达式树"。
- 不接管 schema 的**破坏性**变更（删列/改类型）；这属于运维决策。
- 不引入任何运行时依赖（含查询构建器第三方库）。
- 本轮不做 `@actor/app` 专用插件；先给库级 API + 接入示例（需要时再加，避免过早固定配置形状）。

---

## 进度

### Round 1（已完成）：包骨架 + 方言层 + 驱动 + 连接池

- 新包 `packages/db`（`@actor/db`），已接入根 `npm test` 矩阵与 `tsconfig.json`（`release-check` 的
  "工作区测试矩阵"门禁会盯着这条）。
- `src/dialect.ts`：占位符（`$n` / `?`）、标识符引号（`"x"` / `` `x` `` + 转义）、10 个逻辑类型的
  三方言列类型映射、DSN 与字段式连接解析（含默认端口、**密码不进错误信息**）。
- `src/drivers/`：`sqlite`（Node 24 内置 `node:sqlite`，**真库测试**）、`pg`、`mysql`
  （懒加载 + 可注入；池参数逐条映射到各驱动真实字段名；事务走专用连接并在 finally `release()`）。
  **驱动从"应用根"解析**（`createAppRequire`）—— 从 `@actor/db` 自己的 node_modules 解析在 pnpm
  严格布局下看不到用户装的驱动。
- `src/database.ts`：`createDatabase` → `connect/healthCheck/close/runner/raw/rawRun/stats`，
  失败不假装健康（关闭后 `healthCheck()` 返回 `ok:false`）。
- `src/index.d.ts` + `packages/db/test/surface.test.ts`：**新包自己的公开面门禁**（运行时导出 ↔ 手写声明，
  含可证伪用例）。
- 测试 16 条：方言 5、sqlite 真库 4、pg/mysql 假驱动 4（含驱动缺失的真实报错路径）、
  与 `@actor/data` 的组合 1（`db.runner()` 直接喂给 `createSqlRepository`）、公开面 2。

### Round 2（已完成）：model 层 + schema 层

- `defineModel`：归一化（列名映射、主键/版本字段唯一性校验、索引默认命名）、每字段 `parse`/`serialize`
  钩子、整行级 `parseRow`/`serializeRow`（用户可写）；标识符安全检查（拒绝空白/分号，引号转义）。
- DDL 纯函数：`createTableSql` / `createIndexSql` / `addColumnSql`，逐条对照三方言；
  处理了方言特有的坑：pg 的 `jsonb` 默认值要 `::jsonb`、pg 布尔用 `TRUE/FALSE`（不是 1/0）、
  **mysql 不给 TEXT/JSON/BLOB 写默认值**（8.0.13 之前不支持表达式默认值，文档写明）、
  mysql 没有 `CREATE INDEX IF NOT EXISTS`（由 schema 层容忍"索引已存在"）。
- schema 层：`inspectTable`（sqlite 走 `sqlite_master` + `PRAGMA table_info`，pg/mysql 走 `information_schema`）、
  `checkDrift`（规范化后的宽松比较）、`syncModels`（建表 + 建索引；表已存在且有漂移 → **默认抛
  `DbSchemaDriftError` 并列出差异**；`migrations.auto: true` 时只自动做**安全**加列，NOT NULL 无默认值/加主键一律拒绝）。
- `Database` 增加 `sync` / `inspectTable` / `checkDrift` 与 `migrations: { auto }`；声明面同步更新
  （公开面门禁核对）。
- 测试 16 条：model 纯函数 8（DDL 文本逐方言对照、校验、字面量渲染、标识符转义）、
  sqlite 真库 5（建表/幂等/漂移报错/自动加列/不安全拒绝/类型不符）、pg+mysql 契约 3（内省 SQL、自动加列 SQL、索引已存在容忍）。

**这一轮我自己被抓住的五处**（都是"测试或假数据写错/实现有洞"）：
① `columnTypeFor` 遇未知方言会**静默当成 sqlite**（真 bug，测试抓到后加了 `assertDialect` 守卫）；
② 主键错误文案写成 `primaryKey` 而测试期望 "primary key"（改了文案，对使用者也更清楚）；
③ 假 pg 内省数据漏了 `character_maximum_length` → 被误判成类型不符；
④ 假 mysql 内省没给列 → 被误判成"所有列都缺"；
⑤ 我的测试在**建表路径**上断言"必须查列内省"（那是浪费）→ 断言移到"表已存在"的路径。

### Round 3（已完成）：ORM 映射层 + 仓储 + 关联

- `src/mapping.ts`：**默认解析规则**（这三条是"同一逻辑类型在三方言物理表示不同"的解药）——
  `json` 列字符串 → 对象；`boolean` 的 0/1 → true/false（pg 本来就是 boolean）；`timestamp` 的
  ISO 文本/Date → Date；反向 `serialize` 时 pg 布尔用 boolean、mysql/sqlite 用 1/0，
  sqlite 的时间戳统一存 ISO 串（字典序 == 时间序）。用户可以在**字段级**（`parse`/`serialize`）
  或**整行级**（`parseRow`/`serializeRow`）覆盖，这两层就是"用户可以写自己代码"的地方。
- `src/repository.ts`：`insert`（自动生成 uuid 主键、填 `auto:'create'` 时间戳、version=0）、
  `findById` / `findMany`（where/orderBy/limit/offset，**字段名必须来自 model**，值全参数化）、
  `update`（乐观锁：`WHERE pk AND version=?` + `version = version + 1`；0 行时多查一次把
  "行不存在"与"版本过期"区分开，分别抛 `DbNotFoundError` / `DbConflictError`；`auto:'update'` 自动填）、
  `delete`、`related`（hasMany 按目标表外键 / belongsTo 按本表外键，返回 `{ many(), one() }`）。
- `Database.repository(Model, { models?, generateId? })` + model 注册表（`sync()` 自动注册）；
  repository 用**惰性 runner**：可以在 `connect()` 之前拿，真发查询时才要求已连接。
- 声明面同步（`DbConflictError`/`DbNotFoundError`、mapping、Repository、relations 全部声明）。
- 测试 7 条（sqlite 真库）：insert/映射还原、乐观锁冲突与"行不存在"的区分、自定义字段钩子与整行映射、
  findMany + 列名校验防注入、关联 hasMany/belongsTo + 目标未注册的报错、delete、拼错字段名报错。

**这一轮我自己被抓住的两处**：
① 断言 `updatedAt === undefined`，但库里那一列就是 NULL（DDL 没给默认值）→ 实体里应当是 `null`
（如实反映库里的真相），改的是**测试的期望**；
② `assertKnownFields` 把用户 `serializeRow` 产生的**虚拟字段**（`grade`）也当成拼写错误 ✗ ——
规则改成"没有 `serializeRow` 才严格校验"（有用户映射层时允许虚拟字段），并补一条测试固定
"没有映射层时拼错字段名必须报错"。

### Round 4（已完成）：文档 + 门禁 + 示例

- 用户指南 `docs/guide/08-database.md`：装驱动 → 连接配置（DSN/字段式/池）→ model 声明 → `sync` 与漂移/自动迁移
  → 仓储（乐观锁、关联、findMany 的输入校验）→ **用户可写的两层映射** → `raw()` 与 `@actor/data` 组合
  → 接 `@actor/app` 的写法 → 诚实的边界（SQLite 真库验证 / PG·MySQL 仅契约级）。**9 个 verify 代码块全部真跑**。
- API 页收录 `@actor/db`（`tools/docs-site.mjs` 的 PACKAGES 加一行，已核对 `site/api.html` 里出现 `createDatabase`/`defineModel`）。
- **成员级门禁**扩到本包（`packages/db/test/member-gate.test.ts`：指南里 `db.*` 用到的成员必须在 `index.d.ts` 里，
  带可证伪用例）；同时给抽取器补了两条排除规则（URL 主机名 `@db.internal`、字符串字面量 `'db.internal'`）。
- `examples/app-db`：接 `@actor/app` 的 providers（**同步** provider + `onStart` 里 connect/sync + `onStop` 关池）、
  控制器只依赖注入的仓储、乐观锁冲突 → 409；已纳入示例冒烟门禁。
  **额外做了真实 HTTP 端到端验证**：POST 201 → GET 200（JSON 列解码回数组）→ PATCH（版本 0→1）→
  PATCH 过期版本 **409** → DELETE 200 → GET 404 → SIGTERM 优雅退出 ✓。

**这一轮发现并修掉的两个真问题**（都不是"新功能"，而是既有缺口）：
1. **5xx 在服务端完全不可见**：错误映射会把异常变成 `internal error` 响应，但服务端没有任何线索
   （我在调试 app-db 时就被卡住）→ 新增 `dispatch({ onError })` + `httpPlugin` 转成 `app.emit('http:error', …)`
   （只对 5xx 触发；4xx 是业务语义不报），并补了测试。库代码不自己写 stdout。
2. **指南里我写错了一句**："provider 可以异步：app 解析依赖时会 await" ✗ —— provider 是**同步**解析的，
   所以正确写法是"同步建句柄 + 返回仓储（惰性 runner 让它可以先拿），connect/sync 放 onStart"。
   示例与指南都已改正（示例的错误正是被 `http:error` 事件暴露出来的）。

### Round 5（已完成）：补类型 + 补注释（用户反馈）

- **类型**：`LogicalType` 从 11 个扩到 17 个 —— 新增 `bigText`（MySQL `longtext`）、`smallint`、
  `decimal`（`precision`/`scale`，默认 10,2）、`date`、`time`、`binary`（MySQL `varbinary(n)`）；
  每个都逐条对照三方言，并有测试。`date`/`time` 的领域表示统一成 `'YYYY-MM-DD'`/`'HH:MM:SS'`
  （**不带时区**，避免"日期漂移一天"这类经典坑），解析/序列化都覆盖了 Date 与文本两种输入，
  非法输入报错而不是静默写坏数据。
- **注释**：`FieldSpec`/`ModelSpec` 的**每个选项都补了 JSDoc**（用户反馈"缺注释"）；并新增
  `comment?: string`（字段级 + 表级）落到数据库 schema 注释：
  MySQL 建表时**内联** `COMMENT '…'`（超 1024 字符在生成 DDL 时就报错，不留给数据库静默截断）、
  PostgreSQL 走独立的 `COMMENT ON TABLE/COLUMN … IS '…'`（`sync()` 每次重新应用，**幂等**）、
  SQLite 不支持 → `SyncReport.unsupportedComments` **如实报告**（不假装应用了）。
  `SyncReport` 因此新增 `comments` / `unsupportedComments` 两个字段。
- 指南 `docs/guide/08-database.md` 增加完整类型对照表与注释示例（新 verify 块真跑）。

### Round 6（已完成）：让 web 层开箱可用（用户反馈第 ③ 点）

- 新增一等插件 `databasePlugin()`（`packages/db/src/plugin.ts`）：返回的是**结构化 PluginSpec**
  （`name` / `config` / `onReady` / `onStopping`），**不反向依赖 `@actor/app`** —— 两边靠结构兼容。
  - 配置节 `plugins.db.*`：`driver`（插件默认 **sqlite**，零依赖开箱可用；包级 `createDatabase()` 默认仍是
    **pgsql**）/ `url` / `file` / `poolMax` / `autoMigrate`，可用 `APP_PLUGINS__DB__URL` 这类环境变量覆盖；
  - `onReady`：建库 → `connect()` → 健康检查（不健康就**启动失败**）→ `sync(models)`（按 `autoMigrate` 决定
    是否自动补安全列）→ 通过 `app.provide` 注册 `db` 与每个声明的仓储；
  - `onStopping`：优雅关池（等查询结束再释放）；
  - 方言推断：显式 `dialect` → 从 `connection` 推断（`filename` ⇒ sqlite、`url` ⇒ 按 DSN）→ 配置 → 默认；
    需要 host 的方言却没给 url 时，报一句能照着做的错（而不是掉进通用解析错误）。
- `examples/app-db` 重写为"**插件一行接入 + 控制器只用 `ctx.get`**"：`src/app.ts` 里一行
  `databasePlugin({ models, repositories: { notes: Note } })`，`src/module.ts` 里**没有任何数据库接线**，
  控制器只依赖注入的仓储。真实 HTTP 端到端复验：POST 201 → GET 200（JSON 列解码回数组）→ PATCH(版本 0→1)
  → PATCH 过期版本 **409** → DELETE 200 → GET 404 → SIGTERM 优雅退出（插件关池）✓。
- 测试 3 条（sqlite 真库 + 真 app）：一行接入后 `app.get('db')`/`app.get('notes')` 可用且数据落盘、
  连不上时启动必须失败、`autoMigrate` 开了才自动补列（默认遇到漂移就启动失败）。
- 指南的"接进 @actor/app"整节改写为插件版（含配置表、环境变量示例、插件注册的服务名），
  并保留"手写接线要注意 provider 是同步的"那段说明；示例 README 同步更新；示例冒烟门禁改用
  `APP_PLUGINS__DB__FILE`；内核成员门禁的"应用/Web 层"白名单补 `ctx.get`（附理由）。

### Round 7（已完成）：再补一批类型 + **注释更新改为不自动**（用户反馈）

- **类型再扩 6 个（17 → 23）**：`char`（定长，`length` 默认 1）、`tinyText` / `mediumText`
  （补齐 MySQL 的文本家族）、`tinyint`、`float`（单精度，`real` 保持双精度）、`dateTime`
  （**不带时区**：PG `timestamp` / MySQL `datetime(3)`，与带时区的 `timestamp` 区分开）。
  逐条对照三方言 + 测试；`dateTime` 与 `timestamp` 一样按 `Date` 处理。
- **注释不再自动更新**：新增注释策略 `CommentMode = 'never' | 'create' | 'always'`，
  **默认 `create`** —— 注释只在**建表那一次**写；已存在的表 `sync()` 不会碰它们，并在
  `SyncReport.unsupportedComments` 里如实说明原因（"comments are only applied when the table is created;
  pass comments: 'always' to update them"）。`always` 是显式选择（PG 的 `COMMENT ON` 幂等）；
  `never` 连建表都不写。`SyncReport` 增加 `commentsApplied` 布尔。
  策略可从 `createDatabase({ migrations: { comments } })` 或插件配置 `plugins.db.comments` 设置
  （插件会校验取值，非法值直接报错）。
- 测试 +3（新类型、默认只在建表时写、三种模式的矩阵），并**修正两条"假绿"的旧用例**：
  它们的假驱动从 `params[0]` 取建表表名，而 `CREATE TABLE` 是字面量 SQL（没有参数）——
  于是"表已存在"的判断永远为假，旧断言（"每次 sync 都重新应用注释"）其实测的是错的东西。
  修好假驱动后，旧断言按新语义改成"默认不再动注释"。

### Round 8（已完成）：自增整数主键（用户反馈）

- `FieldSpec.autoIncrement?: boolean`：**只能用在整数类型**（tinyint/smallint/integer/bigint）**且必须是主键**，
  否则 `defineModel` 直接报错（不含糊到数据库层报错）。三方言的身份策略**不同、如实生成**：
  - PostgreSQL：`"id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL PRIMARY KEY`
    （**BY DEFAULT 而不是 ALWAYS** —— 显式给 id 的插入仍然允许：数据迁移/固定 id 的测试都需要它）；
  - MySQL：`` `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY ``；
  - SQLite：`"id" integer PRIMARY KEY AUTOINCREMENT`（rowid 别名；这个写法不能夹 `NOT NULL`，专门处理）。
- **写入后回读生成值**：`Runner` 增加**可选**的 `insertReturning(sql, params)`（不破坏与 `@actor/data`
  `SqlRunner` 的结构兼容）：pg/sqlite 用 `INSERT … RETURNING`（`node:sqlite` 实测支持 ✓），
  MySQL 没有 RETURNING → 用结果里的 `insertId`。驱动若不支持回读，框架**明确报错**，绝不返回一个没有 id 的实体。
  insert 时不给主键 → **省略该列**；给主键 → 走普通 INSERT（三种方言都允许）。
- 测试 5 条（含重复 sync 幂等 + 漂移报告干净这条边界）；指南新增"自增整数主键"一节（三方言 DDL + 回读语义 + 取舍）。

### Round 9（已完成）：第 4 个方言 SQL Server（mssql）—— 用真实加方言验证 DialectSpec

- 按 `docs/design/m6-dialect-spec.md` §10 的 checklist 实际加了一个方言（T-SQL）：新增
  `dialects/mssql.ts`（完整 DialectSpec，含 `[方括号]` 引用、`@pN` 占位符、`IDENTITY(1,1)`、
  `nvarchar(n)/nvarchar(max)`、`bit`、`datetimeoffset(3)`、扩展属性注释、`INFORMATION_SCHEMA` 内省）
  与 `drivers/mssql.ts`（懒加载 `mssql`、`pool.*` 参数映射、`@pN` → 命名参数绑定、
  `SCOPE_IDENTITY()` 回读、事务 begin/commit/rollback）。
- **checklist 第一遍跑就暴露两个硬编码缺口**（已修成接口的缝）：`CREATE TABLE IF NOT EXISTS`
  与 `ALTER TABLE … ADD COLUMN` 都不是通用写法（T-SQL 分别是 `IF OBJECT_ID(…) IS NULL EXEC(…)`
  与 `ALTER TABLE t ADD c`）。
- 顺带把 `DIALECTS`/`DEFAULT_PORTS`/`DRIVER_PACKAGES` 改成从 `DIALECT_SPECS` 派生（此前手写三份，
  加方言必须回来改）。
- 定位不变：**mssql 与 pg/mysql 都是契约级验证**（离线、未真连库），指南里写明。

> **后续**：多数据库支持（Redis / MongoDB / 用户自装适配器 / 非 SQL 库的连接管控）已在
> [m7-multi-database.md](./m7-multi-database.md) 定稿设计，会把本文的连接生命周期提炼成 `@actor/db-core`。

### 待做
 —— 用户指南一篇（`docs/guide/08-database.md`）、API 页覆盖、
  接入 `@actor/app` 的示例（`examples/app-db`）+ 示例冒烟门禁、成员级门禁覆盖本包。
