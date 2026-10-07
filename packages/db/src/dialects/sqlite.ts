import {
  normalizeTypeText,
  numericLiteral,
  sqlString,
  typeRendererFor,
  type ColumnTypeOptions,
  type DialectSpec,
  type LogicalType,
  type RenderableField,
  type TypeRenderers,
} from './types.ts';

/**
 * SQLite 的类型表（方案 A）。
 *
 * SQLite 没有真正的类型系统（只有"类型亲和性"），所以这里全部落到五种亲和性里：
 * `text` / `integer` / `real` / `blob` / `numeric`。**如实**，不假装它有 varchar/date/jsonb。
 */
const TYPES: TypeRenderers = {
  uuid: () => 'text',
  string: () => 'text',
  char: () => 'text', // 没有定长概念
  text: () => 'text',
  tinyText: () => 'text',
  mediumText: () => 'text',
  bigText: () => 'text',
  tinyint: () => 'integer',
  smallint: () => 'integer',
  integer: () => 'integer',
  bigint: () => 'integer',
  decimal: (o) => `numeric(${o.precision ?? 10}, ${o.scale ?? 2})`, // NUMERIC 亲和性，不会退化成浮点
  float: () => 'real',
  real: () => 'real',
  boolean: () => 'integer', // 存 0/1，领域里由映射层还原成 boolean
  date: () => 'text', // 'YYYY-MM-DD'，字典序 == 时间序
  time: () => 'text', // 'HH:MM:SS'
  timestamp: () => 'text', // ISO 串
  dateTime: () => 'text',
  json: () => 'text', // TEXT + 编解码
  blob: () => 'blob',
  binary: () => 'blob',
};

function quote(name: string): string {
  return `"${String(name).split('"').join('""')}"`;
}

export const sqlite: DialectSpec = {
  name: 'sqlite',
  driverPackage: 'node:sqlite', // 内置模块，不需要安装
  defaultPort: null,
  placeholder: () => '?',
  quote,
  // SQLite 没有 schema 概念：忽略 schema 参数
  quoteTable: (_schema, table) => quote(table),
  supportsReturning: true, // SQLite 3.35+（node:sqlite 实测支持）
  columnType: (logical: LogicalType, options: ColumnTypeOptions) => typeRendererFor(TYPES, logical, 'sqlite')(options),

  /**
   * SQLite 的自增是 **rowid 别名**，写法必须是 `INTEGER PRIMARY KEY AUTOINCREMENT`：
   * 中间不能夹 `NOT NULL`（夹了就不再是 rowid 别名）——所以整列由这里接管。
   */
  autoIncrementPieces: (field: RenderableField) =>
    field.autoIncrement ? { override: `${quote(field.column)} integer PRIMARY KEY AUTOINCREMENT` } : null,

  defaultLiteral: (field: RenderableField) => {
    if (!field.hasDefault) return null;
    const value = field.defaultValue;
    if (value === null) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint') return numericLiteral(field.name, value);
    if (typeof value === 'boolean') return value ? '1' : '0'; // 存 0/1，映射层还原成 boolean
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return sqlString(String(text));
  },

  // SQLite 没有列/表注释这回事 → 如实返回 null / 空（由 sync 报告 unsupportedComments）
  inlineComment: () => null,
  tableSuffix: () => '',
  commentStatements: () => [],
  indexIfNotExists: true,
  isDuplicateIndexError: () => false,

  introspection: {
    tableExists: (table) => ({
      sql: 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
      params: ['table', table],
    }),
    // PRAGMA 不支持占位符 → 用 { pragma } 形状（表名走引号转义，标识符注入不可能）
    columns: (table) => ({ pragma: `PRAGMA table_info(${quote(table)})` }),
    toColumn: (row) => {
      const rawType = String(row.type ?? '');
      return {
        name: String(row.name),
        type: normalizeTypeText(rawType),
        rawType,
        notNull: Number(row.notnull) === 1 || Number(row.pk) === 1,
        hasDefault: row.dflt_value !== null && row.dflt_value !== undefined,
      };
    },
  },

  // sqlite 的类型名就是类型亲和性（integer/text/real/blob/numeric）→ 只做通用规范化
  normalizeDbType: (rawType, options) => normalizeTypeText(rawType, options.length),
  serializeBoolean: (value) => (value ? 1 : 0),
  // sqlite 的 timestamp 列是 TEXT：统一存 ISO 串（字典序 == 时间序）
  serializeTimestamp: (date) => date.toISOString(),
  comments: 'none',
};
