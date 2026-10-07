import { type Dialect } from './dialect.ts';
import { DbError } from './errors.ts';
import { columnTypeFor } from './dialect.ts';
import { dialectSpec } from './dialects/index.ts';
import type { Field, Model } from './model.ts';
import type { Row, Runner } from './drivers/types.ts';

/** 库里一列的实况（内省结果）。 */
export interface ColumnInfo {
  name: string;
  /** 方言报告的类型原文（已规范化用于比较，`rawType` 保留原文便于诊断）。 */
  type: string;
  rawType: string;
  notNull: boolean;
  hasDefault: boolean;
}

export interface TableInfo {
  table: string;
  exists: boolean;
  columns: ColumnInfo[];
}

export interface DriftReport {
  ok: boolean;
  table: string;
  tableMissing: boolean;
  /** model 有、库里没有的列。 */
  missingColumns: Array<{ field: string; column: string; type: string }>;
  /** 两边都有、但类型（规范化后）不一致的列。 */
  typeMismatches: Array<{ column: string; expected: string; actual: string }>;
}

/** 注释策略：`never` 从不写；`create`（默认）只在建表那一次写；`always` 每次 sync 都重新应用。 */
export type CommentMode = 'never' | 'create' | 'always';

export interface SyncReport {
  created: string[];
  altered: string[];
  indexes: string[];
  /** 这次 sync 是否真的应用了注释（`never` / 已存在的表 / sqlite 上都是 false）。 */
  commentsApplied: boolean;
  /** 成功应用了注释的目标（形如 `notes` / `notes.title`）。 */
  comments: string[];
  /**
   * **没有**被应用的注释目标 + 原因（形如 `notes.title (sqlite has no column comments)`）。
   *
   * 为什么不静默：注释是给人看的 schema 文档，悄悄丢掉会让人以为库里已经有注释了。
   */
  unsupportedComments: string[];
}

/** schema 漂移/需要人工迁移：错误里带上具体差异，绝不"悄悄跳过"。 */
export class DbSchemaDriftError extends DbError {
  readonly drift: DriftReport;
  constructor(message: string, drift: DriftReport) {
    super(message, 'DB_SCHEMA_DRIFT');
    this.name = 'DbSchemaDriftError';
    this.drift = drift;
  }
}

/**
 * 类型规范化：只为了让"model 说的类型"与"数据库报告的类型"可比。
 * 这是**宽松**比较（文档里写明），目的是抓"明显不一致"，不是做完整的类型系统。
 * 实现已搬到方言描述符（pg 的别名映射 + 三方言共用的通用规则）。
 */
export function normalizeDbType(dialect: Dialect, rawType: string, options: { length?: number | null } = {}): string {
  return dialectSpec(dialect).normalizeDbType(rawType, options);
}

/**
 * 表存在性 SQL（按方言不同；由方言描述符提供）。
 * `table` 省略时用占位符，便于展示 SQL 形状。
 */
export function tableExistsSql(dialect: Dialect, table = '?'): string {
  return dialectSpec(dialect).introspection.tableExists(table).sql;
}

/**
 * 列内省 SQL（sqlite 是 PRAGMA 形状 —— 它不支持占位符，所以单独处理）。
 * `table` 省略时用占位符。
 */
export function columnsSql(dialect: Dialect, table = '?'): string {
  const columns = dialectSpec(dialect).introspection.columns(table);
  return 'sql' in columns ? columns.sql : columns.pragma;
}

/** 读一张表的实况（表不存在时 `exists: false`）；SQL 与行形状都由方言描述符给。 */
export async function inspectTable(dialect: Dialect, runner: Runner, table: string): Promise<TableInfo> {
  const impl = dialectSpec(dialect);
  const existence = impl.introspection.tableExists(table);
  const found = await runner.all(existence.sql, existence.params);
  if (found.length === 0) return { table, exists: false, columns: [] };

  const columns = impl.introspection.columns(table);
  const rows = 'pragma' in columns ? await runner.all(columns.pragma) : await runner.all(columns.sql, columns.params);
  return {
    table,
    exists: true,
    columns: rows.map((row) => impl.introspection.toColumn(row as Record<string, unknown>)),
  };
}

