# M6 设计：方言描述符（`DialectSpec`）—— 让"加方言"只写一个文件

> 起因（用户提问）：`columnTypeFor` 现在的形状"类型一多就不合理了"。这个判断是对的：
> 它把**方言知识**写成了散落的三目分支，代码点随"类型 × 方言"增长。

## 1. 现状诊断（实测，不是印象）

| 指标 | 实测值 |
|---|---|
| `columnTypeFor` 体量 | **69 行 / 22 个 `case`**，每个 case 里 1~3 个三目 |
| 方言分支 `dialect === '…'` | **52 处** |
| 分布 | `dialect.ts` 30、`schema.ts` 10、`model.ts` 10、`mapping.ts` 2 |
| 事实总量 | 23 个逻辑类型 × 3 方言 ≈ **69 个类型事实**（这部分是本质复杂度，抹不掉） |

两个坏味道：

1. **代码点 = O(类型 × 方言)**。加一个类型要在 `columnTypeFor` 加一个 case（3 段三目）；
   加一个方言要改 **52 处**。而本质复杂度只是 O(类型 + 方言) 的**数据**。
2. **三目只适合 2~3 路分支**。现在恰好 3 路；加第 4 个方言（SQL Server / Oracle）必然变成嵌套三目。
3. 顺带一个类型安全漏洞：`{ length?, precision?, scale? }` 是个扁平口袋，
   `columnTypeFor('pgsql', 'integer', { precision: 8 })` 编译期不报错，只有运行时才发现无意义。

## 2. 目标与非目标

**目标**
- 把所有"随方言而异"的知识收进**每个方言一个对象**：加方言 = 加一个文件 + 注册表一行，其它代码零改动。
- 类型映射变成**表**（方案 A），作为 `DialectSpec.columnType` 的内部实现。
- 公开 API 与行为**完全不变**（现有 704+ 条测试是安全网）。
- 加一条**可证伪的门禁**：`dialects/` 之外不允许再出现按方言名的分支。

**非目标**
- 不做"能力模型"（`hasNativeUuid` 这类抽象）——见 §9。
- 不把 SQL 生成整体搬到方言层（查询构造仍走既有的参数化 + 引号函数）。
- 不动驱动层的加载/池管理（那是"驱动"，不是"方言"；两者已经分开）。

## 3. `DialectSpec` 接口

