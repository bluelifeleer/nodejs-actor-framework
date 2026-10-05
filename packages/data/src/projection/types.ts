/**
 * 投影 / 读模型（M3 第 6 步，doc 04 §7）。
 *
 * **为什么需要**：列表 / 搜索 / 统计无法用 Actor 做（Actor 是单实体串行）。写路径走 Actor
 * （串行、可事件溯源），读路径走投影（普通仓储 + 索引，可水平扩展、可重建）。
 *
 * 三条性质，实现都围绕它们：
 *   - **最终一致**：投影落后于事件日志是正常的；`waitFor(offset)` 给"读己之写"用；
 *   - **断点续跑**：进度是一个游标（复用 outbox 的 `OutboxCursorStore`），崩了从断点继续；
 *   - **不丢不重**：至少一次投递 + `eventId` 去重（复用仓储主键）⇒ 业务处理恰好一次。
 *     重建时**同时清空读模型、游标与去重集合**，否则重放会被自己的去重挡住。
 */

import type { Repository } from '../repository/index.ts';
import type { DedupeSet, OutboxCursorStore, OutboxEntry, OutboxLogReader } from '../outbox/index.ts';

/** 投影处理一条事件时的上下文。 */
export interface ProjectionContext {
  /** 读模型仓储（列表 / 统计表）。 */
  repository: Repository<Record<string, unknown>>;
  /** 手动记录进度（通常不用手写：runner 在 handler 成功后会推进游标）。 */
  checkpoint(seq: number): Promise<void>;
  log(message: string, meta?: unknown): void;
}

export interface ProjectionSpec {
  /** 投影名（诊断与错误信息用）。 */
  name: string;
  /** 只处理这些事件类型（默认全部）。不订阅的事件**也会推进游标**（不然每轮都要重读）。 */
  subscriptions?: readonly string[];
  /**
   * 处理一条事件。**必须幂等**：至少一次投递下它可能被重放（正常情况下 by `deliveryId` 去重，
   * 但"handler 成功、游标没落盘"那个窗口里它会再跑一次）。
   */
  handle(entry: OutboxEntry, context: ProjectionContext): Promise<void> | void;
}

export interface ProjectionStatus {
  /** 已处理到的序号。 */
  cursor: number;
  /** 还没处理的条数。 */
  backlog: number;
  /** 本次进程内累计：处理成功 / 去重跳过 / 未订阅跳过。 */
  processed: number;
  duplicates: number;
  skipped: number;
}

export interface ProjectionCatchUpResult extends ProjectionStatus {
  /** 本次跑了几批。 */
  batches: number;
  /** 是否追上了最新（backlog === 0）。 */
  caughtUp: boolean;
  /** **本次这一轮**的数字（`status` 里的计数是进程累计，两者用途不同）。 */
  run: { processed: number; duplicates: number; skipped: number };
}

/** 投影相关错误。 */
export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 某个事件的处理失败（游标**不会**推进，下次会重试它）。 */
export class ProjectionHandleError extends ProjectionError {
  readonly seq: number;
  readonly deliveryId: string;
  constructor(name: string, entry: OutboxEntry, cause: unknown) {
    super(
      `投影 '${name}' 处理事件 #${entry.seq}（${entry.deliveryId}）失败：` +
        `${cause instanceof Error ? cause.message : String(cause)}（游标未推进，下次会重试）`,
    );
    this.seq = entry.seq;
    this.deliveryId = entry.deliveryId;
  }
}
