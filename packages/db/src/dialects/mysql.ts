import { typeRendererFor, type ColumnTypeOptions, type DialectSpec, type LogicalType, type TypeRenderers } from './types.ts';

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

function quote(name: string): string {
  return `\`${String(name).split('`').join('``')}\``;
}

export const mysql: DialectSpec = {
  name: 'mysql',
  driverPackage: 'mysql2',
  defaultPort: 3306,
  placeholder: () => '?',
  quote,
  quoteTable: (schema, table) => (schema === undefined ? quote(table) : `${quote(schema)}.${quote(table)}`),
  supportsReturning: false, // MySQL 没有 RETURNING：自增主键靠结果里的 insertId
  columnType: (logical: LogicalType, options: ColumnTypeOptions) => typeRendererFor(TYPES, logical, 'mysql')(options),
};
