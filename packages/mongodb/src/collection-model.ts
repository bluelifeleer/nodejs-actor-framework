import { DbConfigError } from '@actor/resource';

/**
 * `defineCollection`：把"集合/字段/索引/validator"声明出来，框架据此
 *   - 生成 `$jsonSchema`（交给 MongoDB 自己强制）；
 *   - `sync()`：缺集合就建（带 validator）、缺索引就建、validator 不一致报**漂移**；
 *   - 自动应用变更（`collMod`）**仅在显式开启时**执行（与 SQL 侧 `migrations.auto` 同一纪律）。
 *
 * ⚠️ **诚实边界**：MongoDB 是 schemaless —— **没有 `$jsonSchema` validator 的集合无法谈字段漂移**。
 * 遇到这种集合（别人建的），我们不擅自加 validator，只在报告里如实说明"这个集合检不了字段漂移"
 * （`fieldDriftUnavailable`），能检的只有索引。
 */

/** 字段类型（映射到 `$jsonSchema` 的 `bsonType`）。 */
export type MongoFieldType =
  | 'objectId'
  | 'string'
  | 'integer'
  | 'double'
  | 'boolean'
  | 'date'
  | 'object'
  | 'array'
  | 'binary'
  | 'null';

export interface MongoFieldSpec {
  type: MongoFieldType;
  /** 必填（进 `$jsonSchema.required`，且**不允许 null**）。 */
  required?: boolean;
  /** `type: 'array'` 的元素类型。 */
  items?: MongoFieldType;
  /**
   * 时间戳自动填充：`create` 插入时写、`update` 每次更新写。
   * 注意这是**应用层**约定（MongoDB 没有列默认值这东西），框架不假装数据库会替你填。
   */
  auto?: 'create' | 'update';
  /** 乐观锁版本字段（一个集合最多一个）。 */
  version?: boolean;
  /** 备注 → 写进 `$jsonSchema` 的 `description`（给人看）。 */
  description?: string;
}

export interface MongoIndexSpec {
  fields: readonly string[];
  unique?: boolean;
  sparse?: boolean;
  name?: string;
}

export interface CollectionSpec {
  name: string;
  /** 不声明字段 → 不生成 validator（也不假装能做字段漂移）。 */
  fields?: Record<string, MongoFieldSpec>;
  indexes?: readonly MongoIndexSpec[];
  /** `strict: true` → `additionalProperties: false`（不许出现未声明字段）。 */
  validator?: { strict?: boolean };
  description?: string;
}

export interface NormalizedMongoIndex {
  readonly name: string;
  readonly keys: Record<string, number>;
  readonly unique: boolean;
  readonly sparse: boolean;
}

export interface CollectionModel {
  readonly name: string;
  readonly primaryKey: '_id';
  readonly fields: Readonly<Record<string, MongoFieldSpec>>;
  readonly indexes: readonly NormalizedMongoIndex[];
  /** `null` = 没有字段声明 → 不设 validator。 */
  readonly jsonSchema: Record<string, unknown> | null;
  readonly versionField: string | null;
  readonly autoCreateFields: readonly string[];
  readonly autoUpdateFields: readonly string[];
}

/** 字段类型 → `bsonType`（`nullable` 时允许 null：MongoDB 里 null 是常态）。 */
function bsonTypeFor(type: MongoFieldType, items: MongoFieldType | undefined, nullable: boolean): string | string[] {
  const base: string | string[] =
    type === 'objectId'
      ? 'objectId'
      : type === 'string'
        ? 'string'
        : type === 'integer'
          ? ['int', 'long'] // MongoDB 的整数是 int（32 位）或 long（64 位）
          : type === 'double'
            ? ['double', 'int', 'long', 'decimal'] // 数值都接受：声明 double 却存了 int 不该算漂移
            : type === 'boolean'
              ? 'bool'
              : type === 'date'
                ? 'date'
                : type === 'object'
                  ? 'object'
                  : type === 'array'
                    ? 'array'
                    : type === 'binary'
                      ? 'binData'
                      : 'null';
  const list = Array.isArray(base) ? [...base] : [base];
  if (nullable) list.push('null');
  const result: string | string[] = list.length === 1 ? (list[0] as string) : list;
  if (type === 'array' && items !== undefined) return result;
  return result;
}

