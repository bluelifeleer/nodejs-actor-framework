/**
 * `@actor/mongodb`：MongoDB 适配器（官方 `mongodb` 驱动）+ `defineCollection`。
 *
 * 连接生命周期（建连/探活/保活/事件转发/drain/关闭）由 `@actor/db-core` 的 `supervise()` 统一提供：
 *
 * ```ts
 * import { mongoAdapter, defineCollection } from '@actor/mongodb';
 * import { supervise } from '@actor/db-core';
 *
 * const Event = defineCollection({
 *   name: 'events',
 *   fields: { type: { type: 'string', required: true }, at: { type: 'date', auto: 'create' } },
 *   indexes: [{ fields: ['type', 'at'] }],
 *   validator: { strict: true },
 * });
 *
 * const mongo = supervise(mongoAdapter({ collections: [Event] }), {
 *   connection: { url: 'mongodb://127.0.0.1:27017/app' },
 * });
 * await mongo.connect();          // 缺集合/索引会建；validator 变更要显式 { auto: true }
 * const db = await mongo.acquire();
 * await db.collection('events').insertOne({ type: 'created' });
 * ```
 *
 * ⚠️ **诚实边界**：MongoDB 是 schemaless —— 没有 `$jsonSchema` validator 的集合**无法谈字段漂移**，
 * 只能检索引漂移（`sync` 会在 `fieldDriftUnavailable` 里如实说明）。
 */
export {
  describeMongo,
  mongoAdapter,
  parseMongoUrl,
  type MongoAdapterOptions,
  type MongoConnection,
} from './adapter.ts';

export {
  checkCollectionDrift,
  defineCollection,
  inspectCollection,
  syncCollections,
  type CollectionDriftItem,
  type CollectionDriftReport,
  type CollectionInfo,
  type CollectionModel,
  type CollectionSpec,
  type MongoDatabaseLike,
  type MongoFieldSpec,
  type MongoFieldType,
  type MongoIndexSpec,
  type MongoSyncOptions,
  type MongoSyncReport,
  type NormalizedMongoIndex,
} from './collection-model.ts';

export {
  createDocumentClient,
  type DocumentClient,
  type MongoCollection,
  type MongoDocument,
  type MongoDriverHandle,
  type MongoNativeCollection,
  type MongoNativeDb,
} from './client.ts';

export { DEFAULT_MONGO_DRIVER, mongoPoolOptions, resolveMongoDriver, type MongoDriverName } from './adapters/index.ts';
