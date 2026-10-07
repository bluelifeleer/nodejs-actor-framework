import { DbConflictError, type Entity, type Model, type Repository } from '@actor/db';
import { defineController, HttpError, reply } from '@actor/web';

/**
 * 控制器：只依赖**注入进来的仓储**（provider `notes`），完全不关心底层是 sqlite 还是 pgsql。
 *
 * 错误语义：乐观锁冲突 → 409（业务语义，不是 500）；找不到 → 404。
 */
function notesRepo(ctx: { get(name: string): unknown }): Repository<Model> {
  const repository = ctx.get('notes') as Repository<Model> | undefined;
  if (repository === undefined) throw new Error('provider "notes" 没有解析出来');
  return repository;
}

export const notesController = {
  create: defineController({
    body: ['title', 'body', 'tags'],
    input: {
      title: { type: 'string', min: 1 },
      body: { type: 'string', default: '' },
      tags: { type: 'string', default: '' }, // 逗号分隔（示例从简）
    },
    async handle(input, ctx): Promise<unknown> {
      const notes = notesRepo(ctx);
      const created = await notes.insert({
        title: input.title as string,
        body: input.body as string,
        tags: String(input.tags ?? '') === '' ? [] : String(input.tags).split(','),
      });
      return reply.json(created, { status: 201 });
    },
  }),

  list: defineController({
    async handle(_input, ctx): Promise<unknown> {
      const notes = notesRepo(ctx);
      return { notes: await notes.findMany({ orderBy: [{ field: 'createdAt', direction: 'desc' }] }) };
    },
  }),

  get: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const notes = notesRepo(ctx);
      const found = await notes.findById(input.id);
      if (found === null) throw new HttpError(404, `note '${String(input.id)}' not found`);
      return found;
    },
  }),

  patch: defineController({
    body: ['title', 'expectedVersion'],
    input: {
      id: { type: 'string', min: 1 },
      title: { type: 'string' },
      expectedVersion: { type: 'number' },
    },
    async handle(input, ctx): Promise<unknown> {
      const notes = notesRepo(ctx);
      const patch: Entity = {};
      if (typeof input.title === 'string') patch.title = input.title;
      try {
        return await notes.update(input.id, patch, {
          ...(typeof input.expectedVersion === 'number' ? { expectedVersion: Number(input.expectedVersion) } : {}),
        });
      } catch (err) {
        if (err instanceof DbConflictError) {
          throw new HttpError(409, err.message, { expectedVersion: err.expectedVersion });
        }
        throw err;
      }
    },
  }),

  remove: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const notes = notesRepo(ctx);
      const deleted = await notes.delete(input.id);
      if (!deleted) throw new HttpError(404, `note '${String(input.id)}' not found`);
      return { deleted: true };
    },
  }),
};
