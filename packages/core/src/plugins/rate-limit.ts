// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * Per-actor rate limiting, reusing the token bucket from the queue runtime.
 *
 * The bucket is enforced at the head of the mailbox, so throttling never
 * reorders messages: a message waits until a token is available instead of
 * being pushed to the back.
 *
 * A per-actor `{ rateLimit: { capacity, rate } }` option overrides the policy.
 */
/** 插件配置（`capacity` 与 `rate` 同义时优先 `rate`，与旧配置兼容）。 */
interface RateLimitOptions {
  capacity?: number;
  rate?: number;
  ratePerSec?: number;
}

/** 结构型 system 视图：内核是 CJS、不能 `import type`，所以只声明本插件真正碰到的字段。 */
interface RateLimitSystem {
  rateLimitPolicy: { capacity: number; rate: number } | null;
}

function rateLimit(options: RateLimitOptions = {}) {
  const capacity = options.capacity ?? options.rate ?? 100;
  const rate = options.rate ?? options.ratePerSec ?? 50;

  return {
    name: 'rateLimit',

    setup(system: RateLimitSystem) {
      system.rateLimitPolicy = { capacity, rate };
    },

    teardown(system: RateLimitSystem | null) {
      if (system) system.rateLimitPolicy = null;
    },
  };
}

module.exports = rateLimit;
module.exports.rateLimit = rateLimit;
