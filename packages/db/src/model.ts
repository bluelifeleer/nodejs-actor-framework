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
  /** 逻辑类型（方言层会映射成各方言的真实列类型，见 `columnTypeFor`）。 */
  type: LogicalType;
  /** `string` / `binary` 的长度（其它类型忽略；`string` 不给就用方言默认值）。 */
  length?: number;
  /** `decimal` 的总位数（默认 10）。 */
  precision?: number;
  /** `decimal` 的小数位（默认 2）。 */
  scale?: number;
  /** 列名（默认与字段名相同）。改它只影响数据库，领域里仍用字段名。 */
  column?: string;
  /** `NOT NULL`。主键隐含 `NOT NULL`，不必重复写。 */
  notNull?: boolean;
  /** 主键（一个 model 必须且只能有一个）。uuid 主键由仓储自动生成。 */
  primaryKey?: boolean;
  /** 单列唯一约束（等价于给这一列建一个唯一索引）。 */
  unique?: boolean;
  /** DB 侧默认值：会按方言渲染成正确字面量（pg 的 jsonb 加 `::jsonb`、布尔用 `TRUE/FALSE`…）。 */
  default?: unknown;
  /**
   * 时间戳自动填充（由**仓储层**执行，不是数据库触发器）：
   * `create` 只在 insert 时写，`update` 每次 update 都写。
   */
  auto?: 'create' | 'update';
  /** 乐观锁版本列（一个 model 最多一个）：update 时自增并在冲突时报错。 */
  version?: boolean;
  /**
   * 列注释（写进数据库的 schema 注释，便于 DBA/BI 工具读懂字段含义）。
   *
   * 方言差异（**如实**，不假装统一）：
   *   - MySQL：建表时列内联 `COMMENT '…'`（已存在的表不会自动改注释）；
   *   - PostgreSQL：`sync()` 会发独立的 `COMMENT ON COLUMN …`（幂等，每次 sync 都可应用）；
   *   - SQLite：不支持列注释 —— `sync()` 会在 `unsupportedComments` 里如实报告。
   * MySQL 的注释上限是 1024 字符，超了会在生成 DDL 时就报错（而不是被数据库静默截断）。
   */
  comment?: string;
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
  comment?: string;
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

/** 关联声明：本轮只做"声明 + 查询构造"，不做级联写、不做 N+1 自动优化（见设计文档 §7）。 */
export interface RelationSpec {
  kind: 'hasMany' | 'belongsTo';
  /** 目标 model 的名字（要在同一批注册过，`db.sync([...])` 会注册）。 */
  model: string;
  /** 关联用的列：hasMany 用**目标表**上的外键字段名；belongsTo 用**本表**上的外键字段名。 */
  foreignKey: string;
}

export interface Relation {
  name: string;
  kind: 'hasMany' | 'belongsTo';
  model: string;
  foreignKey: string;
}

/** 一个 model 的声明（**用户写这一层**）：框架据此建表、做漂移检测、做行 ↔ 实体映射。 */
export interface ModelSpec {
  /** model 名（也是关联声明里引用的名字）。 */
  name: string;
  /** 表名（默认 = name）。 */
  table?: string;
  /** 表注释（MySQL 内联在建表语句；PG 走 `COMMENT ON TABLE`；SQLite 不支持、如实报告）。 */
  comment?: string;
  /** 字段声明：键是**领域字段名**，值是类型/约束/映射钩子。 */
  fields: Record<string, FieldSpec>;
  /** 索引（默认名 `${table}_${columns}`；MySQL 没有 `CREATE INDEX IF NOT EXISTS`，已存在会被容忍）。 */
  indexes?: readonly IndexSpec[];
  /** 关联声明（hasMany / belongsTo）。 */
  relations?: Record<string, RelationSpec>;
  /** 整行级的自定义映射（**用户可写**）：行 → 实体。 */
  parseRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** 整行级的自定义映射（**用户可写**）：实体 → 行。 */
  serializeRow?: (entity: Record<string, unknown>) => Record<string, unknown>;
}

