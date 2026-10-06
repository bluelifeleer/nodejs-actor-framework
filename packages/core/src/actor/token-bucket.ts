// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * Token bucket used for per-actor rate limiting.
 *
 * `msUntil()` lets the caller wait for exactly as long as needed instead of
 * busy-polling, and messages are never re-queued just to be throttled later,
 * so priority/FIFO order inside a mailbox is preserved.
 *
 * 迁移期写法见 restart-strategy.ts（CJS + `export type` + `module.exports`）。
 */
export interface TokenBucketLike {
  readonly capacity: number;
  readonly ratePerSec: number;
  available(now?: number): number;
  tryConsume(count?: number, now?: number): boolean;
  msUntil(count?: number, now?: number): number;
}

class TokenBucket implements TokenBucketLike {
  readonly capacity: number;
  readonly ratePerSec: number;
  tokens: number;
  lastRefillTs: number;

  /**
   * `now` 是"起始时间"，必须由调用方从**系统时钟**传进来。
   *
   * 这里踩过一次：桶用 `Date.now()` 初始化，而系统的其它部分用注入的虚拟时钟——
   * 两个时钟一混，`elapsedMs` 永远是 0，令牌永远不补充，限流从此变成"永久卡住"。
   * 时间来源只能有一个。
   */
  constructor(capacity?: number, ratePerSec?: number, now: number = Date.now()) {
    this.capacity = Math.max(1, Number(capacity) || 1);
    this.ratePerSec = Math.max(0.001, Number(ratePerSec) || 1);
    this.tokens = this.capacity;
    this.lastRefillTs = now;
  }

  refill(now: number = Date.now()): number {
    const elapsedMs = Math.max(0, now - this.lastRefillTs);
    if (elapsedMs === 0) return this.tokens;
    this.lastRefillTs = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.ratePerSec);
    return this.tokens;
  }

  available(now: number = Date.now()): number {
    return this.refill(now);
  }

  /**
   * 消费令牌。`now` 必须由调用方从**系统时钟**传入（与 `msUntil` / `available` 一致）——
   * 这里曾经内部写死 `Date.now()`：于是每次消费都把桶的时间戳拽回真实时间，
   * 注入虚拟时钟后 `elapsedMs` 恒为 0，令牌永远不补充、限流变成"永久卡住"。
   */
  tryConsume(count = 1, now: number = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= count - 1e-9) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Milliseconds until `count` tokens are available (0 when they already are). */
  msUntil(count = 1, now: number = Date.now()): number {
    const tokens = this.refill(now);
    if (tokens >= count) return 0;
    const missing = count - tokens;
    // 浮点累积的噪声不算"缺令牌"：按 0.1/次累加 10 次会得到 0.9999999999999999，
    // 不加 epsilon 就会为一个 1e-16 的缺口多等 1ms（虚拟时钟下表现为"推进到点还是没轮到"）。
    if (missing <= 1e-9) return 0;
    return Math.ceil((missing / this.ratePerSec) * 1000);
  }

  consume(count = 1): boolean {
    return this.tryConsume(count);
  }
}

module.exports = TokenBucket;
module.exports.TokenBucket = TokenBucket;
