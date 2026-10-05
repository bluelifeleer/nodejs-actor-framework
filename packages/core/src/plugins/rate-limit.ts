// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
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
function rateLimit(options = {}) {
  const capacity = options.capacity ?? options.rate ?? 100;
  const rate = options.rate ?? options.ratePerSec ?? 50;

  return {
    name: 'rateLimit',

    setup(system) {
      system.rateLimitPolicy = { capacity, rate };
    },

    teardown(system) {
      if (system) system.rateLimitPolicy = null;
    },
  };
}

module.exports = rateLimit;
module.exports.rateLimit = rateLimit;