/** 生成 `$jsonSchema`（`fields` 为空 → 返回 null）。 */
function buildJsonSchema(spec: CollectionSpec): Record<string, unknown> | null {
  const fields = spec.fields ?? {};
  const names = Object.keys(fields);
  if (names.length === 0) return null;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const isPrimaryKey = name === '_id';
    // `_id` 不可空（主键），但**不放进 required**：MongoDB 隐式保证它存在（驱动会自动补），
    // 写进 required 只是噪音；而 `required: true` 的字段必须存在且不允许 null。
    const isRequired = field.required === true || isPrimaryKey;
    const schema: Record<string, unknown> = {
      bsonType: bsonTypeFor(field.type, field.items, !isRequired),
    };
    if (field.type === 'array' && field.items !== undefined) {
      schema.items = { bsonType: bsonTypeFor(field.items, undefined, false) };
    }
    if (field.description !== undefined) schema.description = field.description;
    properties[name] = schema;
    if (field.required === true && !isPrimaryKey) required.push(name);
  }

  return {
    bsonType: 'object',
    ...(spec.validator?.strict === true ? { additionalProperties: false } : {}),
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(required.length === 0 ? {} : { required }),
    properties,
  };
}

/** 声明一个集合（纯函数：不连库、不发命令，所以能离线测）。 */
export function defineCollection(spec: CollectionSpec): CollectionModel {
  if (spec === null || typeof spec !== 'object') throw new DbConfigError('defineCollection(spec) requires an object');
  if (typeof spec.name !== 'string' || spec.name.trim() === '') throw new DbConfigError('collection name is required');
  if (/[\s;$]/.test(spec.name)) {
    throw new DbConfigError(`collection name "${spec.name}" contains whitespace or ";" — that cannot be a safe name`);
  }
  const fields = spec.fields ?? {};
  const versionFields = Object.entries(fields).filter(([, field]) => field.version === true);
  if (versionFields.length > 1) {
    throw new DbConfigError(`collection "${spec.name}" has more than one version field: ${versionFields.map(([name]) => name).join(', ')}`);
  }

  const indexes: NormalizedMongoIndex[] = (spec.indexes ?? []).map((index) => {
    if (index.fields.length === 0) throw new DbConfigError(`collection "${spec.name}": index must declare at least one field`);
    for (const field of index.fields) {
      if (!(field in fields)) {
        throw new DbConfigError(`collection "${spec.name}": index on undeclared field "${field}"`);
      }
    }
    const keys: Record<string, number> = {};
    for (const field of index.fields) keys[field] = 1;
    return {
      name: index.name ?? `${spec.name}_${index.fields.join('_')}`,
      keys,
      unique: index.unique === true,
      sparse: index.sparse === true,
    };
  });

  return {
    name: spec.name,
    primaryKey: '_id',
    fields,
    indexes,
    jsonSchema: buildJsonSchema(spec),
    versionField: versionFields.length === 1 ? (versionFields[0]?.[0] ?? null) : null,
    autoCreateFields: Object.entries(fields).filter(([, field]) => field.auto === 'create').map(([name]) => name),
    autoUpdateFields: Object.entries(fields).filter(([, field]) => field.auto === 'update').map(([name]) => name),
  };
}

// --- 内省与同步 -------------------------------------------------------------

/** 集合实况。 */
export interface CollectionInfo {
  readonly name: string;
  readonly exists: boolean;
  readonly validator: Record<string, unknown> | null;
  readonly indexes: readonly {
    readonly name: string;
    readonly keys: Record<string, number>;
    readonly unique?: boolean;
    readonly sparse?: boolean;
  }[];
}

/** `sync` 需要的数据库能力（只用到这几个方法 → 假实现很好写，真实现就是官方驱动）。 */
export interface MongoDatabaseLike {
  listCollections(filter: { name: string }): { toArray(): Promise<Array<{ name: string; options?: Record<string, unknown> }>> };
  createCollection(name: string, options?: Record<string, unknown>): Promise<unknown>;
  command(command: Record<string, unknown>): Promise<unknown>;
  collection(name: string): {
    listIndexes(): { toArray(): Promise<Array<{ name: string; key: Record<string, number> }>> };
    createIndex(keys: Record<string, number>, options?: Record<string, unknown>): Promise<string>;
  };
}

export interface CollectionDriftItem {
  readonly collection: string;
  readonly kind: 'missing' | 'validator' | 'index';
  readonly detail: string;
}

export interface CollectionDriftReport {
  readonly ok: boolean;
  readonly drift: readonly CollectionDriftItem[];
}

export interface MongoSyncReport {
  readonly created: string[];
  readonly validatorApplied: string[];
  readonly indexes: string[];
  readonly drift: CollectionDriftItem[];
  /** **字段漂移检不了**的集合（没有 validator，只能检索引）—— 如实报告，不假装。 */
  readonly fieldDriftUnavailable: string[];
}

