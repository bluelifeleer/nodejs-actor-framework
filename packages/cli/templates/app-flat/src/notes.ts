import { RepositoryConflictError, type Repository } from '@actor/data';
import { HttpError, defineController, reply } from '@actor/web';

interface Note {
  id?: string;
  version?: number;
  title: string;
}

/**
 * CRUD：读路径走仓储（列表用**游标**分页：并发写入下不漏不重，offset 分页会）。
 * 仓储实例由框架注入（见 module.ts 的 providers），控制器里用 `ctx.get('notes')` 取。
 */
export const notes = {
  create: defineController({
    body: ['title'],
    input: { title: { type: 'string', min: 1 } },
    async handle(input, ctx) {
      const repository = ctx.get('notes') as Repository<Note>;
      const created = await repository.insert({ title: String(input.title) });
      return reply.json(created, { status: 201 });
    },
  }),

  list: defineController({
    input: { limit: { type: 'number', default: 20, min: 1 }, cursor: { type: 'string', default: '' } },
    async handle(input, ctx) {
      const repository = ctx.get('notes') as Repository<Note>;
      const cursor = String(input.cursor ?? '');
      return repository.findMany({
        orderBy: 'id',
        limit: Number(input.limit),
        ...(cursor === '' ? {} : { cursor }),
      });
    },
  }),

  rename: defineController({
    body: ['title', 'expectedVersion'],
    input: {
      id: { type: 'string', min: 1 },
      title: { type: 'string', min: 1 },
      expectedVersion: { type: 'number' },
    },
    async handle(input, ctx) {
      const repository = ctx.get('notes') as Repository<Note>;
      try {
        return await repository.update(
          String(input.id),
          { title: String(input.title) },
          { expectedVersion: Number(input.expectedVersion) },
        );
      } catch (err) {
        // 乐观锁冲突是**业务语义**（409），不是 500：数据层的错误在这里翻译成 HTTP
        if (err instanceof RepositoryConflictError) {
          throw new HttpError(409, err.message, { expected: err.expectedVersion, actual: err.actualVersion });
        }
        throw err;
      }
    },
  }),

  remove: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx) {
      const repository = ctx.get('notes') as Repository<Note>;
      const deleted = await repository.delete(String(input.id));
      if (!deleted) throw new HttpError(404, `note '${String(input.id)}' not found`);
      return reply.noContent();
    },
  }),
};

/**
 * 写路径走 Actor：命令只做校验，状态由 Actor 自己维护并持久化。
 * 查询也走 Actor 只是为了演示 `ask` 的返回值——真实的列表/统计应该走投影或仓储。
 */
export const counter = {
  add: defineController({
    body: ['by'],
    input: { by: { type: 'number', default: 1 } },
    async handle(input, ctx) {
      const counterActor = ctx.actor('Counter') as { ask(message: unknown): Promise<number> };
      return { count: await counterActor.ask({ type: 'add', by: Number(input.by) }) };
    },
  }),

  read: defineController({
    async handle(_input, ctx) {
      const counterActor = ctx.actor('Counter') as { ask(message: unknown): Promise<number> };
      return { count: await counterActor.ask({ type: 'get' }) };
    },
  }),
};

/** 函数式控制器：无输入、无依赖时的最简形态。 */
export const health = (): { ok: boolean } => ({ ok: true });
