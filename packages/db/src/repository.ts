import { placeholderFor, quoteIdentifier, type Dialect } from './dialect.ts';
import { DbConfigError, DbConflictError, DbNotFoundError } from './errors.ts';
import { assertKnownFields, entityToRow, rowToEntity, type Row } from './mapping.ts';
import type { Field, Model } from './model.ts';
import type { Runner } from './drivers/types.ts';

export type Entity = Record<string, unknown>;

export interface FindManyOptions {
  /** 等值条件（AND）；键必须是 model 的**字段名**（不是列名）。 */
  where?: Record<string, unknown>;
  orderBy?: ReadonlyArray<{ field: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}

export interface UpdateOptions {
  /** 乐观锁：与库里 version 不一致就抛 `DbConflictError`。 */
  expectedVersion?: number;
}

export interface Repository<M extends Model = Model> {
  readonly model: M;
  /** 插入一条；自动填 uuid 主键、`auto: 'create'` 时间戳、version=0。 */
  insert(entity: Entity): Promise<Entity>;
  findById(id: unknown): Promise<Entity | null>;
  findMany(options?: FindManyOptions): Promise<Entity[]>;
  update(id: unknown, patch: Entity, options?: UpdateOptions): Promise<Entity>;
  delete(id: unknown): Promise<boolean>;
  /** 按关联声明取关联行（`hasMany` 用目标表外键，`belongsTo` 用本表外键）。 */
  related(
    entity: Entity,
    name: string,
  ): Promise<{ model: string; kind: 'hasMany' | 'belongsTo'; many(): Promise<Entity[]>; one(): Promise<Entity | null> }>;
}

export interface RepositoryOptions {
  dialect: Dialect;
  runner: Runner;
  /** 关联解析用：能按 model 名找到别的 model（`db.sync([...])` 会注册）。 */
  models: Map<string, Model>;
  /** 生成主键（默认 `crypto.randomUUID()`）；测试可注入确定性实现。 */
  generateId?: () => string;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * 一个 model 对应的仓储：**所有 SQL 都参数化**，标识符只来自 model 声明（不来自调用方输入）。
 *
 * 与 `@actor/data` 的分工：那里做的是"仓储语义"（游标分页、outbox、投影）；这里做的是
 * "model → 表/映射 + 最常用的 CRUD"。需要游标分页时，用 `db.runner()` + `createSqlRepository`。
 */
export function createRepository<M extends Model>(model: M, options: RepositoryOptions): Repository<M> {
  const { dialect, runner, models } = options;
  const generateId = options.generateId ?? newId;
  const ph = placeholderFor(dialect);
  const table = quoteIdentifier(dialect, model.table);
  const column = (field: Field): string => quoteIdentifier(dialect, field.column);
  const primary = model.fieldFor(model.primaryKey);

  const pkValue = (entity: Entity): unknown => entity[model.primaryKey];
  const now = (): Date => new Date();

  async function selectById(id: unknown): Promise<Entity | null> {
    const rows = await runner.all(`SELECT * FROM ${table} WHERE ${column(primary)} = ${ph(1)}`, [id]);
    return rows.length === 0 ? null : rowToEntity(dialect, model, rows[0] as Row);
  }

  const repository: Repository<M> = {
    model,

    async insert(entity: Entity): Promise<Entity> {
      assertKnownFields(model, entity, 'insert');
      const draft: Entity = { ...entity };
      if (draft[model.primaryKey] === undefined || draft[model.primaryKey] === null) {
        if (primary.type === 'uuid') draft[model.primaryKey] = generateId();
        else {
          throw new DbConfigError(
            `insert: model "${model.name}" primary key "${model.primaryKey}" is required (type ${primary.type})`,
          );
        }
      }
      const stamp = now();
      for (const field of model.fields) {
        if (field.version && draft[field.name] === undefined) draft[field.name] = 0;
        if (field.auto === 'create' && draft[field.name] === undefined) draft[field.name] = stamp;
      }
      const row = entityToRow(dialect, model, draft);
      const columns = Object.keys(row);
      const placeholders = columns.map((_, index) => ph(index + 1)).join(', ');
      const values = columns.map((name) => (row as Row)[name]);
      await runner.run(
        `INSERT INTO ${table} (${columns.map((name) => quoteIdentifier(dialect, name)).join(', ')}) VALUES (${placeholders})`,
        values,
      );
      return rowToEntity(dialect, model, row);
    },

    findById(id: unknown): Promise<Entity | null> {
      return selectById(id);
    },

    async findMany(findOptions: FindManyOptions = {}): Promise<Entity[]> {
      const clauses: string[] = [];
      const values: unknown[] = [];
      for (const [name, value] of Object.entries(findOptions.where ?? {})) {
        const field = model.fields.find((f) => f.name === name);
        if (field === undefined) throw new DbConfigError(`findMany where: model "${model.name}" has no field "${name}"`);
        values.push(value);
        clauses.push(`${column(field)} = ${ph(values.length)}`);
      }
      let sql = `SELECT * FROM ${table}`;
      if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
      if (findOptions.orderBy !== undefined && findOptions.orderBy.length > 0) {
        const order = findOptions.orderBy.map((entry) => {
          const field = model.fields.find((f) => f.name === entry.field);
          if (field === undefined) throw new DbConfigError(`findMany orderBy: no field "${entry.field}"`);
          return `${column(field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`;
        });
        sql += ` ORDER BY ${order.join(', ')}`;
      }
      if (findOptions.limit !== undefined) {
        values.push(findOptions.limit);
        sql += ` LIMIT ${ph(values.length)}`;
      }
      if (findOptions.offset !== undefined) {
        values.push(findOptions.offset);
        sql += ` OFFSET ${ph(values.length)}`;
      }
      const rows = await runner.all(sql, values);
      return rows.map((row) => rowToEntity(dialect, model, row as Row));
    },

    async update(id: unknown, patch: Entity, updateOptions: UpdateOptions = {}): Promise<Entity> {
      assertKnownFields(model, patch, 'update');
      const draft: Entity = { ...patch };
      for (const field of model.fields) {
        if (field.auto === 'update' && draft[field.name] === undefined) draft[field.name] = now();
      }
      const row = entityToRow(dialect, model, draft, { onlyProvided: true });
      // version 列由框架自增，不接受调用方直接改
      delete row[primary.column];
      const versionField = model.versionField === null ? null : model.fieldFor(model.versionField);
      if (versionField !== null) delete row[versionField.column];

      const assignments = Object.keys(row).map((name, index) => `${quoteIdentifier(dialect, name)} = ${ph(index + 1)}`);
      const values: unknown[] = Object.keys(row).map((name) => (row as Row)[name]);
      if (versionField !== null) assignments.push(`${column(versionField)} = ${column(versionField)} + 1`);
      if (assignments.length === 0) throw new DbConfigError(`update: nothing to update for "${String(id)}"`);

      values.push(id);
      let where = `${column(primary)} = ${ph(values.length)}`;
      if (versionField !== null && updateOptions.expectedVersion !== undefined) {
        values.push(updateOptions.expectedVersion);
        where += ` AND ${column(versionField)} = ${ph(values.length)}`;
      }

      const affected = await runner.run(`UPDATE ${table} SET ${assignments.join(', ')} WHERE ${where}`, values);
      if (affected === 0) {
        // 0 行有两种可能：行不存在 vs 版本过期。多查一次把二者区分开（只在失败路径上多花一次查询）
        const current = await selectById(id);
        if (current === null) throw new DbNotFoundError(String(id));
        throw new DbConflictError(String(id), updateOptions.expectedVersion ?? null);
      }
      const updated = await selectById(id);
      if (updated === null) throw new DbNotFoundError(String(id));
      return updated;
    },

    async delete(id: unknown): Promise<boolean> {
      const affected = await runner.run(`DELETE FROM ${table} WHERE ${column(primary)} = ${ph(1)}`, [id]);
      return affected > 0;
    },

    async related(entity: Entity, name: string) {
      const relation = model.relations.find((r) => r.name === name);
      if (relation === undefined) {
        throw new DbConfigError(
          `model "${model.name}" has no relation "${name}" (declared: ${model.relations.map((r) => r.name).join(', ') || 'none'})`,
        );
      }
      const target = models.get(relation.model);
      if (target === undefined) {
        throw new DbConfigError(
          `relation "${name}" points at model "${relation.model}", which is not registered. ` +
            'Pass it to db.sync([...]) or db.repository(model, { models }).',
        );
      }
      const targetRepo = createRepository(target, options);
      if (relation.kind === 'hasMany') {
        const value = pkValue(entity);
        return {
          model: target.name,
          kind: 'hasMany' as const,
          many: () => targetRepo.findMany({ where: { [relation.foreignKey]: value } }),
          one: async () => (await targetRepo.findMany({ where: { [relation.foreignKey]: value }, limit: 1 }))[0] ?? null,
        };
      }
      const foreign = entity[relation.foreignKey];
      return {
        model: target.name,
        kind: 'belongsTo' as const,
        one: () => (foreign === undefined || foreign === null ? Promise.resolve(null) : targetRepo.findById(foreign)),
        many: async () => {
          const found = foreign === undefined || foreign === null ? null : await targetRepo.findById(foreign);
          return found === null ? [] : [found];
        },
      };
    },
  };
  return repository;
}