```ts
// packages/db/src/dialects/types.ts
export interface ColumnTypeOptions { length?: number; precision?: number; scale?: number }

/** 一个方言的**全部**差异点。新增方言 = 实现这个接口 + 在 DIALECTS 登记。 */
export interface DialectSpec {
  readonly name: Dialect;
  /** 懒加载的驱动包名（sqlite 是内置模块，不需要装）。 */
  readonly driverPackage: string;
  readonly defaultPort: number | null;

  // --- 语法层面 ---------------------------------------------------------
  placeholder(index: number): string;                 // '$1' | '?'
  quote(name: string): string;                        // '"x"' | '`x`'
  quoteTable(schema: string | undefined, table: string): string;  // sqlite 忽略 schema
  /** 索引是否支持 `IF NOT EXISTS`（MySQL 不支持 → 由 schema 层容忍"已存在"）。 */
  readonly indexIfNotExists: boolean;
  /** 该方言是否支持 `INSERT … RETURNING`。 */
  readonly supportsReturning: boolean;
  /** 从 INSERT 结果里取出生成的主键（pg/sqlite 取列值；mysql 取 `insertId`）。 */
  generatedId(rows: Row[], primaryColumn: string): unknown;

  // --- 类型与列定义 -----------------------------------------------------
  /** 逻辑类型 → 真实列类型（内部实现是 §4 的类型表）。 */
  columnType(logical: LogicalType, options: ColumnTypeOptions): string;
  /** 列定义的**方言附加片段**：自增身份、内联注释（顺序由方言决定）。 */
  columnExtras(field: Field, options: { withComments: boolean }): string[];
  /** 默认值字面量；返回 `null` 表示"这个方言不给这种列写默认值"（如 MySQL 的 TEXT/JSON/BLOB）。 */
  defaultLiteral(field: Field, value: unknown): string | null;
  /** 注释能力：`inline`（MySQL 内联在建表语句）/ `statements`（PG 的 COMMENT ON）/ `none`（SQLite）。 */
  readonly comments: 'inline' | 'statements' | 'none';
  /** `statements` 方言生成 COMMENT 语句（幂等）；其它方言返回 `[]`。 */
  commentStatements(model: Model): string[];
  /** 建表语句的表级后缀（MySQL 的 `COMMENT='…'`）。 */
  tableSuffix(model: Model, options: { withComments: boolean }): string;
  /** 注释字面量的方言校验（MySQL 1024 上限、单引号转义）。 */
  commentLiteral(text: string, what: string): string;

  // --- 内省与规范化 -----------------------------------------------------
  introspection: {
    /** 表是否存在（sqlite 走 sqlite_master，pg/mysql 走 information_schema）。 */
    tableExists(table: string): { sql: string; params: readonly unknown[] };
    /** 列内省；sqlite 是 PRAGMA（**不支持占位符**），所以形状允许 `{ pragma }`。 */
    columns(table: string): { sql: string; params: readonly unknown[] } | { pragma: string };
  };
  /** 把数据库报告的类型规范化到可比形式（pg 的 `character varying` → `varchar(n)` 等）。 */
  normalizeDbType(rawType: string, options: { length?: number | null }): string;
  /** 错误容忍：MySQL 的"索引已存在"（它没有 IF NOT EXISTS）。 */
  isDuplicateIndexError(error: unknown): boolean;

  // --- 值的表示（领域 ↔ 库）--------------------------------------------
  parseValue(field: Field, raw: unknown): unknown;
  serializeValue(field: Field, value: unknown): unknown;

  // --- 连接形状 ---------------------------------------------------------
  /** DSN → 连接字段（sqlite 取 filename，其它解析 host/port/user/password/database）。 */
  connectionFromUrl(url: string): NormalizedConnection;
  /** 只用于日志/错误：不含密码。 */
  describeConnection(connection: NormalizedConnection): string;
}

// 注意命名：公开的 `DIALECTS` 是 `readonly Dialect[]`（保持不变），描述符注册表另起名
export const DIALECT_SPECS: Record<Dialect, DialectSpec>;
export function dialectSpec(dialect: Dialect): DialectSpec;  // 未知方言 → DbConfigError
```

## 4. 类型映射：方案 A（表驱动）作为 `columnType` 的内部实现

```ts
// packages/db/src/dialects/pgsql.ts（片段）
type Render = (o: ColumnTypeOptions) => string;

const TYPES: Record<LogicalType, Render> = {   // ← 一个方言一张表，TS 强制补齐每个类型
  uuid:    () => 'uuid',
  string:  (o) => (o.length === undefined ? 'text' : `varchar(${o.length})`),
  char:    (o) => `char(${o.length ?? 1})`,
  tinyint: () => 'smallint',
  decimal: (o) => `numeric(${o.precision ?? 10}, ${o.scale ?? 2})`,
  timestamp: () => 'timestamptz',
  // …
};

export const pgsql: DialectSpec = { name: 'pgsql', columnType: (t, o) => TYPES[t](o), /* … */ };
```

要点：
- **加类型**：在 3 张表各加一行（TS 会强迫你补齐，漏一个编译期就报错）。
- **加方言**：新写一张 `TYPES` 表 + 实现接口，**不改任何现有文件**（除了注册表）。
- **参数改判别联合**（可选的第二步）：`{ type: 'decimal'; precision?: number; scale?: number }` 这种形状让
  "给 `text` 传 `precision`" 变成编译错误。`FieldSpec` 保持现在的扁平写法不变（运行时校验），
  避免破坏使用者代码。

## 5. 52 处现有分支 → 归属映射表（逐条）

