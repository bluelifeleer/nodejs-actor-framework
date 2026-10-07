import { typeRendererFor, type ColumnTypeOptions, type DialectSpec, type LogicalType, type TypeRenderers } from './types.ts';

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
};
