/**
 * 假 MongoDB：实现 `defineCollection`/`sync` 真正用到的那几种操作
 * （listCollections / createCollection / command(collMod) / listIndexes / createIndex）。
 */
export interface FakeCollectionState {
  validator: Record<string, unknown> | null;
  indexes: Array<{ name: string; keys: Record<string, number>; unique?: boolean; sparse?: boolean }>;
}

export interface FakeMongoDb {
  /** 文档操作（client 层测试用）：按等值过滤的内存实现。 */
  readonly docs: Map<string, Array<Record<string, unknown>>>;
  listCollections(filter: { name: string }): { toArray(): Promise<Array<{ name: string; options?: Record<string, unknown> }>> };
  createCollection(name: string, options?: Record<string, unknown>): Promise<unknown>;
  command(command: Record<string, unknown>): Promise<unknown>;
  collection(name: string): {
    find(filter?: Record<string, unknown>): { toArray(): Promise<Array<Record<string, unknown>>> };
    findOne(filter?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    insertOne(doc: Record<string, unknown>): Promise<{ insertedId: unknown }>;
    insertMany(docs: Array<Record<string, unknown>>): Promise<{ insertedCount: number }>;
    updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number; modifiedCount: number }>;
    deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
    countDocuments(filter?: Record<string, unknown>): Promise<number>;
    aggregate(pipeline: Array<Record<string, unknown>>): { toArray(): Promise<Array<Record<string, unknown>>> };
    listIndexes(): { toArray(): Promise<Array<{ name: string; key: Record<string, number> }>> };
    createIndex(keys: Record<string, number>, options?: Record<string, unknown>): Promise<string>;
    drop(): Promise<void>;
  };
  readonly commands: Array<Record<string, unknown>>;
  readonly indexCommands: Array<{ collection: string; keys: Record<string, number>; name?: string; options?: Record<string, unknown> }>;
}

export function createFakeMongoDb(
  initial: { collections?: Record<string, FakeCollectionState> } = {},
  recordOptions?: (options: Record<string, unknown> | undefined) => void,
): FakeMongoDb {
  const collections = new Map<string, FakeCollectionState>(
    Object.entries(initial.collections ?? {}).map(([name, state]) => [
      name,
      { validator: state.validator, indexes: [...state.indexes] },
    ]),
  );
  const docs = new Map<string, Array<Record<string, unknown>>>();
  const matches = (doc: Record<string, unknown>, filter: Record<string, unknown> = {}): boolean =>
    Object.entries(filter).every(([key, value]) => JSON.stringify(doc[key]) === JSON.stringify(value));
  const commands: Array<Record<string, unknown>> = [];
  const indexCommands: FakeMongoDb['indexCommands'] = [];

  return {
    docs,
    commands,
    indexCommands,
    listCollections(filter) {
      return {
        async toArray() {
          const state = collections.get(filter.name);
          return state === undefined
            ? []
            : [{ name: filter.name, ...(state.validator === null ? {} : { options: { validator: state.validator } }) }];
        },
      };
    },
    async createCollection(name, options = {}) {
      collections.set(name, { validator: (options.validator as Record<string, unknown> | undefined) ?? null, indexes: [] });
      return { ok: 1 };
    },
    async command(command) {
      commands.push(command);
      if ('collMod' in command) {
        const name = String(command.collMod);
        const state = collections.get(name) ?? { validator: null, indexes: [] };
        state.validator = (command.validator as Record<string, unknown> | undefined) ?? null;
        collections.set(name, state);
      }
      return { ok: 1 };
    },
    collection(name) {
      // 注意：同一个集合名必须拿到**同一个数组**（早先写成 `docs.get(name) ?? []`，
      // 于是 insertOne 里两次调用各拿到一个新数组，插入的文档直接丢了 —— 被测试抓到）
      const bucket = (): Array<Record<string, unknown>> => {
        const existing = docs.get(name);
        if (existing !== undefined) return existing;
        const created: Array<Record<string, unknown>> = [];
        docs.set(name, created);
        return created;
      };
      return {
        find(filter, options) {
          recordOptions?.(options);
          return { async toArray() { return bucket().filter((doc) => matches(doc, filter)); } };
        },
        async findOne(filter, options) {
          recordOptions?.(options);
          return bucket().find((doc) => matches(doc, filter)) ?? null;
        },
        async insertOne(doc, options) {
          recordOptions?.(options);
          const id = doc._id ?? `id-${bucket().length + 1}`;
          bucket().push({ ...doc, _id: id });
          return { insertedId: id };
        },
        async insertMany(list, options) {
          recordOptions?.(options);
          for (const doc of list) await this.insertOne(doc);
          return { insertedCount: list.length };
        },
        async updateOne(filter, update, options) {
          recordOptions?.(options);
          const target = bucket().find((doc) => matches(doc, filter));
          if (target === undefined) return { matchedCount: 0, modifiedCount: 0 };
          Object.assign(target, (update.$set as Record<string, unknown> | undefined) ?? update);
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteOne(filter, options) {
          recordOptions?.(options);
          const list = bucket();
          const index = list.findIndex((doc) => matches(doc, filter));
          if (index < 0) return { deletedCount: 0 };
          list.splice(index, 1);
          return { deletedCount: 1 };
        },
        async countDocuments(filter, options) {
          recordOptions?.(options);
          return bucket().filter((doc) => matches(doc, filter)).length;
        },
        aggregate(_pipeline, options) {
          recordOptions?.(options);
          return { async toArray() { return bucket(); } };
        },
        listIndexes(options) {
          recordOptions?.(options);
          return {
            async toArray() {
              return (collections.get(name)?.indexes ?? []).map((index) => ({
                name: index.name,
                key: index.keys,
                ...(index.unique === true ? { unique: true } : {}),
                ...(index.sparse === true ? { sparse: true } : {}),
              }));
            },
          };
        },
        async createIndex(keys, options = {}) {
          recordOptions?.(options);
          const indexName = String(options.name ?? Object.keys(keys).join('_'));
          indexCommands.push({ collection: name, keys, name: indexName, options });
          const state = collections.get(name) ?? { validator: null, indexes: [] };
          if (!state.indexes.some((index) => index.name === indexName)) {
            state.indexes.push({
              name: indexName,
              keys,
              ...(options.unique === true ? { unique: true } : {}),
              ...(options.sparse === true ? { sparse: true } : {}),
            });
          }
          collections.set(name, state);
          return indexName;
        },
      };
    },
  };
}
