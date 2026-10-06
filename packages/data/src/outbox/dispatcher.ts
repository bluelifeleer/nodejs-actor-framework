/**
 * 投递器与幂等消费（M3 第 5 步）。
 *
 * 投递器只做一件事：**读日志 → 发布 → 推进游标**（顺序不能反）。失败重试有上限，超了进死信并
 * **跳过**它——否则一条毒消息会把整条流水线永久堵死（保序是好事，但"永远卡住"不是）。
 */

import {
  OutboxDeliveryError,
  OutboxError,
  type OutboxCursorStore,
  type OutboxEntry,
  type OutboxLogReader,
  type OutboxStats,
} from './types.ts';
import { RepositoryDuplicateError, type Repository } from '../repository/index.ts';
import { createDataClock, type DataClock, type TimerHandle } from '../clock/index.ts';

export interface OutboxDispatcherOptions {
  reader: OutboxLogReader;
  cursor: OutboxCursorStore;
  /** 投递函数（pubsub / 集群 / HTTP…）。抛错 = 这次投递失败，会被重试。 */
  publish(entry: OutboxEntry): Promise<void>;
  /** 哪些事件要投递（默认全部）。被过滤掉的事件也会**推进游标**（不然每次都要重读）。 */
  select?(entry: OutboxEntry): boolean;
  /** 单条最多尝试几次（默认 3）。用尽后进死信并跳过。 */
  maxAttempts?: number;
  /** 死信回调（接到内核的死信队列 / 指标上由你决定）。 */
  onDeadLetter?(entry: OutboxEntry, error: unknown): void;
  /** 一批最多读多少条（默认 100）。 */
  batchSize?: number;
  /**
   * 可注入时钟（默认真实定时器）。测试里传 `@actor/testkit` 的虚拟时钟，
   * `advance()` 就能把轮询瞬时推进，而不是 `await sleep(1000)` 真等一轮。
   */
  clock?: DataClock;
  log?(message: string, meta?: unknown): void;
}

export interface OutboxDrainResult {
  published: number;
  failed: number;
  deadLettered: number;
  skipped: number;
  cursor: number;
}

export interface OutboxDispatcher {
  /** 跑一轮：把当前能投的都投掉。可反复调用（幂等：已推进的不会重投）。 */
  drainOnce(): Promise<OutboxDrainResult>;
  /** 起一个轮询循环（内核定时器还没做，这里用 setInterval；重入有保护）。 */
  start(options?: { intervalMs?: number }): void;
  /** 停循环并等当前这一轮跑完。 */
  stop(): Promise<void>;
  stats(): Promise<OutboxStats>;
  /** 交给内核当 Actor 用（`system.spawn(dispatcher.asActor(), { id: 'outbox' })`）。 */
  asActor(options?: { intervalMs?: number }): Record<string, unknown>;
}

