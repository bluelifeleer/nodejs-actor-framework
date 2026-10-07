import path from 'node:path';

import { defineModule, type Application } from '@actor/app';
import { createFileRepository, type Repository } from '@actor/data';

import { DATA_DIR } from './paths.ts';
import { createOrdersSummaryProjection, Order, ORDER_PATH } from './order.ts';
import routes from './routes.ts';

/** 投影运行器在 onStart 里起来、onStop 里停掉（模块生命周期）。 */
let projection: { start(o?: { intervalMs?: number }): void; stop(): Promise<void> } | null = null;

export default defineModule({
  name: 'data',
  providers: {
    notes: ({ config }: { config: { get<T>(key: string): T } }) =>
      createFileRepository<Record<string, unknown>>({
        dir: path.join(config.get<string>('dataDir'), 'notes'),
        idField: 'id',
      }),
    summaries: ({ config }: { config: { get<T>(key: string): T } }) =>
      createFileRepository<Record<string, unknown>>({ dir: path.join(config.get<string>('dataDir'), 'summaries') }),
    orderDedupe: ({ config }: { config: { get<T>(key: string): T } }) =>
      createFileRepository<Record<string, unknown>>({ dir: path.join(config.get<string>('dataDir'), 'dedupe') }),
  },
  actors: {
    // 事件溯源 + 快照缓存（每 5 条事件存一次；快照只是缓存，日志才是真相）
    Order: {
      definition: Order,
      options: {
        persistence: { mode: 'events', evolution: Order.evolution ?? undefined, snapshot: { every: 5 } },
      },
    },
  },
  routes,

  async onStart(app: Application) {
    // 事件日志的读取权在内核：这里用应用层的逃生通道拿持久化 store（应用层签名不暴露内核概念）
    const system = app.kernel as { persistenceStore?: { loadEvents(id: string): Promise<unknown[]> } };
    const store = system.persistenceStore;
    if (!store) throw new Error('需要内核持久化 store：请用 createApp(..., { kernel: { persistence: { dir } } })');

    projection = createOrdersSummaryProjection({
      dataDir: DATA_DIR,
      summaries: app.get<Repository<Record<string, unknown>>>('summaries'),
      dedupe: app.get<Repository<Record<string, unknown>>>('orderDedupe'),
      loadRecords: () => store.loadEvents(ORDER_PATH),
    });
    projection.start({ intervalMs: 100 });
  },

  async onStop() {
    await projection?.stop();
    projection = null;
  },
});
