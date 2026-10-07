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

### 待做

- **Round 3：ORM 映射层 + 仓储 + 关联** —— 实体↔行映射（列名/JSON/时间戳/version 乐观锁）、
  `db.repository(Model)`、`hasMany/belongsTo` 声明与查询构造、错误类型（冲突/未找到）。
- **Round 4：文档与门禁收尾** —— 用户指南一篇（`docs/guide/08-database.md`）、API 页覆盖、
  接入 `@actor/app` 的示例（`examples/app-db`）+ 示例冒烟门禁、成员级门禁覆盖本包。