export interface MongoSyncOptions {
  /** 允许应用变更（`collMod` 改 validator）；默认 false：只检测并报漂移。 */
  auto?: boolean;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatorOf(validator: Record<string, unknown> | null): Record<string, unknown> | null {
  const inner = validator?.$jsonSchema;
  return typeof inner === 'object' && inner !== null ? { $jsonSchema: inner } : validator;
}

/** 读一个集合的实况（不存在时 `exists: false`）。 */
export async function inspectCollection(db: MongoDatabaseLike, name: string): Promise<CollectionInfo> {
  const found = await db.listCollections({ name }).toArray();
  if (found.length === 0) return { name, exists: false, validator: null, indexes: [] };
  const raw = (found[0]?.options?.validator as Record<string, unknown> | undefined) ?? null;
  const indexes = (await db.collection(name).listIndexes().toArray()).map((index) => ({
    name: index.name,
    keys: index.key,
    unique: (index as { unique?: unknown }).unique === true,
    sparse: (index as { sparse?: unknown }).sparse === true,
  }));
  return { name, exists: true, validator: raw === null ? null : validatorOf(raw), indexes };
}

/** 比对声明与实况（缺集合 / 缺索引 / validator 不一致）。 */
export function checkCollectionDrift(model: CollectionModel, info: CollectionInfo): CollectionDriftReport {
  const drift: CollectionDriftItem[] = [];
  if (!info.exists) {
    return { ok: false, drift: [{ collection: model.name, kind: 'missing', detail: '集合不存在' }] };
  }
  if (model.jsonSchema !== null) {
    if (info.validator === null) {
      // 没有 validator ≠ 一致：字段约束根本没在守，必须报出来（而不是 ok:true）
      drift.push({ collection: model.name, kind: 'validator', detail: '集合没有 validator，字段约束未被校验' });
    } else if (!sameJson(info.validator, { $jsonSchema: model.jsonSchema })) {
      drift.push({ collection: model.name, kind: 'validator', detail: 'validator 与声明不一致' });
    }
  }
  const existing = new Map(info.indexes.map((index) => [index.name, index]));
  for (const index of model.indexes) {
    const actual = existing.get(index.name);
    if (actual === undefined) {
      drift.push({ collection: model.name, kind: 'index', detail: `缺少索引 ${index.name}` });
      continue;
    }
    if (!sameJson(actual.keys, index.keys)) {
      drift.push({ collection: model.name, kind: 'index', detail: `索引 ${index.name} 的字段不一致` });
    } else if ((actual.unique === true) !== index.unique || (actual.sparse === true) !== index.sparse) {
      drift.push({
        collection: model.name,
        kind: 'index',
        detail: `索引 ${index.name} 的 unique/sparse 与声明不一致（需要 drop 后重建）`,
      });
    }
  }
  return { ok: drift.length === 0, drift };
}

/**
 * 同步若干集合：建缺失的集合（带 validator）、建缺失的索引；
 * validator 不一致 → 默认**报漂移**，`auto: true` 才 `collMod`。
 */
export async function syncCollections(
  db: MongoDatabaseLike,
  models: readonly CollectionModel[],
  options: MongoSyncOptions = {},
): Promise<MongoSyncReport> {
  const report: MongoSyncReport = { created: [], validatorApplied: [], indexes: [], drift: [], fieldDriftUnavailable: [] };
  const auto = options.auto === true;

  for (const model of models) {
    const info = await inspectCollection(db, model.name);

    if (!info.exists) {
      await db.createCollection(model.name, model.jsonSchema === null ? {} : { validator: { $jsonSchema: model.jsonSchema } });
      report.created.push(model.name);
      if (model.jsonSchema !== null) report.validatorApplied.push(model.name);
      options.logger?.('mongo_collection_created', { collection: model.name });
    } else if (model.jsonSchema !== null) {
      if (info.validator === null) {
        // 别人的集合（没有 validator）：**不擅自加** —— 但要如实说明"字段漂移检不了"
        report.fieldDriftUnavailable.push(model.name);
      } else if (!sameJson(info.validator, { $jsonSchema: model.jsonSchema })) {
        if (auto) {
          await db.command({ collMod: model.name, validator: { $jsonSchema: model.jsonSchema } });
          report.validatorApplied.push(model.name);
          options.logger?.('mongo_validator_applied', { collection: model.name });
        } else {
          report.drift.push({ collection: model.name, kind: 'validator', detail: 'validator 与声明不一致（要改就显式开 auto）' });
        }
      }
    }

    // 索引：缺失就建（这是"补齐"而不是"改结构"，与 SQL 侧一致：建索引不需要 auto）
    const existing = new Map(info.exists ? info.indexes.map((index) => [index.name, index]) : []);
    for (const index of model.indexes) {
      const actual = existing.get(index.name);
      if (actual !== undefined) {
        if (!sameJson(actual.keys, index.keys) || (actual.unique === true) !== index.unique || (actual.sparse === true) !== index.sparse) {
          report.drift.push({
            collection: model.name,
            kind: 'index',
            detail: `索引 ${index.name} 与声明不一致（需要 drop 后重建）`,
          });
        }
        continue;
      }
      await db.collection(model.name).createIndex(index.keys, {
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
        ...(index.sparse ? { sparse: true } : {}),
      });
      report.indexes.push(index.name);
    }
  }

  return report;
}
