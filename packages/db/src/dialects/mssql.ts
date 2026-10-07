import { createMssqlDriver } from '../drivers/mssql.ts';
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
  type RenderableModel,
  type TypeRenderers,
} from './types.ts';

const DEFAULT_PORT = 1433;

/**
 * **SQL Server（T-SQL）** 的类型表。
 *
 * 两个必须记住的坑：
 *   1. T-SQL 的 `timestamp` **不是时间戳**，是 `rowversion`（8 字节版本号）→ 带时区的时间戳用
 *      `datetimeoffset(3)`，不带时区的用 `datetime2(3)`，**绝不能**落到 `timestamp`。
 *   2. T-SQL 没有 `varchar(255)` 这种"默认长度"的写法，也没必要 —— 不给长度就用 `nvarchar(max)`。
 */
const TYPES: TypeRenderers = {
  uuid: () => 'uniqueidentifier',
  string: (o) => (o.length === undefined ? 'nvarchar(max)' : `nvarchar(${o.length})`),
  char: (o) => `nchar(${o.length ?? 1})`,
  text: () => 'nvarchar(max)',
  tinyText: () => 'nvarchar(max)',
  mediumText: () => 'nvarchar(max)',
  bigText: () => 'nvarchar(max)',
  tinyint: () => 'tinyint',
  smallint: () => 'smallint',
  integer: () => 'int',
  bigint: () => 'bigint',
  decimal: (o) => `decimal(${o.precision ?? 10}, ${o.scale ?? 2})`,
  float: () => 'real', // T-SQL 的 real 才是 4 字节
  real: () => 'float', // T-SQL 的 float 是 8 字节
  boolean: () => 'bit',
  date: () => 'date',
  time: () => 'time',
  timestamp: () => 'datetimeoffset(3)', // 带时区（**不是** T-SQL 的 timestamp/rowversion）
  dateTime: () => 'datetime2(3)', // 不带时区
  json: () => 'nvarchar(max)', // T-SQL 没有 json 类型，只有 JSON 函数
  blob: () => 'varbinary(max)',
  binary: (o) => (o.length === undefined ? 'varbinary(max)' : `varbinary(${o.length})`),
};

/** 放进动态 SQL 字符串里的内容：单引号翻倍（`EXEC(N'…')` 里的那一层）。 */
function escapeForDynamicSql(text: string): string {
  return String(text).split("'").join("''");
}

/** `N'…'`（T-SQL 的 Unicode 字面量；单引号翻倍）。 */
function nString(text: string): string {
  return `N${sqlString(text)}`;
}

function quote(name: string): string {
  return `[${String(name).split(']').join(']]')}]`;
}

/**
 * 注释走**扩展属性**（`sp_addextendedproperty`）—— T-SQL 既没有内联列注释，也没有 `COMMENT ON`。
 *
 * 必须写成幂等的：扩展属性重复添加会报错，而 `comments: 'always'` 模式下每次 sync 都会跑。
 * 统一挂在默认 schema `dbo` 下（model 层没有 schema 概念）。
 */
function extendedProperty(table: string, column: string | undefined, value: string): string {
  const majorId = `OBJECT_ID(N'${quote(table).split("'").join("''")}')`;
  const guard =
    column === undefined
      ? `SELECT 1 FROM sys.extended_properties WHERE major_id = ${majorId} AND minor_id = 0 AND name = N'MS_Description'`
      : `SELECT 1 FROM sys.extended_properties WHERE major_id = ${majorId} AND minor_id = COLUMNPROPERTY(${majorId}, N'${column.split("'").join("''")}', 'ColumnId') AND name = N'MS_Description'`;
  const columnLevel = column === undefined ? '' : `, @level2type = N'COLUMN', @level2name = ${nString(column)}`;
  return (
    `IF NOT EXISTS (${guard})\n` +
    `  EXEC sp_addextendedproperty @name = N'MS_Description', @value = ${nString(value)}, ` +
    `@level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = ${nString(table)}${columnLevel}`
  );
}

/**
 * SQL Server 的方言描述符。
 *
 * ⚠️ **契约级验证**：本仓库离线、装不了 `mssql` 也没有服务器，所以这里验证的是 DDL/占位符/内省 SQL/
 * 池参数映射/事务归还这些**契约**；真连库行为未经本仓库验证（指南里同样写明了）。
 */
