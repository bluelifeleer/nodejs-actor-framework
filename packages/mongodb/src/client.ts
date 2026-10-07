import type { MongoDatabaseLike } from './collection-model.ts';

/**
 * **文档能力层**：与具体驱动无关（这里只有官方 `mongodb`，但形状留好了）。
 *
 * 原则与 SQL/Redis 侧一致：常用语义给**薄封装**，逃生通道（`withDb` / `raw` / 原生游标）永远留着。
 */
export type MongoDocument = Record<string, unknown>;

/** 原生 db 的最小结构视图（逃生通道会用完整能力）。 */
export interface MongoNativeDb extends MongoDatabaseLike {
  collection(name: string): MongoNativeCollection;
}
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

/** 驱动句柄：驱动实现归一到这个形状。 */
export interface MongoDriverHandle {
  readonly name: string;
  /** 原生 db（薄封装直接转调；逃生通道也给这个）。 */
  readonly db: MongoNativeDb;
  /** 原生客户端（逃生通道）。 */
  readonly raw: unknown;
  /** 事务：官方驱动用 `session.withTransaction`。 */
  transaction<T>(fn: (db: MongoNativeDb) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
  stats(): Record<string, unknown>;
}

/** 集合的薄封装（每个方法直接转调原生集合，不做"假装完备"的 ORM）。 */
export interface MongoCollection<Doc extends MongoDocument = MongoDocument> {
  readonly name: string;
  /** 原生集合（逃生通道）。 */
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

/** 文档客户端：集合薄封装 + 事务 + 逃生通道。 */
export interface DocumentClient {
  /** 原生客户端（逃生通道）。 */
  readonly raw: unknown;
  /** 原生 db（逃生通道）。 */
  readonly db: MongoNativeDb;
  /** 原生 db 上做点什么（逃生通道，最常用的形式）。 */
  withDb<T>(fn: (db: MongoNativeDb) => Promise<T>): Promise<T>;
  collection<Doc extends MongoDocument = MongoDocument>(name: string): MongoCollection<Doc>;
  /** 事务（官方驱动：`session.withTransaction`）；与 SQL 侧同签名。 */
  transaction<T>(fn: (client: DocumentClient) => Promise<T>): Promise<T>;
}

async function settle<T>(value: Promise<T> | { toArray(): Promise<T> }): Promise<T> {
  if (typeof (value as { toArray?: unknown }).toArray === 'function') {
    return (value as { toArray(): Promise<T> }).toArray();
  }
  return await (value as Promise<T>);
}

/** 用一个驱动句柄造文档客户端。 */
export function createDocumentClient(handle: MongoDriverHandle): DocumentClient {
  const client: DocumentClient = {
    raw: handle.raw,
    db: handle.db,
    withDb: (fn) => fn(handle.db),
    collection<Doc extends MongoDocument = MongoDocument>(name: string): MongoCollection<Doc> {
      const native = handle.db.collection(name);
      return {
        name,
        raw: native,
        find: (filter, options) => native.find(filter, options),
        findOne: (filter, options) => native.findOne(filter, options) as Promise<Doc | null>,
        insertOne: (doc) => native.insertOne(doc),
        insertMany: (docs) => native.insertMany(docs),
        updateOne: (filter, update) => native.updateOne(filter, update),
        updateMany: (filter, update) => native.updateMany(filter, update),
        deleteOne: (filter) => native.deleteOne(filter),
        deleteMany: (filter) => native.deleteMany(filter),
        countDocuments: (filter) => native.countDocuments(filter),
        aggregate: (pipeline) => settle<MongoDocument[]>(native.aggregate(pipeline) as never),
        createIndex: (keys, options) => native.createIndex(keys, options),
        listIndexes: async () => native.listIndexes().toArray(),
        drop: () => native.drop(),
      };
    },
    transaction: (fn) => handle.transaction((db) => fn(createDocumentClient({ ...handle, db }))),
  };
  return client;
}
