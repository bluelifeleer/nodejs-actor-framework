import { columnTypeFor, type Dialect, type LogicalType } from './dialect.ts';
import { DbConfigError } from './errors.ts';

/** 每字段的钩子（**用户可以写自己的代码**）：列值 ↔ 领域值。 */
export interface FieldHooks {
  /** 列值 → 领域值（如 JSON 解码、日期解析）。 */
  parse?: (raw: unknown) => unknown;
  /** 领域值 → 列值（如 JSON 编码）。 */
  serialize?: (value: unknown) => unknown;
}

export interface FieldSpec extends FieldHooks {
  type: LogicalType;
  /** `string` 的长度（其它类型忽略）。 */
  length?: number;
  /** 列名（默认与字段名相同）。 */
  column?: string;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  /** DB 侧默认值（值会被渲染成方言正确的字面量）。 */
  default?: unknown;
  /** 时间戳自动填充：create 只在插入时写，update 每次更新都写（由仓储层执行）。 */
  auto?: 'create' | 'update';
  /** 乐观锁版本列（一个 model 最多一个）。 */
  version?: boolean;
}

/** 归一化后的字段：DDL 与映射层都读它。 */
export interface Field {
  name: string;
  column: string;
  type: LogicalType;
  length?: number;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
  auto?: 'create' | 'update';
  version: boolean;
  parse?: (raw: unknown) => unknown;
  serialize?: (value: unknown) => unknown;
}

export interface IndexSpec {
  fields: readonly string[];
  unique?: boolean;
  name?: string;
}

export interface Index {
  name: string;
  columns: readonly string[];
  unique: boolean;
}

export interface ModelSpec {
  name: string;
  /** 表名（默认 = name）。 */
  table?: string;
  fields: Record<string, FieldSpec>;
  indexes?: readonly IndexSpec[];
  /** 整行级的自定义映射（**用户可写**）：行 → 实体。 */
  parseRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** 整行级的自定义映射（**用户可写**）：实体 → 行。 */
  serializeRow?: (entity: Record<string, unknown>) => Record<string, unknown>;
}

export interface Model {
  readonly name: string;
  readonly table: string;
  readonly fields: readonly Field[];
  readonly indexes: readonly Index[];
  readonly primaryKey: string;
  readonly versionField: string | null;
  readonly parseRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  readonly serializeRow?: (entity: Record<string, unknown>) => Record<string, unknown>;
  fieldFor(name: string): Field;
  fieldByColumn(column: string): Field | undefined;
  createTableSql(dialect: Dialect): string;
  createIndexSql(dialect: Dialect, index: Index): string;
  addColumnSql(dialect: Dialect, field: Field): string;
}

/** 标识符安全检查：允许引号（会被转义），但**不允许**空白/分号这类能改变语句结构的东西。 */
function assertSafeName(kind: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new DbConfigError(`${kind} is required`);
  if (/[\s;]/.test(value)) {
    throw new DbConfigError(`${kind} "${value}" contains whitespace or ";" — that cannot be a safe identifier`);
  }
}

function quote(dialect: Dialect, name: string): string {
  const ch = dialect === 'mysql' ? '`' : '"';
  return `${ch}${String(name).split(ch).join(ch + ch)}${ch}`;
}

/** string/boolean/数字/null 的字面量；JSON 与其它对象走 JSON 文本。 */
function literalFor(dialect: Dialect, field: Field, value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') {
    if (!Number.isFinite(Number(value))) throw new DbConfigError(`default for "${field.name}" must be finite`);
    return String(value);
  }
  if (typeof value === 'boolean') {
    // pg 的 boolean 列不接受 1/0；mysql/sqlite 接受 1/0
    if (dialect === 'pgsql') return value ? 'TRUE' : 'FALSE';
    return value ? '1' : '0';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const escaped = String(text).split("'").join("''");
  // pg 的 json/jsonb 默认值要带类型转换，否则报 "column is of type jsonb but expression is of type text"
  if (field.type === 'json' && dialect === 'pgsql') return `'${escaped}'::jsonb`;
  return `'${escaped}'`;
}

/** 某些方言对 TEXT/JSON/BLOB 的默认值有限制：mysql 在 8.0.13 之前不允许（这里统一不写，文档写明）。 */
function supportsColumnDefault(dialect: Dialect, field: Field): boolean {
  if (!field.hasDefault) return false;
  if (dialect !== 'mysql') return true;
  return field.type !== 'text' && field.type !== 'json' && field.type !== 'blob';
}

function columnDefinition(dialect: Dialect, field: Field): string {
  const parts = [
    quote(dialect, field.column),
    // 严格模式：不能把 undefined 塞进可选字段
    columnTypeFor(dialect, field.type, field.length === undefined ? {} : { length: field.length }),
  ];
  if (field.notNull || field.primaryKey) parts.push('NOT NULL'); // 主键隐含 NOT NULL（三方言一致）
  if (field.primaryKey) parts.push('PRIMARY KEY');
  else if (field.unique) parts.push('UNIQUE');
  if (supportsColumnDefault(dialect, field)) parts.push(`DEFAULT ${literalFor(dialect, field, field.defaultValue)}`);
  return parts.join(' ');
}

