// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * Bounded FIFO mailbox.
 *
 * An actor processes one message at a time, so the mailbox is a plain queue
 * with a hard size limit (backpressure) and a system lane that always jumps
 * ahead of user messages (stop / restart notifications).
 */

/** 邮箱里的一条信封（框架内部结构；字段由 actor-cell 填充）。 */
interface MailboxEnvelope {
  payload?: unknown;
  ts?: number;
  /** 被丢弃时的回调（drop-oldest/drop-newest 会调用，让 ask 立刻失败而不是永远等）。 */
  onDropped?: () => void;
  [key: string]: unknown;
}

/** 单条 Actor 的邮箱容量策略。 */
export interface MailboxOptions {
  /** 队列上限（默认 1000）。 */
  maxSize?: number;
  /** 满了怎么办：拒绝新的 / 丢最旧的 / 丢最新的。 */
  overflow?: 'reject' | 'drop-oldest' | 'drop-newest';
}

const OVERFLOW = {
  /** Refuse the new message; tell() returns false, ask() rejects. */
  REJECT: 'reject',
  /** Drop the oldest queued message to make room. */
  DROP_OLDEST: 'drop-oldest',
  /** Drop the incoming message and keep the queue. */
  DROP_NEWEST: 'drop-newest',
};

const VALID_OVERFLOW = new Set(Object.values(OVERFLOW));

class Mailbox {
  readonly maxSize: number;
  readonly overflow: string;
  /** 用户消息（FIFO）。 */
  queue: MailboxEnvelope[];
  /** 系统消息（停机/重启通知），优先于用户消息被取走。 */
  system: MailboxEnvelope[];
  /** 因容量被丢弃的条数（诊断用）。 */
  dropped: number;
  /** 因容量被拒绝的条数（诊断用）。 */
  rejected: number;

  constructor(options: MailboxOptions = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.overflow = options.overflow !== undefined && VALID_OVERFLOW.has(options.overflow) ? options.overflow : OVERFLOW.REJECT;
    this.queue = [];
    this.system = [];
    this.dropped = 0;
    this.rejected = 0;
  }

  get size(): number {
    return this.queue.length + this.system.length;
  }

  get isFull(): boolean {
    return this.size >= this.maxSize;
  }

  /** @returns 是否被接收（false = 因容量拒绝）。 */
  push(envelope: MailboxEnvelope, opts: { system?: boolean } = {}): boolean {
    if (opts.system) {
      this.system.push(envelope);
      return true;
    }
    if (!this.isFull) {
      this.queue.push(envelope);
      return true;
    }
    switch (this.overflow) {
      case OVERFLOW.DROP_OLDEST: {
        // 只逐出用户消息：系统消息（停机/重启通知）绝不能为了腾位置被丢掉
        const evicted = this.queue.shift();
        if (evicted === undefined) {
          this.rejected += 1;
          return false;
        }
        this.dropped += 1;
        if (typeof evicted.onDropped === 'function') evicted.onDropped();
        this.queue.push(envelope);
        return true;
      }
      case OVERFLOW.DROP_NEWEST:
        this.dropped += 1;
        if (typeof envelope.onDropped === 'function') envelope.onDropped();
        return false;
      case OVERFLOW.REJECT:
      default:
        this.rejected += 1;
        return false;
    }
  }

  /** 取一条：系统消息优先，其次用户消息；空队列返回 null。 */
  shift(): MailboxEnvelope | null {
    if (this.system.length > 0) return this.system.shift() ?? null;
    return this.queue.shift() ?? null;
  }

  /** Put a message ahead of its peers (used by retry handling). */
  pushFront(envelope: MailboxEnvelope): boolean {
    this.queue.unshift(envelope);
    return true;
  }

  /** Drop every queued user message (used when an actor stops). */
  drain(): MailboxEnvelope[] {
    const all = [...this.system, ...this.queue];
    this.system = [];
    this.queue = [];
    return all;
  }

  clear(): void {
    this.dropped += this.queue.length + this.system.length;
    this.system = [];
    this.queue = [];
  }
}

module.exports = Mailbox;
module.exports.OVERFLOW = OVERFLOW;
