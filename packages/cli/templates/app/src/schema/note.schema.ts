/**
 * 数据层声明（schema 层）：集合/表名、排序键、字段清单。
 *
 * 现在用文件仓储，所以这里只提供"集合名"给 service 层用；换成 SQL 时，
 * 这一层就是 `defineModel` 与迁移意图（索引、外键、演进）的落点——**不要**把这些写进控制器。
 */
export const noteSchema = {
  collection: 'notes',
  orderBy: 'id',
  fields: { id: 'string', version: 'integer', title: 'string' },
} as const;
