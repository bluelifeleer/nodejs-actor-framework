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

const cluster = require('./cluster');
const pubsub = require('./pubsub');
const metrics = require('./metrics');
const tracing = require('./tracing');
const deadLetters = require('./dead-letters');
const rateLimit = require('./rate-limit');

module.exports = {
  cluster,
  pubsub,
  metrics,
  tracing,
  deadLetters,
  rateLimit,
};