function defaultIndexName(table: string, columns: readonly string[]): string {
  return `${table}_${columns.join('_')}`;
}

/**
 * 声明一个 model（**用户写的这一层**）。
 *
 * 框架据此生成建表 DDL、做漂移检测、并在仓储层做行↔实体映射。
 * 注意：这里**不做**任何数据库访问；DDL 文本是纯函数产物（所以三个方言都能离线测试）。
 */
export function defineModel(spec: ModelSpec): Model {
  if (spec === null || typeof spec !== 'object') throw new DbConfigError('defineModel(spec) requires an object');
  assertSafeName('model name', spec.name);
  const table = spec.table ?? spec.name;
  assertSafeName('table name', table);
  const entries = Object.entries(spec.fields ?? {});
  if (entries.length === 0) throw new DbConfigError(`model "${spec.name}" needs at least one field`);

  const seenColumns = new Map<string, string>();
  const fields: Field[] = [];
  let primaryKey: string | null = null;
  let versionField: string | null = null;

  for (const [name, raw] of entries) {
    if (raw === null || typeof raw !== 'object') throw new DbConfigError(`field "${name}" needs a definition`);
    assertSafeName('field name', name);
    const column = raw.column ?? name;
    assertSafeName(`column name for "${name}"`, column);
    const clash = seenColumns.get(column);
    if (clash !== undefined) {
      throw new DbConfigError(`fields "${clash}" and "${name}" both map to column "${column}"`);
    }
    seenColumns.set(column, name);

    // 未知逻辑类型在 columnTypeFor 里统一报错（错误类型一致）
    columnTypeFor('pgsql', raw.type);
    if (raw.primaryKey === true) {
      if (primaryKey !== null) {
        throw new DbConfigError(`model "${spec.name}" has more than one primary key ("${primaryKey}" and "${name}")`);
      }
      primaryKey = name;
    }
    if (raw.version === true) {
      if (versionField !== null) {
        throw new DbConfigError(`model "${spec.name}" has more than one version field ("${versionField}" and "${name}")`);
      }
      versionField = name;
    }
    const field: Field = {
      name,
      column,
      type: raw.type,
      notNull: raw.notNull === true,
      primaryKey: raw.primaryKey === true,
      unique: raw.unique === true,
      hasDefault: Object.prototype.hasOwnProperty.call(raw, 'default'),
      defaultValue: raw.default,
      version: raw.version === true,
    };
    if (raw.length !== undefined) field.length = raw.length;
    if (raw.auto !== undefined) field.auto = raw.auto;
    if (raw.parse !== undefined) field.parse = raw.parse;
    if (raw.serialize !== undefined) field.serialize = raw.serialize;
    // version 列必然是 NOT NULL 且默认 0（乐观锁要求）
    if (field.version) {
      field.notNull = true;
      if (!field.hasDefault) {
        field.hasDefault = true;
        field.defaultValue = 0;
      }
    }
    fields.push(field);
  }

  if (primaryKey === null) {
    throw new DbConfigError(`model "${spec.name}" needs exactly one primary key field ({ primaryKey: true })`);
  }

  const indexes: Index[] = (spec.indexes ?? []).map((index) => {
    const columns = index.fields.map((fieldName) => {
      const field = fields.find((f) => f.name === fieldName);
      if (field === undefined) throw new DbConfigError(`index on unknown field "${fieldName}" (model "${spec.name}")`);
      return field.column;
    });
    return {
      name: index.name ?? defaultIndexName(table, columns),
      columns,
      unique: index.unique === true,
    };
  });

  const model: Model = {
    name: spec.name,
    table,
    fields,
    indexes,
    primaryKey,
    versionField,
    ...(spec.parseRow === undefined ? {} : { parseRow: spec.parseRow }),
    ...(spec.serializeRow === undefined ? {} : { serializeRow: spec.serializeRow }),
    fieldFor(name: string): Field {
      const field = fields.find((f) => f.name === name);
      if (field === undefined) throw new DbConfigError(`model "${spec.name}" has no field "${name}"`);
      return field;
    },
    fieldByColumn(column: string): Field | undefined {
      return fields.find((f) => f.column === column);
    },
    createTableSql(dialect: Dialect): string {
      const columns = fields.map((field) => columnDefinition(dialect, field)).join(', ');
      return `CREATE TABLE IF NOT EXISTS ${quote(dialect, table)} (${columns})`;
    },
    createIndexSql(dialect: Dialect, index: Index): string {
      const kind = index.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
      // mysql 不支持 CREATE INDEX IF NOT EXISTS → 由 schema 层容忍"已存在"错误
      const ifNotExists = dialect === 'mysql' ? '' : ' IF NOT EXISTS';
      const columns = index.columns.map((column) => quote(dialect, column)).join(', ');
      return `${kind}${ifNotExists} ${quote(dialect, index.name)} ON ${quote(dialect, table)} (${columns})`;
    },
    addColumnSql(dialect: Dialect, field: Field): string {
      return `ALTER TABLE ${quote(dialect, table)} ADD COLUMN ${columnDefinition(dialect, field)}`;
    },
  };
  return model;
}