| 文件:行 | 现在做什么 | 归到 |
|---|---|---|
| dialect.ts:71 | `$n` vs `?` | `placeholder()` |
| dialect.ts:76 | 引号字符 | `quote()` |
| dialect.ts:87 | sqlite 无 schema | `quoteTable()` |
| dialect.ts:95–158（20 处） | 23 个类型的方言三目 | `columnType()`（内部 §4 类型表） |
| dialect.ts:225 / 243 | DSN 的 sqlite 分支（filename） | `connectionFromUrl()` |
| dialect.ts:262 | `describeConnection` 的 sqlite 分支 | `describeConnection()` |
| model.ts:166 | 引号字符 | `quote()` |
| model.ts:179 | pg 布尔字面量 `TRUE/FALSE` | `defaultLiteral()` |
| model.ts:185 | pg 的 `'…'::jsonb` | `defaultLiteral()` |
| model.ts:194 | MySQL 注释 1024 上限 | `commentLiteral()` |
| model.ts:212 | sqlite 的 `INTEGER PRIMARY KEY AUTOINCREMENT` | `columnExtras()` |
| model.ts:216 / 218 | pg IDENTITY / mysql AUTO_INCREMENT | `columnExtras()` |
| model.ts:223 / 364 | MySQL 内联列/表注释 | `columnExtras()` / `tableSuffix()` |
| model.ts:387 | mysql 无 `CREATE INDEX IF NOT EXISTS` | `indexIfNotExists` |
| schema.ts:66 | 引号字符 | `quote()` |
| schema.ts:76 | pg 类型别名规范化 | `normalizeDbType()` |
| schema.ts:88 / 89 | 表存在性 SQL | `introspection.tableExists()` |
| schema.ts:94 / 95 / 109 | 列内省 SQL（含 sqlite 的 PRAGMA） | `introspection.columns()` |
| schema.ts:297 / 299 | 注释能力与策略分支 | `comments` + `commentStatements()` |
| schema.ts:329 | mysql 索引重复错误容忍 | `isDuplicateIndexError()` |
| mapping.ts:66 | pg 布尔就是 boolean | `parseValue()` |
| mapping.ts:73 | sqlite 时间戳存 ISO 串 | `serializeValue()` |

合计 **52 处**，每一处都有明确归属，没有"剩下的看着办"。

## 6. 分步迁移（每步结束都必须全绿）

1. **骨架 + 参数化（不改行为）**：新增 `dialects/types.ts`、`dialects/{pgsql,mysql,sqlite}.ts`（先只实现
   `placeholder/quote/quoteTable/columnType/supportsReturning/defaultPort/driverPackage`），
   `dialect.ts` 的公开函数改为委托给 `DIALECTS[dialect]`。加**契约测试**：遍历 3 方言 × 23 类型，
   断言每个组合都有结果且是字符串（覆盖完整性由 TS 的 `Record<LogicalType, …>` 保证）。
2. **列定义与注释**：把 `model.ts` 的 10 处搬走（`columnExtras`/`defaultLiteral`/`commentLiteral`/
   `tableSuffix`/`commentStatements`/`indexIfNotExists`）。`model.ts` 里不再出现方言名。
3. **内省与值表示**：搬走 `schema.ts` 的 10 处与 `mapping.ts` 的 2 处。`schema.ts`/`mapping.ts`
   里不再出现方言名。
4. **收口 + 门禁**：搬走 `dialect.ts` 剩余的连接形状分支；加门禁测试
   （`dialects/` 之外 grep 不到 `dialect === '`），并在测试里**定义一个假的第 4 方言**
   （例如把 sqlite 的行改个名）证明"只实现接口就能获得完整的 DDL/内省/映射能力"。

## 7. 兼容性

**公开 API 保持不变**（内部改为查表，签名一字不改）：

`columnTypeFor` / `placeholderFor` / `quoteIdentifier` / `quoteTable` / `supportsReturning` /
`DIALECTS`（仍是 `readonly Dialect[]`）/ `DEFAULT_PORTS` / `DRIVER_PACKAGES` / `assertDialect` /
`parseConnection` / `describeConnection` / `dialectFromUrl` / `dialectFor` / `ColumnTypeOptions`。

