import { DbConfigError } from './errors.ts';
import type { Dialect } from './dialect.ts';
import type { Field, Model } from './model.ts';

/** 行（列名 → 列值）。 */
export type Row = Record<string, unknown>;

/**
 * 默认的"列值 → 领域值"（用户可以在字段上写 `parse` 覆盖它，或在 model 上写 `parseRow` 做整行处理）。
 *
 * 为什么需要它：同一个逻辑类型在三个方言里的**物理表示**不同 ——
 *   - `json`：pg 的 jsonb 可能回对象、mysql 的 JSON 可能回对象/字符串、sqlite 一定是 TEXT；
 *   - `boolean`：pg 回 true/false，mysql/sqlite 回 0/1；
 *   - `timestamp`：pg/mysql 回 Date，sqlite 回 ISO 文本。
 * 不统一的话，业务代码就得按方言写分支 —— 那正是这一层要消灭的东西。
 */
export function defaultParseValue(dialect: Dialect, field: Field, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value; // 不是合法 JSON：原样给出（不吞掉数据），由使用者的 parse 决定
        }
      }
      return value;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return Number(value) === 1;
    case 'timestamp': {
      if (value instanceof Date) return value;
      const parsed = new Date(typeof value === 'number' ? value : String(value));
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    }
    case 'integer':
    case 'bigint':
    case 'real':
      return typeof value === 'number' ? value : Number(value);
    default:
      return value;
  }
}

/** 默认的"领域值 → 列值"（同样可被字段级 `serialize` 覆盖）。 */
export function defaultSerializeValue(dialect: Dialect, field: Field, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'json':
      // 三个方言都接受字符串：pg 会把它转成 jsonb，mysql/sqlite 直接存文本
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'boolean':
      if (dialect === 'pgsql') return Boolean(value); // pg 的 boolean 列不接受 1/0
      return value ? 1 : 0;
    case 'timestamp': {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new DbConfigError(`cannot serialize "${String(value)}" as a timestamp`);
      // sqlite 的 timestamp 列是 TEXT：统一存 ISO 串（字典序 == 时间序）
      return dialect === 'sqlite' ? date.toISOString() : date;
    }
    default:
      return value;
  }
}

/** 行 → 实体：按 model 的字段顺序处理（字段级 parse → 整行 parseRow）。 */
export function rowToEntity(dialect: Dialect, model: Model, row: Row): Record<string, unknown> {
  const entity: Record<string, unknown> = {};
  for (const field of model.fields) {
    const raw = row[field.column];
    entity[field.name] = field.parse === undefined ? defaultParseValue(dialect, field, raw) : field.parse(raw);
  }
  return model.parseRow === undefined ? entity : model.parseRow(entity);
}

/** 实体 → 行：只取 model 声明过的字段；`undefined` 不写（表示"不改这一列"）。 */
export function entityToRow(
  dialect: Dialect,
  model: Model,
  entity: Record<string, unknown>,
  options: { onlyProvided?: boolean } = {},
): Row {
  const source = model.serializeRow === undefined ? entity : model.serializeRow(entity);
  const row: Row = {};
  for (const field of model.fields) {
    if (options.onlyProvided === true && !Object.prototype.hasOwnProperty.call(source, field.name)) continue;
    const value = source[field.name];
    if (value === undefined) continue;
    row[field.column] = field.serialize === undefined ? defaultSerializeValue(dialect, field, value) : field.serialize(value);
  }
  return row;
}

/**
 * 校验实体里有没有 model 没声明的字段。
 *
 * 规则（这里踩过一次，值得写清楚）：**只有没提供 `serializeRow` 时才严格校验**。
 *   - 没有 `serializeRow`：调用方只能按 model 的字段名写，多一个键就是拼错了 → 报错（不静默丢弃）；
 *   - 有 `serializeRow`：领域实体**允许**带虚拟字段（例如 `grade`），由用户写的映射层决定怎么落到真实列。
 */
export function assertKnownFields(model: Model, entity: Record<string, unknown>, context: string): void {
  if (model.serializeRow !== undefined) return; // 用户拥有映射层，允许虚拟字段
  const known = new Set(model.fields.map((field) => field.name));
  for (const key of Object.keys(entity)) {
    if (!known.has(key)) {
      throw new DbConfigError(`${context}: model "${model.name}" has no field "${key}" (known: ${[...known].join(', ')})`);
    }
  }
}
