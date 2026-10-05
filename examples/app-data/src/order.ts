import path from 'node:path';

import {
  createFileOutboxCursor,
  createOutboxLogReader,
  createProjectionRunner,
  defineAggregate,
  defineEventSchema,
  type ProjectionRunner,
  type Repository,
} from '@actor/data';

/**
 * 事件溯源聚合：**状态只能由事件推导**。
 * - 命令只做"校验 + 产出事件"（`addItem` / `confirm`）；
 * - `applyEvent` 是纯函数：实时处理与重启重放走同一份代码；
 * - `events` 声明结构版本与升级链（这里 v1，演示 `upcasts` 的位置）。
 */
export interface OrderState {
  status: 'created' | 'confirmed';
  totalCents: number;
  items: number;
}

export const ORDER_PATH = 'Order';

export const Order = defineAggregate<OrderState>({
  name: 'Order',
  initialState: () => ({ status: 'created', totalCents: 0, items: 0 }),
  events: [
    defineEventSchema({ type: 'ItemAdded', version: 1 }),
    defineEventSchema({ type: 'OrderConfirmed', version: 1 }),
  ],
  applyEvent: (state, event) => {
    if (event.type === 'ItemAdded') {
      return { ...state, totalCents: state.totalCents + (event.price as number), items: state.items + 1 };
    }
    if (event.type === 'OrderConfirmed') return { ...state, status: 'confirmed' };
    return state;
  },
  commands: {
    addItem: (cmd, state) => {
      const { orderId, price } = cmd as { orderId: string; price: number };
      if (state.status !== 'created') throw new Error('order already confirmed');
      if (!Number.isFinite(price) || price <= 0) throw new Error('price must be a positive number');
      return { type: 'ItemAdded', orderId, price };
    },
    confirm: (cmd, state) =>
      state.status === 'created' ? { type: 'OrderConfirmed', orderId: (cmd as { orderId: string }).orderId } : undefined,
  },
});

/**
 * 投影（读模型）：订单列表用 Actor 做不了（Actor 是单实体串行），
 * 所以由投影把事件折成一张可查询的表。
 *
 * 注意 `loadRecords`：事件日志的读取权在内核那边（这里是应用层，用 `app.kernel` 逃生通道拿到
 * 持久化 store）。数据层只要求一个"能读原始记录"的函数。
 */
export function createOrdersSummaryProjection(options: {
  dataDir: string;
  summaries: Repository<Record<string, unknown>>;
  dedupe: Repository<Record<string, unknown>>;
  loadRecords: () => Promise<readonly unknown[]>;
}): ProjectionRunner {
  return createProjectionRunner({
    projection: {
      name: 'orders-summary',
      subscriptions: ['ItemAdded', 'OrderConfirmed'],
      async handle(entry, ctx) {
        const event = entry.event as { type: string; orderId: string; price?: number };
        const existing = await ctx.repository.findById(event.orderId);
        const items = Number(existing?.items ?? 0) + (event.type === 'ItemAdded' ? 1 : 0);
        const totalCents = Number(existing?.totalCents ?? 0) + (event.type === 'ItemAdded' ? Number(event.price) : 0);
        const status = event.type === 'OrderConfirmed' ? 'confirmed' : String(existing?.status ?? 'created');
        if (existing === null) await ctx.repository.insert({ id: event.orderId, items, totalCents, status });
        else {
          await ctx.repository.update(
            event.orderId,
            { items, totalCents, status },
            { expectedVersion: Number(existing.version) },
          );
        }
      },
    },
    reader: createOutboxLogReader({
      loadRecords: options.loadRecords,
      registry: Order.registry,
      actorPath: ORDER_PATH,
    }),
    repository: options.summaries,
    dedupeRepository: options.dedupe,
    cursor: createFileOutboxCursor({ dir: path.join(options.dataDir, 'projection') }),
  });
}