export function createOutboxDispatcher(options: OutboxDispatcherOptions): OutboxDispatcher {
  if (!options?.reader || typeof options.reader.read !== 'function') {
    throw new OutboxError('outbox dispatcher 需要 reader（提供 read）');
  }
  if (!options?.cursor || typeof options.cursor.read !== 'function') {
    throw new OutboxError('outbox dispatcher 需要 cursor（提供 read / write）');
  }
  if (typeof options.publish !== 'function') throw new OutboxError('outbox dispatcher 需要 publish()');
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new OutboxError(`maxAttempts 必须是 >= 1 的整数（当前 ${String(maxAttempts)}）`);
  }
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new OutboxError(`batchSize 必须是 >= 1 的整数（当前 ${String(batchSize)}）`);
  }

  const log = options.log ?? (() => undefined);
  /** 进程内的失败计数（崩溃后重来：至少一次语义下这是可接受的）。 */
  const attempts = new Map<number, number>();
  const counters = { published: 0, failed: 0, deadLettered: 0 };
  const clock: DataClock = options.clock ?? createDataClock();
  let timer: TimerHandle | null = null;
  let inFlight: Promise<unknown> | null = null;

  /** 真实积压总量：按批一直读到尾（`stats()` 是诊断调用，不在投递热路径上）。 */
  async function readBacklog(fromSeq: number): Promise<number> {
    let cursor = fromSeq;
    let total = 0;
    for (;;) {
      const entries = await options.reader.read(cursor, batchSize);
      if (entries.length === 0) break;
      total += entries.length;
      cursor = entries[entries.length - 1]?.seq ?? cursor;
      if (entries.length < batchSize) break;
    }
    return total;
  }

  async function drainOnce(): Promise<OutboxDrainResult> {
    await options.cursor.ensure?.();
    let cursor = await options.cursor.read();
    const result: OutboxDrainResult = { published: 0, failed: 0, deadLettered: 0, skipped: 0, cursor };

    for (;;) {
      const entries = await options.reader.read(cursor, batchSize);
      if (entries.length === 0) break;

      let progressed = false;
      for (const entry of entries) {
        if (options.select && !options.select(entry)) {
          // 明确不投的事件也要把游标推过去（否则每轮都要重读它们）
          cursor = entry.seq;
          await options.cursor.write(cursor);
          result.skipped += 1;
          progressed = true;
          continue;
        }
        try {
          await options.publish(entry);
        } catch (error) {
          const used = (attempts.get(entry.seq) ?? 0) + 1;
          if (used >= maxAttempts) {
            attempts.delete(entry.seq);
            counters.deadLettered += 1;
            result.deadLettered += 1;
            log('outbox 事件进入死信', { seq: entry.seq, deliveryId: entry.deliveryId, attempts: used });
            options.onDeadLetter?.(entry, error);
            cursor = entry.seq; // 跳过它，否则一条毒消息会永久堵住后面所有事件
            await options.cursor.write(cursor);
            progressed = true;
            continue;
          }
          attempts.set(entry.seq, used);
          counters.failed += 1;
          result.failed += 1;
          const deliveryError = new OutboxDeliveryError(entry.seq, entry.deliveryId, used, error);
          log('outbox 投递失败，下轮重试', { seq: entry.seq, attempts: used, err: deliveryError.message });
          break; // 保序：这条没成功，后面的先不发
        }

        // 发布成功之后才推进游标：崩溃在两者之间 → 下次重发（至少一次）
        attempts.delete(entry.seq);
        cursor = entry.seq;
        await options.cursor.write(cursor);
        counters.published += 1;
        result.published += 1;
        progressed = true;
      }

      result.cursor = cursor;
      if (!progressed) break; // 卡在失败的那条上，交给下一轮
      if (entries.length < batchSize) break;
    }

    result.cursor = cursor;
    return result;
  }

  const runGuarded = (): Promise<OutboxDrainResult> => {
    if (inFlight) return inFlight as Promise<OutboxDrainResult>;
    const run = drainOnce().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };

  const api: OutboxDispatcher = {
    drainOnce: runGuarded,

    start(startOptions = {}) {
      if (timer !== null) return;
      const intervalMs = startOptions.intervalMs ?? 1000;
      timer = clock.setInterval(() => {
        void runGuarded().catch((err) => log('outbox 轮询失败', { err: err instanceof Error ? err.message : String(err) }));
      }, intervalMs);
      // unref 语义由时钟实现保留（真实时钟下不钉住进程；虚拟时钟下由 advance 驱动）
    },

    async stop() {
      if (timer !== null) {
        clock.clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => undefined);
    },

    async stats() {
      await options.cursor.ensure?.();
      const cursor = await options.cursor.read();
      return {
        cursor,
        backlog: await readBacklog(cursor),
        published: counters.published,
        failed: counters.failed,
        deadLettered: counters.deadLettered,
      };
    },

    asActor(actorOptions = {}) {
      return {
        preStart: () => api.start(actorOptions),
        postStop: () => api.stop(),
        async receive(msg: unknown) {
          const command = (msg as { type?: string })?.type;
          if (command === 'drain') return api.drainOnce();
          return api.stats();
        },
      };
    },
  };

  return api;
}

/* -------------------------------------------------------------------------- */
/* 幂等消费                                                                    */
/* -------------------------------------------------------------------------- */

export interface DedupeSet {
  /** `true` = 第一次见到（应当处理）；`false` = 重复投递（跳过）。 */
  mark(deliveryId: string): Promise<boolean>;
  seen(deliveryId: string): Promise<boolean>;
}

/**
 * 去重集合：**直接用仓储实现**（第 3 步的成果）——`insert` 撞主键就是"重复投递"。
 *
 * 好处是三个后端自动都有：memory（Map）、file（一实体一文件）、SQL（**主键约束**，真去重）。
 * 至少一次投递 + 这个集合 = 消费幂等。
 */
export function createDedupeSet(options: { repository: Repository<Record<string, unknown>> }): DedupeSet {
  const repo = options?.repository;
  if (!repo || typeof repo.insert !== 'function') throw new OutboxError('createDedupeSet 需要 repository');
  return {
    async mark(deliveryId) {
      try {
        await repo.insert({ id: deliveryId });
        return true;
      } catch (err) {
        if (err instanceof RepositoryDuplicateError) return false;
        throw err;
      }
    },
    async seen(deliveryId) {
      return (await repo.findById(deliveryId)) !== null;
    },
  };
}

export interface IdempotentConsumerOptions {
  dedupe: DedupeSet;
  handle(entry: OutboxEntry): Promise<void>;
}

/** 把 `handle` 包成幂等的（同一 `deliveryId` 只执行一次）。 */
export function createIdempotentConsumer(
  options: IdempotentConsumerOptions,
): (entry: OutboxEntry) => Promise<'handled' | 'duplicate'> {
  if (!options?.dedupe || typeof options.dedupe.mark !== 'function') {
    throw new OutboxError('createIdempotentConsumer 需要 dedupe（createDedupeSet 的产物）');
  }
  if (typeof options.handle !== 'function') throw new OutboxError('createIdempotentConsumer 需要 handle()');
  return async (entry) => {
    const first = await options.dedupe.mark(entry.deliveryId);
    if (!first) return 'duplicate';
    await options.handle(entry);
    return 'handled';
  };
}
