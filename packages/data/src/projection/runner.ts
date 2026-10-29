/**
 * 投影执行器（M3 第 6 步）。
 *
 * 与 outbox 投递器共用同一套地基：**游标**（断点）+ **去重集合**（至少一次下的幂等）+
 * **日志读取**（`readEntries`）。区别只在"投递"换成"写读模型"。
 */

import {
  createDedupeSet,
  type DedupeSet,
  type OutboxCursorStore,
  type OutboxEntry,
  type OutboxLogReader,
} from '../outbox/index.ts';
import { createDataClock, type DataClock, type TimerHandle } from '../clock/index.ts';
import type { Repository } from '../repository/index.ts';
import {
  ProjectionError,
  ProjectionHandleError,
  type ProjectionCatchUpResult,
  type ProjectionContext,
  type ProjectionSpec,
  type ProjectionStatus,
} from './types.ts';

type Entity = Record<string, unknown>;

export interface ProjectionRunnerOptions {
  projection: ProjectionSpec;
  /** 事件来源（通常 `createOutboxLogReader({ loadRecords: () => store.loadEvents(path), registry })`）。 */
  reader: OutboxLogReader;
  /** 读模型仓储。 */
  repository: Repository<Entity>;
  /** 去重集合背后的仓储（通常是另一张表 / 另一个目录）。 */
  dedupeRepository: Repository<Entity>;
  /** 进度游标（断点续跑）。 */
  cursor: OutboxCursorStore;
  /** id 字段名（默认 `id`）。 */
  idField?: string;
  /** 一批最多读多少条（默认 200）。 */
  batchSize?: number;
  /** 可注入时钟（默认真实定时器）：虚拟时钟下轮询可被 `advance()` 瞬时推进。 */
  clock?: DataClock;
  log?(message: string, meta?: unknown): void;
}

export interface ProjectionRunner {
  /** 从断点追到最新（或最多 `maxBatches` 批）。 */
  catchUp(options?: { maxBatches?: number }): Promise<ProjectionCatchUpResult>;
  /**
   * 从 0 重建。
   *
   * 默认重建到**当前**读模型；给 `repository` 就能重建到**影子读模型**（doc 04 §7 的
   * "离线重建 + 原子切换"：先灌影子表，再由调用方切换指针，重建期间线上读不受影响）。
   */
  rebuild(options?: {
    repository?: Repository<Entity>;
    /** 覆盖"清空读模型"的方式（SQL 可以直接 `DELETE FROM`，比逐行删快得多）。 */
    clear?: (repository: Repository<Entity>) => Promise<void>;
    /** 保留去重集合（默认**不保留**：重建必须重放，留着去重会把事件全挡掉）。 */
    keepDedupe?: boolean;
  }): Promise<ProjectionCatchUpResult>;
  status(): Promise<ProjectionStatus>;
  /** 等进度追到 `offset`（"读己之写"）：超时抛错，而不是无限等。 */
  waitFor(offset: number, options?: { timeoutMs?: number; pollMs?: number }): Promise<ProjectionStatus>;
  start(options?: { intervalMs?: number }): void;
  stop(): Promise<void>;
  /** 当 Actor 用：`system.spawn(projection.asActor(), { id: 'user-list' })`。 */
  asActor(options?: { intervalMs?: number }): Record<string, unknown>;
}

/** 逐页删空一个仓储（重建用）。 */
export async function clearRepository(
  repository: Repository<Entity>,
  options: { batchSize?: number; idField?: string } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 200;
  const idField = options.idField ?? 'id';
  let deleted = 0;
  for (;;) {
    // 逐页删：删掉一页之后，不带游标的 findMany 自然返回"下一批"（前一批已经不在库里了）
    const page = await repository.findMany({ limit: batchSize });
    if (page.items.length === 0) break;
    let deletedThisPage = 0;
    for (const item of page.items) {
      const id = item[idField];
      if (id === undefined || id === null) continue;
      if (await repository.delete(String(id))) {
        deleted += 1;
        deletedThisPage += 1;
      }
    }
    if (deletedThisPage === 0) {
      // idField 配错时原实现会永远删不掉、永远拿到同一页 → rebuild() 挂死。
      throw new ProjectionError(
        `clearRepository: page of ${page.items.length} rows deleted nothing (idField="${idField}" does not match the entities?)`,
      );
    }
    if (page.items.length < batchSize) break;
  }
  return deleted;
}

