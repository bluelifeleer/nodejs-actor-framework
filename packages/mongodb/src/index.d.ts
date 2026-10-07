/**
 * `@actor/mongodb` 的手写声明面（与 src/index.ts 的运行时导出一一对应，由门禁测试盯着）。
 * 设计见 docs/design/m7-multi-database.md。
 */
import type { BaseConnection, DatabaseAdapter, PoolOptions } from '@actor/db-core';

// --- 驱动与连接 -------------------------------------------------------------
export type MongoDriverName = 'mongodb';
export declare const DEFAULT_MONGO_DRIVER: MongoDriverName;
export interface MongoDriverImpl {
  readonly name: MongoDriverName;
  readonly packageName: string;
}
export declare function resolveMongoDriver(name: MongoDriverName | string): MongoDriverImpl;
/** 框架统一池参数 → MongoDB 官方选项名。 */
export declare function mongoPoolOptions(pool: PoolOptions): Record<string, unknown>;

export interface MongoConnection extends BaseConnection {
  tls?: boolean;
  authSource?: string;
}
export interface MongoConnectInput {
  load: <T>(specifier: string, packageName?: string) => T;
  url: string;
  database: string;
  pool: PoolOptions;
  clientOptions?: Record<string, unknown>;
  emitDriverEvent?: (event: string, detail?: unknown) => void;
}

// --- 声明式集合 -------------------------------------------------------------
export type MongoFieldType =
  | 'objectId' | 'string' | 'integer' | 'double' | 'boolean' | 'date' | 'object' | 'array' | 'binary' | 'null';

export interface MongoFieldSpec {
  type: MongoFieldType;
  required?: boolean;
  items?: MongoFieldType;
  auto?: 'create' | 'update';
  version?: boolean;
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
  fields?: Record<string, MongoFieldSpec>;
  indexes?: readonly MongoIndexSpec[];
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
  /** `null` = 没有字段声明 → 不设 validator（也就谈不上字段漂移）。 */
  readonly jsonSchema: Record<string, unknown> | null;
  readonly versionField: string | null;
  readonly autoCreateFields: readonly string[];
  readonly autoUpdateFields: readonly string[];
}
/** 声明一个集合（纯函数：不连库、不发命令）。 */
export declare function defineCollection(spec: CollectionSpec): CollectionModel;

export interface CollectionInfo {
  readonly name: string;
  readonly exists: boolean;
  readonly validator: Record<string, unknown> | null;
  readonly indexes: readonly { readonly name: string; readonly keys: Record<string, number> }[];
}
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
  /** 字段漂移**检不了**的集合（没有 validator）—— 如实报告。 */
  readonly fieldDriftUnavailable: string[];
}
export interface MongoSyncOptions {
  /** 允许应用变更（`collMod`）；默认 false：只检测并报漂移。 */
  auto?: boolean;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}
export declare function inspectCollection(db: MongoDatabaseLike, name: string): Promise<CollectionInfo>;
export declare function checkCollectionDrift(model: CollectionModel, info: CollectionInfo): CollectionDriftReport;
export declare function syncCollections(
  db: MongoDatabaseLike,
  models: readonly CollectionModel[],
  options?: MongoSyncOptions,
): Promise<MongoSyncReport>;

// --- 文档能力层 -------------------------------------------------------------
export type MongoDocument = Record<string, unknown>;
export interface MongoNativeCollection {
  find(filter?: MongoDocument, options?: MongoDocument): unknown;
  findOne(filter?: MongoDocument, options?: MongoDocument): Promise<MongoDocument | null>;
  insertOne(doc: MongoDocument, options?: MongoDocument): Promise<{ insertedId: unknown }>;
  insertMany(docs: MongoDocument[], options?: MongoDocument): Promise<{ insertedCount: number }>;
  updateOne(filter: MongoDocument, update: MongoDocument, options?: MongoDocument): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(filter: MongoDocument, update: MongoDocument, options?: MongoDocument): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteOne(filter: MongoDocument, options?: MongoDocument): Promise<{ deletedCount: number }>;
  deleteMany(filter: MongoDocument, options?: MongoDocument): Promise<{ deletedCount: number }>;
  countDocuments(filter?: MongoDocument, options?: MongoDocument): Promise<number>;
  aggregate(pipeline: MongoDocument[], options?: MongoDocument): Promise<MongoDocument[]> | { toArray(): Promise<MongoDocument[]> };
  createIndex(keys: Record<string, number>, options?: MongoDocument): Promise<string>;
  listIndexes(options?: MongoDocument): { toArray(): Promise<Array<{ name: string; key: Record<string, number> }>> };
  drop(options?: MongoDocument): Promise<void>;
}
export interface MongoNativeDb extends MongoDatabaseLike {
  collection(name: string): MongoNativeCollection;
}
export interface MongoDriverHandle {
  readonly name: string;
  readonly db: MongoNativeDb;
  readonly raw: unknown;
  transaction<T>(fn: (db: MongoNativeDb) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
  stats(): Record<string, unknown>;
}
export interface MongoCollection<Doc extends MongoDocument = MongoDocument> {
  readonly name: string;
  readonly raw: MongoNativeCollection;
  find(filter?: MongoDocument, options?: MongoDocument): unknown;
  findOne(filter?: MongoDocument, options?: MongoDocument): Promise<Doc | null>;
  insertOne(doc: Doc): Promise<{ insertedId: unknown }>;
  insertMany(docs: Doc[]): Promise<{ insertedCount: number }>;
  updateOne(filter: MongoDocument, update: MongoDocument): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(filter: MongoDocument, update: MongoDocument): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteOne(filter: MongoDocument): Promise<{ deletedCount: number }>;
  deleteMany(filter: MongoDocument): Promise<{ deletedCount: number }>;
  countDocuments(filter?: MongoDocument): Promise<number>;
  aggregate(pipeline: MongoDocument[]): Promise<MongoDocument[]>;
  createIndex(keys: Record<string, number>, options?: MongoDocument): Promise<string>;
  listIndexes(): Promise<Array<{ name: string; key: Record<string, number> }>>;
  drop(): Promise<void>;
}
export interface DocumentClient {
  readonly raw: unknown;
  readonly db: MongoNativeDb;
  withDb<T>(fn: (db: MongoNativeDb) => Promise<T>): Promise<T>;
  collection<Doc extends MongoDocument = MongoDocument>(name: string): MongoCollection<Doc>;
  transaction<T>(fn: (client: DocumentClient) => Promise<T>): Promise<T>;
}
export declare function createDocumentClient(handle: MongoDriverHandle): DocumentClient;

// --- 适配器 -----------------------------------------------------------------
export interface MongoAdapterOptions {
  driver?: MongoDriverName;
  database?: string;
  collections?: readonly CollectionModel[];
  /** 允许 sync 应用 validator 变更（`collMod`）；默认 false。 */
  auto?: boolean;
  clientOptions?: Record<string, unknown>;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}
export declare function parseMongoUrl(url: string): MongoConnection;
export declare function describeMongo(connection: MongoConnection): string;
export declare function mongoAdapter(options?: MongoAdapterOptions): DatabaseAdapter<DocumentClient, MongoConnection>;