export interface Model {
  readonly name: string;
  readonly table: string;
  readonly comment?: string;
  readonly fields: readonly Field[];
  readonly indexes: readonly Index[];
  readonly relations: readonly Relation[];
  readonly primaryKey: string;
  readonly versionField: string | null;
  readonly parseRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  readonly serializeRow?: (entity: Record<string, unknown>) => Record<string, unknown>;
  fieldFor(name: string): Field;
  fieldByColumn(column: string): Field | undefined;
  createTableSql(dialect: Dialect): string;
  createIndexSql(dialect: Dialect, index: Index): string;
  addColumnSql(dialect: Dialect, field: Field): string;
  /**
   * 独立的注释语句（方言支持才有内容）：
   *   - PostgreSQL：`COMMENT ON TABLE/COLUMN …`（幂等，sync 每次都会发）；
   *   - MySQL / SQLite：返回空数组（MySQL 的注释已在建表语句里；SQLite 根本没有列注释）。
   */
  commentSql(dialect: Dialect): string[];
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

/** MySQL 的列/表注释上限（超出会被数据库静默截断，所以在生成 DDL 时就报错）。 */
const MYSQL_COMMENT_MAX = 1024;

/** 注释字面量：单引号翻倍转义；MySQL 的长度上限提前检查（不留给数据库静默截断）。 */
function commentLiteral(dialect: Dialect, text: string, what: string): string {
  if (dialect === 'mysql' && text.length > MYSQL_COMMENT_MAX) {
    throw new DbConfigError(
      `${what} comment is too long for MySQL (${text.length} > ${MYSQL_COMMENT_MAX} chars) — shorten it or use PostgreSQL`,
    );
  }
  return `'${text.split("'").join("''")}'`;
}

/** 某些方言对 TEXT/JSON/BLOB 的默认值有限制：mysql 在 8.0.13 之前不允许（这里统一不写，文档写明）。 */
function supportsColumnDefault(dialect: Dialect, field: Field): boolean {
  if (!field.hasDefault) return false;
  if (dialect !== 'mysql') return true;
  return field.type !== 'text' && field.type !== 'json' && field.type !== 'blob';
}

function columnDefinition(dialect: Dialect, field: Field): string {
  const parts: string[] = [
    quote(dialect, field.column),
    // 严格模式：不能把 undefined 塞进可选字段
    columnTypeFor(dialect, field.type, field.length === undefined ? {} : { length: field.length }),
  ];
  if (field.notNull || field.primaryKey) parts.push('NOT NULL'); // 主键隐含 NOT NULL（三方言一致）
  if (field.primaryKey) parts.push('PRIMARY KEY');
  else if (field.unique) parts.push('UNIQUE');
  if (supportsColumnDefault(dialect, field)) parts.push(`DEFAULT ${literalFor(dialect, field, field.defaultValue)}`);
  // MySQL 只支持"建表时内联列注释"（已存在的表不会被自动改注释，设计文档与指南都写明了）
  if (dialect === 'mysql' && field.comment !== undefined) {
    parts.push(`COMMENT ${commentLiteral('mysql', field.comment, `column "${field.column}"`)}`);
  }
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
    if (raw.comment !== undefined) field.comment = String(raw.comment);
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

  const relations: Relation[] = Object.entries(spec.relations ?? {}).map(([name, relation]) => {
    if (relation.kind !== 'hasMany' && relation.kind !== 'belongsTo') {
      throw new DbConfigError(`relation "${name}" of model "${spec.name}" needs kind 'hasMany' or 'belongsTo'`);
    }
    return { name, kind: relation.kind, model: String(relation.model), foreignKey: String(relation.foreignKey) };
  });

  const model: Model = {
    name: spec.name,
    table,
    fields,
    indexes,
    relations,
    ...(spec.comment === undefined ? {} : { comment: String(spec.comment) }),
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
      const suffix =
        dialect === 'mysql' && spec.comment !== undefined
          ? ` COMMENT=${commentLiteral('mysql', String(spec.comment), `table "${table}"`)}`
          : '';
      return `CREATE TABLE IF NOT EXISTS ${quote(dialect, table)} (${columns})${suffix}`;
    },
    commentSql(dialect: Dialect): string[] {
      // MySQL 的注释已经内联在建表语句里；SQLite 根本不支持列/表注释 → 都返回空数组（不假装）
      if (dialect !== 'pgsql') return [];
      const statements: string[] = [];
      if (spec.comment !== undefined) {
        statements.push(`COMMENT ON TABLE ${quote(dialect, table)} IS ${commentLiteral(dialect, String(spec.comment), `table "${table}"`)}`);
      }
      for (const field of fields) {
        if (field.comment === undefined) continue;
        statements.push(
          `COMMENT ON COLUMN ${quote(dialect, table)}.${quote(dialect, field.column)} IS ${commentLiteral(dialect, field.comment, `column "${field.column}"`)}`,
        );
      }
      return statements;
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
