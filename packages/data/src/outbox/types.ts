/**
 * Outbox（M3 第 5 步，doc 04 §6）。
 *
 * **一个关键设计选择**：不新增"outbox 表"，而是**直接用事件日志当 outbox**。
 *
 * doc 04 §6 要求"事件与 outbox 记录在**同一次写入**里落盘"，因为"先存再发、中间崩溃就丢消息"。
 * 如果把 outbox 做成另一张表/另一个文件，就又要面对"两次写入之间的崩溃窗口"（还得自己造一个
 * 分布式事务）。而事件日志**本身就是**原子写入的记录：事件落盘 = outbox 记录落盘（同一次 append），
 * 投递进度只需要一个**游标**（`OutboxCursorStore`）。
 *
 * 于是投递语义是标准的 **至少一次**：
 *   - 只有 `publish()` 成功之后才推进游标；
 *   - 崩溃在"已发布、未推进"之间 → 下次重发（消费方按 `eventId` 去重，见 `createDedupeSet`）。
 */

/** 一条待投递的事件。 */
export interface OutboxEntry {
  /** 事件在日志里的序号（断点续跑靠它）。 */
  seq: number;
  /** 事件的全局 id（消费方去重靠它）；旧日志可能没有。 */
  eventId: string | null;
  /** 当前形状的事件体（已过 upcast 链）。 */
  event: unknown;
  /** 稳定投递 id：`eventId ?? "<actorPath>#<seq>"`（没有 eventId 的老事件也能去重）。 */
  deliveryId: string;
}

/** 读事件日志（从 `fromSeq` **之后**读）。 */
export interface OutboxLogReader {
  read(fromSeq: number, limit: number): Promise<readonly OutboxEntry[]>;
}

/** 投递游标：**发布成功之后**才推进（这就是"至少一次"的来源）。 */
export interface OutboxCursorStore {
  read(): Promise<number>;
  write(seq: number): Promise<void>;
  ensure?(): Promise<void>;
}

export interface OutboxStats {
  /** 已投递到的序号（0 = 还没投递过）。 */
  cursor: number;
  /** 还没投递的条数。 */
  backlog: number;
  /** 本次进程内累计投递成功/失败/死信。 */
  published: number;
  failed: number;
  deadLettered: number;
}

/** Outbox 相关错误。 */
export class OutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 投递失败（重试次数用尽前的中间态，通常不直接抛给调用方，而是记进 stats）。 */
export class OutboxDeliveryError extends OutboxError {
  readonly seq: number;
  readonly deliveryId: string;
  readonly attempts: number;
  constructor(seq: number, deliveryId: string, attempts: number, cause: unknown) {
    super(
      `投递事件 #${seq}（${deliveryId}）失败，已尝试 ${attempts} 次：` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.seq = seq;
    this.deliveryId = deliveryId;
    this.attempts = attempts;
  }
}
