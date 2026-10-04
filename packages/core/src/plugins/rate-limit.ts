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
