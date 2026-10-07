import { defineModel } from '@actor/db';

/**
 * **model 层**（用户写）：声明字段类型、约束、默认值、以及自己需要的映射钩子。
 * 框架据声明建表（`db.sync`）、做漂移检测、并在仓储里做行 ↔ 实体映射。
 */
export const Note = defineModel({
  name: 'notes',
  fields: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'string', length: 200, notNull: true },
    body: { type: 'text', default: '' },
    // JSON 列：库里是文本，领域里是数组（框架的默认编解码搞定）
    tags: { type: 'json', default: [] },
    done: { type: 'boolean', default: false },
    createdAt: { type: 'timestamp', auto: 'create' },
    updatedAt: { type: 'timestamp', auto: 'update' },
    version: { type: 'integer', version: true }, // 乐观锁
  },
  indexes: [{ fields: ['done'] }],
});