export function createProjectionRunner(options: ProjectionRunnerOptions): ProjectionRunner {
  if (!options?.projection || typeof options.projection.handle !== 'function') {
    throw new ProjectionError('projection runner 需要 projection.handle()');
  }
  if (!options.reader || typeof options.reader.read !== 'function') {
    throw new ProjectionError('projection runner 需要 reader（提供 read）');
  }
  if (!options.repository || typeof options.repository.findMany !== 'function') {
    throw new ProjectionError('projection runner 需要 repository（读模型）');
  }
  if (!options.dedupeRepository || typeof options.dedupeRepository.insert !== 'function') {
    throw new ProjectionError('projection runner 需要 dedupeRepository（去重集合背后的仓储）');
  }
  if (!options.cursor || typeof options.cursor.read !== 'function') {
    throw new ProjectionError('projection runner 需要 cursor（提供 read / write）');
  }
  const batchSize = options.batchSize ?? 200;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new ProjectionError(`batchSize 必须是 >= 1 的整数（当前 ${String(batchSize)}）`);
  }

  const log = options.log ?? (() => undefined);
  const idField = options.idField ?? 'id';
  const subscriptions = options.projection.subscriptions;
  const counters = { processed: 0, duplicates: 0, skipped: 0 };
  const dedupe: DedupeSet = createDedupeSet({ repository: options.dedupeRepository });
  const clock: DataClock = options.clock ?? createDataClock();
  let timer: TimerHandle | null = null;
  let inFlight: Promise<unknown> | null = null;

  const subscribed = (entry: OutboxEntry): boolean => {
    if (!subscriptions || subscriptions.length === 0) return true;
    // 以信封上的 type 为准（`entry.type`）；兜底看 payload 里有没有 type（老事件体是自带 type 的）
    const type =
      typeof entry.type === 'string'
        ? entry.type
        : (entry.event as { type?: unknown } | null | undefined)?.type;
    return typeof type === 'string' && subscriptions.includes(type);
  };

  const contextFor = (repository: Repository<Entity>): ProjectionContext => ({
    repository,
    checkpoint: async (seq) => options.cursor.write(seq),
    log,
  });

  /** 真实积压总量：按批一直读到尾（`status()` 是诊断调用，不在热路径上）。 */
  async function totalBacklog(fromSeq: number): Promise<number> {
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

  async function catchUpOnce(
    repository: Repository<Entity>,
    maxBatches: number,
  ): Promise<ProjectionCatchUpResult> {
    await options.cursor.ensure?.();
    let cursor = await options.cursor.read();
    let batches = 0;
    const run = { processed: 0, duplicates: 0, skipped: 0 };

    while (batches < maxBatches) {
      const entries = await options.reader.read(cursor, batchSize);
      if (entries.length === 0) break;
      batches += 1;

      for (const entry of entries) {
        if (!subscribed(entry)) {
          counters.skipped += 1;
          run.skipped += 1;
          cursor = entry.seq;
          await options.cursor.write(cursor);
          continue;
        }
        // 去重：handler 成功但游标没落盘时，这里会把重放挡掉（业务恰好一次）
        const first = await dedupe.mark(entry.deliveryId);
        if (!first) {
          counters.duplicates += 1;
          run.duplicates += 1;
          cursor = entry.seq;
          await options.cursor.write(cursor);
          continue;
        }
        try {
          await options.projection.handle(entry, contextFor(repository));
        } catch (err) {
          // 处理失败：**游标不推进**，下次重试它（去重记录已写入，但这不影响重试：
          // 重试时 mark 会返回 false —— 所以这里要把去重记录撤掉，否则会永久跳过这条事件）
          await options.dedupeRepository.delete(entry.deliveryId).catch(() => undefined);
          throw new ProjectionHandleError(options.projection.name, entry, err);
        }
        counters.processed += 1;
        run.processed += 1;
        cursor = entry.seq;
        await options.cursor.write(cursor);
      }

      if (entries.length < batchSize) break;
    }

    const status = await api.status();
    return { ...status, batches, caughtUp: status.backlog === 0, run };
  }

  const api: ProjectionRunner = {
    async catchUp(catchUpOptions = {}) {
      return catchUpOnce(options.repository, catchUpOptions.maxBatches ?? Number.POSITIVE_INFINITY);
    },

    async rebuild(rebuildOptions = {}) {
      const target = rebuildOptions.repository ?? options.repository;
      const clear =
        rebuildOptions.clear ??
        ((repository: Repository<Entity>) => clearRepository(repository, { idField }));
      await clear(target);
      // 去重集合也必须清空：留着它会把重放的事件全部挡成"重复"（读模型就建不出来了）
      if (rebuildOptions.keepDedupe !== true) await clearRepository(options.dedupeRepository);
      await options.cursor.ensure?.();
      await options.cursor.write(0);
      log(`投影 '${options.projection.name}' 从 0 重建`, { into: rebuildOptions.repository ? 'shadow' : 'current' });
      return catchUpOnce(target, Number.POSITIVE_INFINITY);
    },

    async status() {
      await options.cursor.ensure?.();
      const cursor = await options.cursor.read();
      return { cursor, backlog: await totalBacklog(cursor), ...counters };
    },

    async waitFor(offset, waitOptions = {}) {
      const timeoutMs = waitOptions.timeoutMs ?? 5000;
      const pollMs = waitOptions.pollMs ?? 10;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const status = await api.status();
        if (status.cursor >= offset) return status;
        if (Date.now() >= deadline) {
          throw new ProjectionError(
            `投影 '${options.projection.name}' 在 ${timeoutMs}ms 内没有追到 offset=${offset}` +
              `（当前 ${status.cursor}，积压 ${status.backlog}）`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },

    start(startOptions = {}) {
      if (timer !== null) return;
      const intervalMs = startOptions.intervalMs ?? 1000;
      timer = clock.setInterval(() => {
        void runGuarded().catch((err) =>
          log('投影轮询失败', { projection: options.projection.name, err: err instanceof Error ? err.message : String(err) }),
        );
      }, intervalMs);
      // unref 语义由时钟实现保留
    },

    async stop() {
      if (timer !== null) {
        clock.clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => undefined);
    },

    asActor(actorOptions = {}) {
      return {
        preStart: () => api.start(actorOptions),
        postStop: () => api.stop(),
        async receive(msg: unknown) {
          const command = (msg as { type?: string })?.type;
          if (command === 'catchUp' || command === 'drain') return api.catchUp();
          if (command === 'rebuild') return api.rebuild();
          return api.status();
        },
      };
    },
  };

  const runGuarded = (): Promise<ProjectionCatchUpResult> => {
    if (inFlight) return inFlight as Promise<ProjectionCatchUpResult>;
    const run = api.catchUp().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };

  return api;
}
