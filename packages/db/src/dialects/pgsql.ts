import { typeRendererFor, type ColumnTypeOptions, type DialectSpec, type LogicalType, type TypeRenderers } from './types.ts';

/**
 * PostgreSQL 的类型表：**一个逻辑类型一行**（方案 A）。
 * 加类型＝加一行；TS 的 `Record<LogicalType, …>` 会强迫这里补齐每个类型。
 */
const TYPES: TypeRenderers = {
  uuid: () => 'uuid',
  string: (o) => (o.length === undefined ? 'text' : `varchar(${o.length})`),
  char: (o) => `char(${o.length ?? 1})`,
  text: () => 'text',
  tinyText: () => 'text',
  mediumText: () => 'text',
  bigText: () => 'text',
  tinyint: () => 'smallint', // PG 没有 1 字节整数
  smallint: () => 'smallint',
  integer: () => 'integer',
  bigint: () => 'bigint',
  decimal: (o) => `numeric(${o.precision ?? 10}, ${o.scale ?? 2})`,
  float: () => 'real',
  real: () => 'double precision',
  boolean: () => 'boolean',
  date: () => 'date',
  time: () => 'time',
  timestamp: () => 'timestamptz',
  dateTime: () => 'timestamp', // 不带时区
  json: () => 'jsonb',
  blob: () => 'bytea',
  binary: () => 'bytea',
};

function quote(name: string): string {
  return `"${String(name).split('"').join('""')}"`;
}

export const pgsql: DialectSpec = {
  name: 'pgsql',
  driverPackage: 'pg',
  defaultPort: 5432,
  placeholder: (index) => `$${index}`,
  quote,
  quoteTable: (schema, table) => (schema === undefined ? quote(table) : `${quote(schema)}.${quote(table)}`),
  supportsReturning: true,
  columnType: (logical: LogicalType, options: ColumnTypeOptions) => typeRendererFor(TYPES, logical, 'pgsql')(options),
};
