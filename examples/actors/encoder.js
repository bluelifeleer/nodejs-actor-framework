import { Actor } from 'nodejs-actor-framework';
import workerThreads from 'node:worker_threads';

/**
 * Example actor module for `isolation: 'worker'`.
 *
 * Worker isolation requires a module path (code cannot be shipped into a
 * thread without an eval), so isolated actors live in their own files.
 */



export default class Encoder extends Actor {
  preStart() {
    this.state = { jobs: 0, lastInput: null };
  }

  async receive(msg, ctx) {
    switch (msg.type) {
      case 'encode': {
        this.state.jobs += 1;
        this.state.lastInput = msg.text;
        // Pretend this is expensive and CPU-bound: it runs on its own thread.
        const end = Date.now() + (msg.burnMs || 0);
        while (Date.now() < end) { /* spin */ }
        return Buffer.from(String(msg.text), 'utf8').toString('base64');
      }
      case 'stats':
        return { ...this.state, threadId: workerThreads.threadId, path: ctx.path };
      default:
        throw new Error(`encoder: unknown message "${msg.type}"`);
    }
  }
};
