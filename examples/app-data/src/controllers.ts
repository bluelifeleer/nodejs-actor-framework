import { RepositoryConflictError, type Repository } from '@actor/data';
import { defineController, HttpError, reply } from '@actor/web';

interface Note {
  id?: string;
  version?: number;
  title: string;
  tag?: string;
}

/** CRUD：读路径走仓储（列表用**游标**分页，不用 offset）。 */
export const notesController = {
  create: defineController({
    body: ['title', 'tag'],
    input: { title: { type: 'string', min: 1 }, tag: { type: 'string', default: 'general' } },
    async handle(input, ctx): Promise<unknown> {
      const notes = ctx.get('notes') as Repository<Note>;
      const created = await notes.insert({ title: input.title as string, tag: input.tag as string });
      return reply.json(created, { status: 201 });
    },
  }),

  list: defineController({
    input: { limit: { type: 'number', default: 10, min: 1 }, cursor: { type: 'string', default: '' } },
    async handle(input, ctx): Promise<unknown> {
      const notes = ctx.get('notes') as Repository<Note>;
      const limit = Number(input.limit);
      const cursor = String(input.cursor ?? '');
      return notes.findMany({ orderBy: 'id', limit, ...(cursor === '' ? {} : { cursor }) });
    },
  }),

  get: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const notes = ctx.get('notes') as Repository<Note>;
      const found = await notes.findById(String(input.id));
      if (found === null) throw new HttpError(404, `note '${String(input.id)}' not found`);
      return found;
    },
  }),

  patch: defineController({
    body: ['title', 'expectedVersion'],
    input: {
      id: { type: 'string', min: 1 },
      title: { type: 'string', min: 1 },
      expectedVersion: { type: 'number' },
    },
    async handle(input, ctx): Promise<unknown> {
      const notes = ctx.get('notes') as Repository<Note>;
      try {
        return await notes.update(
          String(input.id),
          { title: input.title as string },
          { expectedVersion: Number(input.expectedVersion) },
        );
      } catch (err) {
        // 乐观锁冲突是**业务语义**（409），不是 500：数据层的错误类型在这里翻译成 HTTP 语义
        if (err instanceof RepositoryConflictError) {
          throw new HttpError(409, err.message, { expected: err.expectedVersion, actual: err.actualVersion });
        }
        throw err;
      }
    },
  }),

  remove: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const notes = ctx.get('notes') as Repository<Note>;
      const deleted = await notes.delete(String(input.id));
      if (!deleted) throw new HttpError(404, `note '${String(input.id)}' not found`);
      return reply.noContent();
    },
  }),
};

/** 写路径走 Actor（聚合）：控制器只负责把 HTTP 语义翻译成一条命令。 */
export const ordersController = {
  addItem: defineController({
    body: ['price'],
    input: { id: { type: 'string', min: 1 }, price: { type: 'number', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const order = ctx.actor('Order') as { ask(message: unknown, timeoutMs?: number): Promise<unknown> };
      return order.ask({ type: 'addItem', orderId: String(input.id), price: Number(input.price) });
    },
  }),

  confirm: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const order = ctx.actor('Order') as { ask(message: unknown, timeoutMs?: number): Promise<unknown> };
      return order.ask({ type: 'confirm', orderId: String(input.id) });
    },
  }),

  /**
   * **读路径走投影，不查 Actor**（doc 04 §1 的分工原则：写路径串行、读路径可扩展）。
   * 所以这里没有"读聚合状态"的接口——那会教出反模式。命令的返回值里已经能看到新状态。
   *
   * 读模型是**最终一致**的：刚写完立刻读可能还没追上（下面用 202 表达"还没追上"，
   * 需要"读己之写"时用 `runner.waitFor(offset)`）。
   */
  summary: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const summaries = ctx.get('summaries') as Repository<Record<string, unknown>>;
      const row = await summaries.findById(String(input.id));
      return row ?? reply.json({ pending: true }, { status: 202 });
    },
  }),
};