新增（非破坏性）：`DialectSpec` 类型、`dialectSpec(dialect)`。

行为不变由三层兜底：现有 **704 条**测试、文档里的 `verify` 示例（真跑）、DDL 文本的逐条对照测试。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 大改动引入行为漂移 | 分 4 步、每步全绿；DDL 文本已有逐条对照测试（`createTableSql` 三方言原文） |
| 接口设计得太"通用"反而难用 | 接口只描述**已经存在的事实**（52 处），不预留假设性能力；先搬后抽象 |
| `introspection` 的 PRAGMA 形状特殊 | 显式允许 `{ pragma }` 分支，而不是硬塞进 `{sql, params}` |
| 假方言用例变成"自娱自乐" | 假方言必须**复用真实路径**（通过 `db.sync()`/仓储跑一遍），不是只调一个函数 |

## 9. 明确不做：能力模型（capabilities）

把差异抽象成 `hasNativeUuid` / `hasFixedChar` 这类能力，理论上事实数是 O(类型 + 方言)。
但真实差异不是能力能表达的：MySQL 的 `tinytext/mediumtext/longtext` 家族、PG 的
`GENERATED BY DEFAULT IDENTITY`、SQLite 的 `PRAGMA table_info`（连占位符都不支持）、
MySQL 的 `insertId`（没有 RETURNING）。这些最终会退化成 `if (name === 'mysql')` 特例，
比"每个方言一个对象"更难读、更难测。**结论：不采用。**

## 10. 以后加方言的 checklist（这就是这次重构的产出）

1. 复制 `dialects/sqlite.ts` 起手；实现 `DialectSpec`（TypeScript 会逐项提示）。
2. 在 `DIALECT_SPECS` 注册表加一行；`DIALECTS`/`DEFAULT_PORTS`/`DRIVER_PACKAGES` 自动包含它。
3. 写驱动（`drivers/<name>.ts`）：`all/run/insertReturning/transaction/healthCheck/close`。
4. 跑契约测试（3 方言 × 23 类型自动扩到 4 方言 × 23 类型）。
5. 文档：指南的类型对照表加一列。
   —— 不需要碰 `model.ts` / `schema.ts` / `repository.ts` / `mapping.ts`（门禁会保证这点）。

## 11. 实施进度

- **Step 1（已完成）**：新增 `dialects/types.ts`（`DialectSpec` 接口 + 类型定义 + 三方言共用的
  "未知类型要报错"守卫）与 `dialects/{pgsql,mysql,sqlite}.ts`（各一张 `Record<LogicalType, Render>`
  类型表 + `placeholder`/`quote`/`quoteTable`/`supportsReturning`/`defaultPort`/`driverPackage`），
  以及 `DIALECT_SPECS` 注册表 + `dialectSpec()`。`dialect.ts` 的公开函数改为**委托**
  （`columnTypeFor`/`placeholderFor`/`quoteIdentifier`/`quoteTable`/`supportsReturning`），
  `DEFAULT_PORTS`/`DRIVER_PACKAGES` 由描述符派生（单一事实来源）；类型定义搬到 `dialects/types.ts`
  后再导出，公开 API 一字不改。新增契约测试 3 条（注册表覆盖、未知方言报错、公开函数与描述符结果一致）。
  **方言分支 52 → 25**（`dialect.ts` 30 → 3，剩下 3 处是连接形状，属于 Step 4）；全量 707/707 绿。
  期间自我修正一处：守卫最初自己造了个平行错误类 `DialectConfigError`，被既有测试抓到
  （断言 `instanceof DbConfigError`）——已改为复用公开的 `DbConfigError`（`errors.ts` 是叶子模块，无循环依赖）。

## 12. 实施进度（续）

