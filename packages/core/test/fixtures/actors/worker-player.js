'use strict';

// Fixture for isolation tests: an actor designed to run in its own worker thread.
const { Actor } = require('../../../src/index.ts');

module.exports = class WorkerPlayer extends Actor {
  preStart() {
    this.state = { hp: 100, calls: 0 };
  }

  async receive(msg, ctx) {
    this.state.calls += 1;
    switch (msg.type) {
      case 'hurt':
        this.state.hp -= msg.damage;
        return this.state.hp;
      case 'state':
        return {
          ...this.state,
          path: ctx.path,
          sender: ctx.sender ? ctx.sender.path : null,
          threadId: require('worker_threads').threadId,
        };
      case 'burn': {
        // Blocks *this* thread only; the main thread must stay responsive.
        const end = Date.now() + msg.ms;
        while (Date.now() < end) { /* spin */ }
        return 'burned';
      }
      case 'boom':
        throw new Error('worker boom');
      case 'spawnChild': {
        const child = await ctx.spawn('./packages/core/test/fixtures/actors/worker-child.js', { id: msg.id });
        return child.path;
      }
      case 'askChild':
        return ctx.ask(msg.target, { type: 'ping' });
      case 'save':
        await ctx.saveSnapshot();
        return 'saved';
      case 'uncloneable':
        return () => 'a function cannot cross the thread boundary';
      case 'ctx-info':
        return {
          handling: ctx.handling,
          span: ctx.span(),
          tell: typeof ctx.tell('nobody', { type: 'noop' }),
        };
      default:
        return { ok: true, type: msg.type };
    }
  }

  postStop() {
    // Runs inside the worker on graceful stop.
    require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'worker-player-stops.log'), 'stopped\n');
  }
};
