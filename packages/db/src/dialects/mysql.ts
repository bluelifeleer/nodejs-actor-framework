import { DbConfigError } from '../errors.ts';
import { createMysqlDriver } from '../drivers/mysql.ts';
import {
  hostConnectionFromFields,
  hostConnectionFromUrl,
  hostDescribe,
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

/** MySQL 的列/表注释上限（超出会被数据库静默截断，所以在生成 DDL 时就报错）。 */
const COMMENT_MAX = 1024;

/**
 * MySQL 对 TEXT / JSON / BLOB 家族**不给列默认值**（8.0.13 之前直接不允许；
 * 这里统一不写，文档写明）。`binary` 是 `varbinary`，可以有默认值。
 */
const NO_DEFAULT_TYPES = new Set(['text', 'tinyText', 'mediumText', 'bigText', 'json', 'blob']);

/** 注释字面量：转义 + 长度上限提前检查（不留给数据库静默截断）。 */
function commentValue(text: string, what: string): string {
  if (text.length > COMMENT_MAX) {
    throw new DbConfigError(
      `${what} comment is too long for MySQL (${text.length} > ${COMMENT_MAX} chars) — shorten it or use PostgreSQL`,
    );
  }
  return sqlString(text);
}

/** MySQL 的类型表（方案 A）。MySQL 有最丰富的文本家族与 `tinyint(1)` 布尔。 */
const TYPES: TypeRenderers = {
  uuid: () => 'char(36)',
  string: (o) => `varchar(${o.length ?? 255})`,
  char: (o) => `char(${o.length ?? 1})`,
  text: () => 'text',
  tinyText: () => 'tinytext',
  mediumText: () => 'mediumtext',
  bigText: () => 'longtext',
  tinyint: () => 'tinyint',
  smallint: () => 'smallint',
  integer: () => 'int',
  bigint: () => 'bigint',
  decimal: (o) => `decimal(${o.precision ?? 10}, ${o.scale ?? 2})`,
  float: () => 'float',
  real: () => 'double',
  boolean: () => 'tinyint(1)',
  date: () => 'date',
  time: () => 'time',
  timestamp: () => 'datetime(3)',
  dateTime: () => 'datetime(3)', // MySQL 的 datetime 本来就不带时区
  json: () => 'json',
  blob: () => 'blob',
  binary: (o) => (o.length === undefined ? 'varbinary(255)' : `varbinary(${o.length})`),
};

const DEFAULT_PORT = 3306;

/** 建表语句的表级后缀（MySQL 的 `COMMENT='…'`；其它方言没有这种东西）。 */
function tableSuffixFor(model: { table: string; comment?: string }, options: { withComments: boolean }): string {
  return options.withComments && model.comment !== undefined
    ? ` COMMENT=${commentValue(model.comment, `table "${model.table}"`)}`
    : '';
}

function quote(name: string): string {
  return `\`${String(name).split('`').join('``')}\``;
}

export const mysql: DialectSpec = {
  name: 'mysql',
  driverPackage: 'mysql2',
  driver: () => createMysqlDriver(),
  defaultPort: DEFAULT_PORT,
  placeholder: () => '?',
  quote,
  quoteTable: (schema, table) => (schema === undefined ? quote(table) : `${quote(schema)}.${quote(table)}`),
  supportsReturning: false, // MySQL 没有 RETURNING：自增主键靠结果里的 insertId
  columnType: (logical: LogicalType, options: ColumnTypeOptions) => typeRendererFor(TYPES, logical, 'mysql')(options),

  createTable: (model, columns, options) =>
    `CREATE TABLE IF NOT EXISTS ${quote(model.table)} (${columns})${tableSuffixFor(model, options)}`,
  alterAddColumn: (table, column) => `ALTER TABLE ${table} ADD COLUMN ${column}`,

  // AUTO_INCREMENT 必须是 NOT NULL 之后、主键约束之前
  autoIncrementPieces: (field: RenderableField) => (field.autoIncrement ? { afterNotNull: 'AUTO_INCREMENT' } : null),

  defaultLiteral: (field: RenderableField) => {
    if (!field.hasDefault) return null;
    if (NO_DEFAULT_TYPES.has(field.type)) return null; // TEXT/JSON/BLOB 家族不给默认值
    const value = field.defaultValue;
    if (value === null) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint') return numericLiteral(field.name, value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return sqlString(String(text));
  },

  // MySQL 只支持"建表时内联列注释"（已存在的表不会被自动改注释）
  inlineComment: (field: RenderableField) =>
    field.comment === undefined ? null : commentValue(field.comment, `column "${field.column}"`),
  tableSuffix: tableSuffixFor,
  // 注释已经内联在建表语句里 → 没有独立语句
  commentStatements: () => [],
  indexIfNotExists: false, // MySQL 没有 CREATE INDEX IF NOT EXISTS
  isDuplicateIndexError: (error: unknown) => /ER_DUP_KEYNAME|Duplicate key name/i.test(error instanceof Error ? error.message : String(error)),

  introspection: {
    tableExists: (table) => ({
      sql: 'SELECT 1 AS found FROM information_schema.tables WHERE table_name = ? AND table_schema = DATABASE()',
      params: [table],
    }),
    columns: (table) => ({
      sql:
        'SELECT column_name, is_nullable, column_type, column_default ' +
        'FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE() ORDER BY ordinal_position',
      params: [table],
    }),
    toColumn: (row) => {
      // MySQL 的 column_type 带长度（tinyint(1)），data_type 不带 → 优先 data_type（若有）再回退
      const rawType = String(row.data_type ?? row.column_type ?? '');
      return {
        name: String(row.column_name),
        type: normalizeTypeText(rawType),
        rawType,
        notNull: String(row.is_nullable).toUpperCase() === 'NO',
        hasDefault: row.column_default !== null && row.column_default !== undefined,
      };
    },
  },

  // MySQL 的 information_schema 基本就是它自己的类型名 → 只做通用规范化
  normalizeDbType: (rawType, options) => normalizeTypeText(rawType, options.length),
  serializeBoolean: (value) => (value ? 1 : 0),
  serializeTimestamp: (date) => date,
  comments: 'inline',

  connectionKind: 'host',
  connectionFromFields: (input) => hostConnectionFromFields(input, 'mysql', DEFAULT_PORT),
  connectionFromUrl: (url) => hostConnectionFromUrl(url, 'mysql', DEFAULT_PORT),
  describe: (connection) => hostDescribe(connection, DEFAULT_PORT),
};