- **Step 2（已完成）**：`DialectSpec` 补上 `autoIncrementPieces`（**结构化**返回而不是拼字符串：
  PG 的 `beforeNotNull`、MySQL 的 `afterNotNull`、SQLite 的 `override` 接管整列，位置差异由共享骨架保证）、
  `defaultLiteral`（含"这个方言不给这种列写默认值"的 `null`）、`inlineComment`、`tableSuffix`、
  `commentStatements`、`indexIfNotExists`、`isDuplicateIndexError`；新增 `RenderableField`/`RenderableModel`
  **视图类型**（`Field`/`Model` 结构上满足它们），这样 `dialects/` 不必反向 import `model.ts`（避免循环依赖）。
  `model.ts` 的列定义改成"**共享骨架 + 方言数据**"：`列名 类型 [NOT NULL 前的片段] NOT NULL [后的片段] 约束
  [DEFAULT] [内联注释]` —— 三方言一致的约束（主键隐含 NOT NULL、PRIMARY KEY 与 UNIQUE 互斥）只写一遍，
  方言只提供片段；`schema.ts` 的"索引已存在"容忍也改为 `spec.isDuplicateIndexError()`。
  **方言分支 25 → 14，`model.ts` 归零（10 → 0）**；全量 709/709 绿。
- **顺带修掉一个真 bug**：`precision`/`scale` 只写在 `FieldSpec` 上、从没拷进 `Field`，也从没进过 DDL ——
  声明 `{ type: 'decimal', precision: 18, scale: 4 }` 会被**静默忽略**成 `numeric(10, 2)`。
  现在真的传下去了（并补了三方言 DDL 断言 + sqlite 真库插入断言）。
- **顺带收口一处方言遗漏**：MySQL 的 TEXT 家族（`tinyText`/`mediumText`/`bigText`）此前不在
  "不给默认值"的名单里，会生成 MySQL 不接受的 `DEFAULT`；现在名单覆盖整个 TEXT/JSON/BLOB 家族。

## 13. 实施进度（续 2）

- **Step 3（已完成）**：`DialectSpec` 补上 `introspection`（`tableExists`/`columns`/`toColumn` ——
  SQLite 的 PRAGMA 用 `{ pragma }` 形状，行形状也由各方言自己归一）、`normalizeDbType`
  （方言别名映射 + 三方言共用的 `normalizeTypeText`）、`serializeBoolean`、`serializeTimestamp`、
  `comments` 能力位。`schema.ts` 与 `mapping.ts` 的方言分支全部搬走。
  **方言分支 14 → 3**（`model.ts`/`schema.ts`/`mapping.ts` 全部归零，只剩 `dialect.ts` 的 3 处连接形状属于 Step 4）。
  全量 709/709 绿（`tableExistsSql`/`columnsSql` 保持导出，SQL 文本对 pg/mysql **一字不变**，
  sqlite 从"返回空串"改成返回 `PRAGMA` 形状 —— 更诚实）。
- **设计澄清（重要）**：接口里最初写的 `parseValue`/`serializeValue` 太大 —— 实际只有**两处**真正随方言而异
  （写库的布尔 `true/false` vs `1/0`、sqlite 的时间戳要 ISO 文本），而**解析**布尔是通用的
  （`Number(value) === 1`）、JSON/日期/数字的处理也是通用的。按"接口只描述真实存在的差异"的原则，
  最终只加 `serializeBoolean`/`serializeTimestamp`（我自己写的测试先按老草图断言了 `coerceBoolean`，
  发现它在三方言下没有差异后删掉了 —— 不为想象出来的差异造接口）。

## 14. 验收

- [ ] `dialects/` 之外 grep 不到 `dialect === '`（门禁测试，可证伪）。
- [ ] 契约测试覆盖 3 方言 × 23 类型（TS 的 `Record` 保证不遗漏）。
- [ ] 测试里的**假第 4 方言**能通过 `createDatabase` + `sync` + 仓储 CRUD（证明"加方言 = 一个文件"）。
- [ ] 现有 704+ 条测试、`npm run typecheck`（源码 + 声明面）、`docs:build` 全绿。
- [ ] DDL 文本逐条对照测试**一字不改**地通过（证明行为没变）。
