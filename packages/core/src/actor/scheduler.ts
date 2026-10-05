// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const config = require('../config.ts');

/**
 * Fair scheduler for in-process actors.
 *
 * Actors are cheap (no thread per actor), so the scheduler is the only thing
 * deciding who runs next. It is deliberately simple and fair rather than
 * clever: on every tick it takes a bounded number of ready actors, and each of
 * them processes a bounded number of messages before yielding. That keeps one
 * busy actor from starving the rest while staying allocation-light.
 */

class InlineScheduler {
  constructor(options = {}) {
    this.messagesPerTurn = options.messagesPerTurn || 16;
    this.cellsPerTurn = options.cellsPerTurn || 64;
    this.onError = options.onError || null;
    /** @type {Set<object>} ready cells, insertion ordered */
    this.ready = new Set();
    this._scheduled = false;
    this._inflight = Promise.resolve();
    this._stopped = false;
    this.ticks = 0;
    this.turns = 0;
  }

  get pending() {
    return this.ready.size;
  }

  schedule(cell) {
    if (this._stopped || !cell || cell.stopped) return;
    // A cell that is mid-turn will re-schedule itself when it finishes; queuing
    // it here would start a second, concurrent turn on the same actor.
    if (cell.running) return;
    if (this.ready.has(cell)) return;
    this.ready.add(cell);
    this._schedule();
  }

  _schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    setImmediate(() => this._tick());
  }

  _tick() {
    this._scheduled = false;
    if (this._stopped) return;
    this.ticks += 1;

    const batch = [];
    for (const cell of this.ready) {
      batch.push(cell);
      if (batch.length >= this.cellsPerTurn) break;
    }
    const running = [];
    for (const cell of batch) {
      this.ready.delete(cell);
      if (cell.stopped) continue;
      this.turns += 1;
      running.push(
        cell._runTurn(this.messagesPerTurn).catch((err) => {
          if (this.onError) this.onError(err, cell);
        }),
      );
    }
    this._inflight = Promise.allSettled(running);

    if (this.ready.size > 0) this._schedule();
  }

  /**
   * Wait until every ready actor has drained its current backlog.
   *
   * Bounded when `timeoutMs > 0`: an actor stuck in a handler that never
   * resolves (a hung I/O call, an endless loop with awaits) would otherwise
   * make `system.stop()` — and therefore process shutdown — hang forever.
   *
   * @returns {Promise<{drained:boolean, timedOut:boolean}>}
   */
  async drain(timeoutMs = 0) {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const bounded = async (promise) => {
      if (deadline === 0) return promise;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return 'timeout';
      return Promise.race([
        promise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), remaining);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    };

    while (this.ready.size > 0 || this._scheduled) {
      if ((await bounded(this._inflight)) === 'timeout') return { drained: false, timedOut: true };
      if (!this._scheduled && this.ready.size > 0) this._schedule();
      await new Promise((resolve) => setImmediate(resolve));
    }
    if ((await bounded(this._inflight)) === 'timeout') return { drained: false, timedOut: true };
    return { drained: true, timedOut: false };
  }

  stop() {
    this._stopped = true;
    this.ready.clear();
  }
}

module.exports = InlineScheduler;
module.exports.defaultMessagesPerTurn = config.actor ? 16 : 16;