/** 比对 model 与库里实况。 */
export function checkDrift(dialect: Dialect, model: Model, info: TableInfo): DriftReport {
  if (!info.exists) {
    return { ok: false, table: model.table, tableMissing: true, missingColumns: [], typeMismatches: [] };
  }
  const byColumn = new Map(info.columns.map((column) => [column.name, column]));
  const missingColumns: DriftReport['missingColumns'] = [];
  const typeMismatches: DriftReport['typeMismatches'] = [];

  for (const field of model.fields) {
    const actual = byColumn.get(field.column);
    if (actual === undefined) {
      missingColumns.push({ field: field.name, column: field.column, type: field.type });
      continue;
    }
    const expected = columnTypeFor(dialect, field.type, field.length === undefined ? {} : { length: field.length });
    const expectedNormalized = normalizeDbType(dialect, expected);
    if (expectedNormalized !== actual.type) {
      typeMismatches.push({ column: field.column, expected: expectedNormalized, actual: actual.type });
    }
  }
  return {
    ok: missingColumns.length === 0 && typeMismatches.length === 0,
    table: model.table,
    tableMissing: false,
    missingColumns,
    typeMismatches,
  };
}

function describeDrift(drift: DriftReport): string {
  const parts: string[] = [];
  if (drift.missingColumns.length > 0) {
    parts.push(`missing columns: ${drift.missingColumns.map((c) => c.column).join(', ')}`);
  }
  if (drift.typeMismatches.length > 0) {
    parts.push(
      `type mismatches: ${drift.typeMismatches.map((c) => `${c.column} (model ${c.expected} vs db ${c.actual})`).join(', ')}`,
    );
  }
  return parts.join('; ');
}

/**
 * 一条"加列"能不能**安全**自动做。
 *
 * 安全 = 新列对已有行有值可填：有默认值，或允许 NULL。
 * 不安全（NOT NULL 且无默认值、或要加主键）→ 必须由人写迁移（否则等于静默丢语义）。
 */
function canAutoAdd(field: Field): { ok: boolean; reason?: string } {
  if (field.primaryKey) return { ok: false, reason: 'adding a primary key column to an existing table is not automatic' };
  if (field.notNull && !field.hasDefault) {
    return { ok: false, reason: `column "${field.column}" is NOT NULL without a default — existing rows would be invalid` };
  }
  return { ok: true };
}

