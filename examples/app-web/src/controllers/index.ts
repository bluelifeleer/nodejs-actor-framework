import { defineController, reply } from '@actor/web';

type RoomHandle = { ask: (msg: unknown, timeoutMs?: number) => Promise<unknown> };

/** 普通函数式控制器（无依赖、无输入校验）。 */
export const health = (): { ok: boolean } => ({ ok: true });

/** POST /join：输入来自请求体（用 body 显式声明，规则 3 会在启动期校验）。 */
export const joinController = defineController({
  body: ['playerId'],
  input: { playerId: { type: 'string', min: 1 } },
  async handle(input, ctx) {
    const room = ctx.actor('Room') as RoomHandle;
    const joined = await room.ask({ type: 'join', playerId: input.playerId });
    return reply.json(joined, { status: 201 });
  },
});

/** GET /rooms/:id?verbose= ：路径参数 + 查询参数混用。 */
export const roomController = defineController({
  input: { id: { type: 'number', min: 1 }, verbose: { type: 'boolean', default: false } },
  async handle(input, ctx) {
    const room = ctx.actor('Room') as RoomHandle;
    const state = (await room.ask({ type: 'state' })) as Record<string, unknown>;
    return input.verbose ? state : { id: state.id };
  },
});

/** GET /slow ：演示**每请求超时**——ask 超时后由框架映射成 504。 */
export const slowController = defineController({
  async handle(_input, ctx) {
    const room = ctx.actor('Room') as RoomHandle;
    return room.ask({ type: 'slow' }, 200); // 与内核一致：第二个参数是超时毫秒数
  },
});
