/**
 * Token bucket used for per-actor rate limiting.
 *
 * `msUntil()` lets the caller wait for exactly as long as needed instead of
 * busy-polling, and messages are never re-queued just to be throttled later,
 * so priority/FIFO order inside a mailbox is preserved.
 */
export interface TokenBucketLike {
  readonly capacity: number;
  readonly ratePerSec: number;
  available(now?: number): number;
  tryConsume(count?: number): boolean;
  msUntil(count?: number, now?: number): number;
}

export class TokenBucket implements TokenBucketLike {
  readonly capacity: number;
  readonly ratePerSec: number;
  tokens: number;
  lastRefillTs: number;

  constructor(capacity?: number, ratePerSec?: number) {
    this.capacity = Math.max(1, Number(capacity) || 1);
    this.ratePerSec = Math.max(0.001, Number(ratePerSec) || 1);
    this.tokens = this.capacity;
    this.lastRefillTs = Date.now();
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

  tryConsume(count = 1): boolean {
    const now = Date.now();
    this.refill(now);
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Milliseconds until `count` tokens are available (0 when they already are). */
  msUntil(count = 1, now: number = Date.now()): number {
    const tokens = this.refill(now);
    if (tokens >= count) return 0;
    return Math.ceil(((count - tokens) / this.ratePerSec) * 1000);
  }

  consume(count = 1): boolean {
    return this.tryConsume(count);
  }
}

export default TokenBucket;