export interface SyncOptions {
  /** 是否允许自动 ALTER（默认 false：`sync` 只建不改）。 */
  auto?: boolean;
  /**
   * 注释策略（默认 `create`）：**已存在的表不会被自动更新注释** —— 注释是给人看的 schema 文档，
   * 改它应当是一个显式决定（`always`），而不是每次部署顺手改一遍。
   */
  comments?: CommentMode;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

/**
 * 建表 + 建索引 + （可选）安全加列。
 *
 * 设计约束（见 docs/design/m6-db-package.md §4）：
 *   - 表不存在 → `CREATE TABLE IF NOT EXISTS` + 索引；
 *   - 表存在但**漂移** → 默认**抛错**（列出差异）；只有 `auto: true` 才做安全操作；
 *   - 删列/改类型/加 NOT NULL 无默认值 → 一律拒绝并说明原因（这是运维决策，不是框架决策）。
 */
export async function syncModels(
  dialect: Dialect,
  runner: Runner,
  models: readonly Model[],
  options: SyncOptions = {},
): Promise<SyncReport> {
  const impl = dialectSpec(dialect);
  const commentMode: CommentMode = options.comments ?? 'create';
  const report: SyncReport = {
    created: [],
    altered: [],
    indexes: [],
    commentsApplied: false,
    comments: [],
    unsupportedComments: [],
  };
  for (const model of models) {
    const info = await inspectTable(dialect, runner, model.table);
    const wasCreated = !info.exists;
    if (wasCreated) {
      await runner.run(model.createTableSql(dialect, { comments: commentMode !== 'never' }));
      report.created.push(model.table);
      options.logger?.('db_table_created', { table: model.table });
    } else {
      const drift = checkDrift(dialect, model, info);
      if (!drift.ok) {
        if (drift.typeMismatches.length > 0) {
          // 改类型必须人工迁移（不同方言的改写语义差别很大，自动做太危险）
          throw new DbSchemaDriftError(
            `table "${model.table}" does not match model "${model.name}": ${describeDrift(drift)}. ` +
              'Type changes are never automatic — write a migration.',
            drift,
          );
        }
        if (options.auto !== true) {
          throw new DbSchemaDriftError(
            `table "${model.table}" does not match model "${model.name}": ${describeDrift(drift)}. ` +
              'Pass migrations: { auto: true } to apply safe additions automatically, or write a migration.',
            drift,
          );
        }
        for (const missing of drift.missingColumns) {
          const field = model.fieldFor(missing.field);
          const allowed = canAutoAdd(field);
          if (!allowed.ok) {
            throw new DbSchemaDriftError(
              `table "${model.table}" is missing "${missing.column}" and it cannot be added automatically: ` +
                `${String(allowed.reason)}. Write a migration.`,
              drift,
            );
          }
          await runner.run(model.addColumnSql(dialect, field));
          options.logger?.('db_column_added', { table: model.table, column: missing.column });
        }
        report.altered.push(model.table);
      }
    }
    /**
     * 注释：默认**只在建表时**写（`create`）。已存在的表不会被自动更新 —— 想让它每次同步就用
     * `comments: 'always'`（显式选择）。方言差异如实报告，不假装：
     *   - MySQL：注释内联在建表语句里；已存在表要改注释得 `ALTER … MODIFY COLUMN`（框架不替你做）；
     *   - PostgreSQL：`COMMENT ON …`（幂等），`create` 模式只在建表时发、`always` 每次发；
     *   - SQLite：没有列/表注释这回事。
     */
    const declaredComments: string[] = [
      ...(model.comment === undefined ? [] : [model.table]),
      ...model.fields.filter((field) => field.comment !== undefined).map((field) => `${model.table}.${field.column}`),
    ];
    if (declaredComments.length > 0) {
      if (commentMode === 'never') {
        report.unsupportedComments.push(
          ...declaredComments.map((target) => `${target} (comments disabled: comments: 'never')`),
        );
      } else if (impl.comments === 'none') {
        report.unsupportedComments.push(...declaredComments.map((target) => `${target} (${dialect} has no column/table comments)`));
      } else if (impl.comments === 'statements') {
        const shouldApply = commentMode === 'always' || wasCreated;
        if (shouldApply) {
          for (const statement of model.commentSql(dialect)) await runner.run(statement);
          report.comments.push(...declaredComments);
          report.commentsApplied = true;
          options.logger?.('db_comments_applied', { table: model.table, count: declaredComments.length });
        } else {
          report.unsupportedComments.push(
            ...declaredComments.map(
              (target) => `${target} (comments are only applied when the table is created; pass comments: 'always' to update them)`,
            ),
          );
        }
      } else if (wasCreated) {
        report.comments.push(...declaredComments); // 刚建表 → 注释已内联在 CREATE TABLE 里
        report.commentsApplied = true;
      } else {
        report.unsupportedComments.push(
          ...declaredComments.map((target) => `${target} (${dialect} comments are only applied at CREATE TABLE)`),
        );
      }
    }

    for (const index of model.indexes) {
      try {
        await runner.run(model.createIndexSql(dialect, index));
        report.indexes.push(index.name);
      } catch (err) {
        // mysql 没有 CREATE INDEX IF NOT EXISTS：已存在就当成功（如实不报进 indexes）
        if (dialectSpec(dialect).isDuplicateIndexError(err)) {
          options.logger?.('db_index_exists', { table: model.table, index: index.name });
          continue;
        }
        throw err;
      }
    }
  }
  return report;
}
