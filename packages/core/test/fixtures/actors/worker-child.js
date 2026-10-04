'use strict';

const { Actor } = require('../../../src/index.ts');

module.exports = class WorkerChild extends Actor {
  async receive(msg) {
    return `child:${msg.type}`;
  }
};
