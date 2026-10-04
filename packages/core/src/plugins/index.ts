'use strict';

/**
 * Framework plugins: capabilities the queue-shaped runtime used to own, now
 * attached to `createSystem` instead of baked into the actor model.
 *
 *   const { createSystem, plugins } = require('nodejs-actor-framework');
 *   const system = createSystem({
 *     name: 'node-a',
 *     plugins: [
 *       plugins.cluster({ seeds: ['10.0.0.1:7200'] }),
 *       plugins.pubsub(),
 *       plugins.metrics({ exporter: { enabled: true, port: 9464 } }),
 *       plugins.tracing({ sampleRate: 0.1 }),
 *       plugins.deadLetters(),
 *       plugins.rateLimit({ capacity: 100, rate: 50 }),
 *     ],
 *   });
 */

const cluster = require('./cluster.ts');
const pubsub = require('./pubsub.ts');
const metrics = require('./metrics.ts');
const tracing = require('./tracing.ts');
const deadLetters = require('./dead-letters.ts');
const rateLimit = require('./rate-limit.ts');

module.exports = {
  cluster,
  pubsub,
  metrics,
  tracing,
  deadLetters,
  rateLimit,
};
