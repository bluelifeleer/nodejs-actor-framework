import type { AutoIncrementPieces, DialectSpec, RenderableField, RenderableModel } from './types.ts';

/**
 * **共享装配器**：把"三方言一致的骨架"与"方言提供的片段"拼起来。
 *
 * 为什么独立成模块：这样"加一个方言"只需要实现 `DialectSpec`，**不必碰 model/schema**；
 * 测试也可以直接拿一个**假方言**喂进这些装配器，证明接口是自足的（见 dialect-spec.test.ts）。
 *
 * 列定义顺序（约束由这里保证，方言只提供片段，避免三个方言各写一遍导致漂移）：
 *   `列名 类型 [NOT NULL 之前的片段] NOT NULL [NOT NULL 之后的片段] 约束 [DEFAULT …] [内联注释]`
 */
export function assembleColumn(spec: DialectSpec, field: RenderableField, options: { withComments: boolean }): string {
  const pieces: AutoIncrementPieces | null = spec.autoIncrementPieces(field);
  // SQLite 的自增是 rowid 别名，整个列定义被方言接管（不能夹 NOT NULL）
  if (pieces !== null && pieces.override !== undefined) return pieces.override;

  const parts: string[] = [spec.quote(field.column), spec.columnType(field.type, typeOptionsFor(field))];
  if (pieces !== null && pieces.beforeNotNull !== undefined) parts.push(pieces.beforeNotNull);
  if (field.notNull || field.primaryKey) parts.push('NOT NULL'); // 主键隐含 NOT NULL（三方言一致）
  if (pieces !== null && pieces.afterNotNull !== undefined) parts.push(pieces.afterNotNull);
  if (field.primaryKey) parts.push('PRIMARY KEY');
  else if (field.unique) parts.push('UNIQUE');

  const literal = spec.defaultLiteral(field);
  if (literal !== null) parts.push(`DEFAULT ${literal}`);
  if (options.withComments) {
    const comment = spec.inlineComment(field);
    if (comment !== null) parts.push(`COMMENT ${comment}`);
  }
  return parts.join(' ');
}

/** 列类型参数（只带真正给了的键：严格模式下不能塞 undefined）。 */
export function typeOptionsFor(field: RenderableField): { length?: number; precision?: number; scale?: number } {
  return {
    ...(field.length === undefined ? {} : { length: field.length }),
    ...(field.precision === undefined ? {} : { precision: field.precision }),
    ...(field.scale === undefined ? {} : { scale: field.scale }),
  };
}

/**
 * 建表语句：列定义由共享装配器拼，**语句本身由方言给**。
 *
 * 为什么语句也要方言给：`CREATE TABLE IF NOT EXISTS` 不是所有方言都有 ——
 * SQL Server 要写成 `IF OBJECT_ID(N'…') IS NULL EXEC(N'CREATE TABLE …')`（T-SQL 的
 * CREATE TABLE 必须是批次首句，只能走动态 SQL），MySQL 还有表级 `COMMENT='…'` 后缀。
 */
export function assembleCreateTable(spec: DialectSpec, model: RenderableModel, options: { withComments: boolean }): string {
  const columns = model.fields.map((field) => assembleColumn(spec, field, options)).join(', ');
  return spec.createTable(model, columns, options);
}

/** 索引语句（`IF NOT EXISTS` 由方言能力位决定）。 */
export function assembleIndex(
  spec: DialectSpec,
  table: string,
  index: { name: string; columns: readonly string[]; unique: boolean },
): string {
  const kind = index.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
  const ifNotExists = spec.indexIfNotExists ? ' IF NOT EXISTS' : '';
  const columns = index.columns.map((column) => spec.quote(column)).join(', ');
  return `${kind}${ifNotExists} ${spec.quote(index.name)} ON ${spec.quote(table)} (${columns})`;
}
