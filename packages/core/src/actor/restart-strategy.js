'use strict';

/**
 * Supervision restart strategies.
 *
 * These constants used to live in the queue runtime's `supervisor.js`; the
 * framework owns them now, which is what let the old supervisor be deleted.
 *
 *   const RestartStrategy = require('./restart-strategy');
 *   RestartStrategy.ONE_FOR_ONE
 */
module.exports = Object.freeze({
  ONE_FOR_ONE: 'one_for_one',
  REST_FOR_ONE: 'rest_for_one',
  ONE_FOR_ALL: 'one_for_all',
});