export const mssql: DialectSpec = {
  name: 'mssql',
  urlSchemes: ['mssql', 'sqlserver'],
  driverPackage: 'mssql',
  driver: () => createMssqlDriver(),
  defaultPort: DEFAULT_PORT,
  connectionKind: 'host',

  placeholder: (index) => `@p${index}`, // node-mssql 用命名参数
  quote,
  quoteTable: (schema, table) => (schema === undefined ? quote(table) : `${quote(schema)}.${quote(table)}`),
  supportsReturning: false, // T-SQL 没有 RETURNING：自增回读靠 SCOPE_IDENTITY()

  columnType: (logical: LogicalType, options: ColumnTypeOptions) => typeRendererFor(TYPES, logical, 'mssql')(options),

  // T-SQL：IDENTITY(1,1) 紧跟类型，在 NOT NULL 之前
  autoIncrementPieces: (field: RenderableField) => (field.autoIncrement ? { beforeNotNull: 'IDENTITY(1,1)' } : null),

  defaultLiteral: (field: RenderableField) => {
    if (!field.hasDefault) return null;
    const value = field.defaultValue;
    if (value === null) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint') return numericLiteral(field.name, value);
    if (typeof value === 'boolean') return value ? '1' : '0'; // bit 列返回 1/0
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return nString(String(text));
  },

  // T-SQL 没有内联列注释（走扩展属性，见 commentStatements）
  inlineComment: () => null,
  tableSuffix: () => '',
  commentStatements: (model: RenderableModel) => {
    const statements: string[] = [];
    if (model.comment !== undefined) statements.push(extendedProperty(model.table, undefined, model.comment));
    for (const field of model.fields) {
      if (field.comment === undefined) continue;
      statements.push(extendedProperty(model.table, field.column, field.comment));
    }
    return statements;
  },

  indexIfNotExists: false, // T-SQL 没有 CREATE INDEX IF NOT EXISTS
  isDuplicateIndexError: (error: unknown) =>
    /1913|already an object named|already exists/i.test(error instanceof Error ? error.message : String(error)),

  createTable: (model, columns) => {
    // T-SQL 的 CREATE TABLE 必须是批次首句 → 判存在 + 动态 SQL（EXEC 字符串里的单引号要再翻倍）
    const ddl = `CREATE TABLE ${quote(model.table)} (${columns})`;
    return `IF OBJECT_ID(N'${escapeForDynamicSql(quote(model.table))}', N'U') IS NULL\n  EXEC(N'${escapeForDynamicSql(ddl)}')`;
  },
  // T-SQL 的加列**不写** COLUMN 关键字
  alterAddColumn: (table, column) => `ALTER TABLE ${table} ADD ${column}`,

  introspection: {
    tableExists: (table) => ({
      sql: 'SELECT 1 AS found FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = @p1',
      params: [table],
    }),
    columns: (table) => ({
      sql:
        'SELECT COLUMN_NAME, IS_NULLABLE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, DATETIME_PRECISION, COLUMN_DEFAULT ' +
        'FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @p1 ORDER BY ORDINAL_POSITION',
      params: [table],
    }),
    toColumn: (row) => {
      const rawType = String(row.DATA_TYPE ?? row.data_type ?? '');
      const length =
        row.CHARACTER_MAXIMUM_LENGTH === undefined || row.CHARACTER_MAXIMUM_LENGTH === null
          ? null
          : Number(row.CHARACTER_MAXIMUM_LENGTH);
      let type = normalizeTypeText(rawType, length);
      // 时间类型的精度来自 DATETIME_PRECISION：不补上的话内省结果与 DDL 对不上（假漂移）
      const precision = row.DATETIME_PRECISION;
      if (precision !== undefined && precision !== null && /^(datetimeoffset|datetime2|time)$/.test(type)) {
        type = `${type}(${Number(precision)})`;
      }
      return {
        name: String(row.COLUMN_NAME ?? row.column_name),
        type,
        rawType,
        notNull: String(row.IS_NULLABLE ?? row.is_nullable).toUpperCase() === 'NO',
        hasDefault:
          (row.COLUMN_DEFAULT ?? row.column_default) !== null && (row.COLUMN_DEFAULT ?? row.column_default) !== undefined,
      };
    },
  },

  // T-SQL 自己就是这些类型名（nvarchar / uniqueidentifier / bit）→ 只做通用规范化
  normalizeDbType: (rawType, options) => normalizeTypeText(rawType, options.length),
  serializeBoolean: (value) => (value ? 1 : 0),
  serializeTimestamp: (date) => date,
  comments: 'statements',

  connectionFromFields: (input) => hostConnectionFromFields(input, 'mssql', DEFAULT_PORT),
  connectionFromUrl: (url) => hostConnectionFromUrl(url, 'mssql', DEFAULT_PORT),
  describe: (connection) => hostDescribe(connection, DEFAULT_PORT),
};
