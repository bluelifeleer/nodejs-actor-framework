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

/** 事务会话（官方驱动 `ClientSession` 的最小结构视图）。 */
export interface MongoSessionLike {
  readonly id?: unknown;
  endSession(): Promise<void>;
}

/** 驱动句柄：驱动实现归一到这个形状。 */
export interface MongoDriverHandle {
  readonly name: string;
  /** 原生 db（薄封装直接转调；逃生通道也给这个）。 */
  readonly db: MongoNativeDb;
  /** 原生客户端（逃生通道）。 */
  readonly raw: unknown;
  /** 事务：官方驱动用 `session.withTransaction`；回调必须拿到 session 才能把操作纳入事务。 */
  transaction<T>(fn: (db: MongoNativeDb, session: MongoSessionLike) => Promise<T>): Promise<T>;
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
  insertOne(doc: Doc, options?: MongoDocument): Promise<{ insertedId: unknown }>;
  insertMany(docs: Doc[], options?: MongoDocument): Promise<{ insertedCount: number }>;
  updateOne(filter: MongoDocument, update: MongoDocument, options?: MongoDocument): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(filter: MongoDocument, update: MongoDocument, options?: MongoDocument): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteOne(filter: MongoDocument, options?: MongoDocument): Promise<{ deletedCount: number }>;
  deleteMany(filter: MongoDocument, options?: MongoDocument): Promise<{ deletedCount: number }>;
  countDocuments(filter?: MongoDocument, options?: MongoDocument): Promise<number>;
  aggregate(pipeline: MongoDocument[], options?: MongoDocument): Promise<MongoDocument[]>;
  createIndex(keys: Record<string, number>, options?: MongoDocument): Promise<string>;
  listIndexes(options?: MongoDocument): Promise<Array<{ name: string; key: Record<string, number> }>>;
  drop(options?: MongoDocument): Promise<void>;
}

/** 文档客户端：集合薄封装 + 事务 + 逃生通道。 */
export interface DocumentClient {
  /** 原生客户端（逃生通道）。 */
  readonly raw: unknown;
  /** 原生 db（逃生通道）。 */
  readonly db: MongoNativeDb;
  /** 当前客户端绑定的事务会话（普通客户端为 undefined）。 */
  readonly session?: MongoSessionLike;
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
export function createDocumentClient(handle: MongoDriverHandle, session?: MongoSessionLike): DocumentClient {
  /**
   * 事务内的每个操作都必须带 `{ session }`；官方驱动不会自动从 `withTransaction` 的
   * 回调上下文里推断它。这里把注入集中到一处，避免每个调用点漏传。
   */
  const withSession = (options?: MongoDocument): MongoDocument | undefined =>
    session === undefined ? options : { ...(options ?? {}), session };
  const client: DocumentClient = {
    raw: handle.raw,
    db: handle.db,
    ...(session === undefined ? {} : { session }),
    withDb: (fn) => fn(handle.db),
    collection<Doc extends MongoDocument = MongoDocument>(name: string): MongoCollection<Doc> {
      const native = handle.db.collection(name);
      return {
        name,
        raw: native,
        find: (filter, options) => native.find(filter, withSession(options)),
        findOne: (filter, options) => native.findOne(filter, withSession(options)) as Promise<Doc | null>,
        insertOne: (doc, options) => native.insertOne(doc, withSession(options)),
        insertMany: (docs, options) => native.insertMany(docs, withSession(options)),
        updateOne: (filter, update, options) => native.updateOne(filter, update, withSession(options)),
        updateMany: (filter, update, options) => native.updateMany(filter, update, withSession(options)),
        deleteOne: (filter, options) => native.deleteOne(filter, withSession(options)),
        deleteMany: (filter, options) => native.deleteMany(filter, withSession(options)),
        countDocuments: (filter, options) => native.countDocuments(filter, withSession(options)),
        aggregate: (pipeline, options) => settle<MongoDocument[]>(native.aggregate(pipeline, withSession(options)) as never),
        createIndex: (keys, options) => native.createIndex(keys, withSession(options)),
        listIndexes: async (options) => native.listIndexes(withSession(options)).toArray(),
        drop: (options) => native.drop(withSession(options)),
      };
    },
    transaction: (fn) =>
      handle.transaction((db, txSession) => fn(createDocumentClient({ ...handle, db }, txSession))),
  };
  return client;
}
