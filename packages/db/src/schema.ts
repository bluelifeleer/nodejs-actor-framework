import { type Dialect } from './dialect.ts';
import { DbError } from './errors.ts';
import { columnTypeFor } from './dialect.ts';
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

export interface SyncReport {
  created: string[];
  altered: string[];
  indexes: string[];
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

/** mysql 里"索引已存在"的错误码；mysql 不支持 CREATE INDEX IF NOT EXISTS，只能容忍它。 */
const MYSQL_DUPLICATE_INDEX = /ER_DUP_KEYNAME|Duplicate key name/i;

function quoteIdent(dialect: Dialect, name: string): string {
  const ch = dialect === 'mysql' ? '`' : '"';
  return `${ch}${String(name).split(ch).join(ch + ch)}${ch}`;
}

/**
 * 类型规范化：只为了让"model 说的类型"与"数据库报告的类型"可比。
 * 这是**宽松**比较（文档里写明），目的是抓"明显不一致"，不是做完整的类型系统。
 */
export function normalizeDbType(dialect: Dialect, rawType: string, options: { length?: number | null } = {}): string {
  let text = String(rawType).toLowerCase().trim();
  if (dialect === 'pgsql') {
    if (text === 'character varying') text = 'varchar';
    if (text === 'timestamp with time zone') text = 'timestamptz';
    if (text === 'timestamp without time zone') text = 'timestamp';
  }
  const length = options.length ?? null;
  const needsLength = /^(varchar|char|character)$/.test(text) && length !== null && !text.includes('(');
  return needsLength ? `${text}(${length})` : text;
}

/** 内省 SQL（按方言不同；sqlite 用 sqlite_master + PRAGMA，pg/mysql 用 information_schema）。 */
export function tableExistsSql(dialect: Dialect): string {
  if (dialect === 'sqlite') return 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?';
  if (dialect === 'pgsql') return 'SELECT 1 AS found FROM information_schema.tables WHERE table_name = $1';
  return 'SELECT 1 AS found FROM information_schema.tables WHERE table_name = ? AND table_schema = DATABASE()';
}

export function columnsSql(dialect: Dialect): string {
  if (dialect === 'sqlite') return ''; // PRAGMA 不支持参数，单独处理
  if (dialect === 'pgsql') {
    return (
      'SELECT column_name, is_nullable, data_type, character_maximum_length, column_default ' +
      'FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position'
    );
  }
  return (
    'SELECT column_name, is_nullable, column_type, column_default ' +
    'FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE() ORDER BY ordinal_position'
  );
}

/** 读一张表的实况（表不存在时 `exists: false`）。 */
export async function inspectTable(dialect: Dialect, runner: Runner, table: string): Promise<TableInfo> {
  if (dialect === 'sqlite') {
    const found = await runner.all(tableExistsSql('sqlite'), ['table', table]);
    if (found.length === 0) return { table, exists: false, columns: [] };
    // PRAGMA 不支持占位符；表名走引号转义（标识符注入不可能）
    const rows = await runner.all(`PRAGMA table_info(${quoteIdent('sqlite', table)})`);
    return {
      table,
      exists: true,
      columns: rows.map((row: Row) => ({
        name: String(row.name),
        type: normalizeDbType('sqlite', String(row.type ?? '')),
        rawType: String(row.type ?? ''),
        notNull: Number(row.notnull) === 1 || Number(row.pk) === 1,
        hasDefault: row.dflt_value !== null && row.dflt_value !== undefined,
      })),
    };
  }

  const found = await runner.all(tableExistsSql(dialect), [table]);
  if (found.length === 0) return { table, exists: false, columns: [] };
  const rows = await runner.all(columnsSql(dialect), [table]);
  return {
    table,
    exists: true,
    columns: rows.map((row: Row) => {
      const rawType = String(row.data_type ?? row.column_type ?? '');
      const length = row.character_maximum_length === undefined || row.character_maximum_length === null
        ? null
        : Number(row.character_maximum_length);
      return {
        name: String(row.column_name),
        type: normalizeDbType(dialect, rawType, { length }),
        rawType,
        notNull: String(row.is_nullable).toUpperCase() === 'NO',
        hasDefault: row.column_default !== null && row.column_default !== undefined,
      };
    }),
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
  const report: SyncReport = { created: [], altered: [], indexes: [], comments: [], unsupportedComments: [] };
  for (const model of models) {
    const info = await inspectTable(dialect, runner, model.table);
    if (!info.exists) {
      await runner.run(model.createTableSql(dialect));
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
    // 注释：pg 走独立的（幂等）COMMENT 语句；mysql 只在建表时内联；sqlite 不支持 → 如实报告
    const declaredComments: string[] = [
      ...(model.comment === undefined ? [] : [model.table]),
      ...model.fields.filter((field) => field.comment !== undefined).map((field) => `${model.table}.${field.column}`),
    ];
    if (declaredComments.length > 0) {
      if (dialect === 'pgsql') {
        for (const statement of model.commentSql(dialect)) {
          await runner.run(statement);
        }
        report.comments.push(...declaredComments);
        options.logger?.('db_comments_applied', { table: model.table, count: declaredComments.length });
      } else if (dialect === 'sqlite') {
        report.unsupportedComments.push(...declaredComments.map((target) => `${target} (sqlite has no column/table comments)`));
      } else if (info.exists) {
        // MySQL：注释写在建表语句里，已存在的表不会被自动改注释（要改得 ALTER MODIFY，风险自负）
        report.unsupportedComments.push(
          ...declaredComments.map((target) => `${target} (mysql comments are only applied at CREATE TABLE)`),
        );
      } else {
        report.comments.push(...declaredComments); // 刚建表 → 注释已内联
      }
    }

    for (const index of model.indexes) {
      try {
        await runner.run(model.createIndexSql(dialect, index));
        report.indexes.push(index.name);
      } catch (err) {
        // mysql 没有 CREATE INDEX IF NOT EXISTS：已存在就当成功（如实不报进 indexes）
        if (dialect === 'mysql' && MYSQL_DUPLICATE_INDEX.test(err instanceof Error ? err.message : String(err))) {
          options.logger?.('db_index_exists', { table: model.table, index: index.name });
          continue;
        }
        throw err;
      }
    }
  }
  return report;
}
