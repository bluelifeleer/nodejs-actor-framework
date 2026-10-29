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

/** 调度器需要从 cell 上看到的字段（ActorCell 满足这个结构）。 */
interface SchedulableCell {
  readonly path?: string;
  stopped: boolean;
  running: boolean;
  _runTurn(messagesPerTurn: number): Promise<void>;
}

interface SchedulerOptions {
  messagesPerTurn?: number;
  cellsPerTurn?: number;
  onError?: ((err: Error, cell: SchedulableCell) => void) | null;
}

/**
 * 公平调度器。
 *
 * 注意 `drain(timeoutMs)` 的超时**刻意用真实时间**（`Date.now()` + `setTimeout`），不走可注入时钟：
 * 它是"停机不能永远挂着"的安全边界，必须在没人推进虚拟时钟时也能触发。这与"网络 I/O 用真实时间"
 * 是同一条边界（见 docs/design/m5-cli-and-testkit.md §6）。
 */
class InlineScheduler {
  readonly messagesPerTurn: number;
  readonly cellsPerTurn: number;
  readonly onError: ((err: Error, cell: SchedulableCell) => void) | null;
  /** 就绪的 cell（按加入顺序）。 */
  readonly ready: Set<SchedulableCell>;
  _scheduled: boolean;
  _inflight: Promise<unknown>;
  /** 所有仍在执行的 turn（跨 tick），`drain()` 必须等它们，而不是只看最近一批。 */
  readonly _pendingTurns: Set<Promise<void>>;
  _stopped: boolean;
  ticks: number;
  turns: number;

  constructor(options: SchedulerOptions = {}) {
    this.messagesPerTurn = options.messagesPerTurn ?? 16;
    this.cellsPerTurn = options.cellsPerTurn ?? 64;
    this.onError = options.onError ?? null;
    this.ready = new Set();
    this._scheduled = false;
    this._inflight = Promise.resolve();
    this._pendingTurns = new Set();
    this._stopped = false;
    this.ticks = 0;
    this.turns = 0;
  }

  get pending(): number {
    return this.ready.size;
  }

  schedule(cell: SchedulableCell): void {
    if (this._stopped || !cell || cell.stopped) return;
    // A cell that is mid-turn will re-schedule itself when it finishes; queuing
    // it here would start a second, concurrent turn on the same actor.
    if (cell.running) return;
    if (this.ready.has(cell)) return;
    this.ready.add(cell);
    this._schedule();
  }

  _schedule(): void {
    if (this._scheduled) return;
    this._scheduled = true;
    setImmediate(() => this._tick());
  }

  _tick(): void {
    this._scheduled = false;
    if (this._stopped) return;
    this.ticks += 1;

    const batch: SchedulableCell[] = [];
    for (const cell of this.ready) {
      batch.push(cell);
      if (batch.length >= this.cellsPerTurn) break;
    }
    const running: Promise<void>[] = [];
    for (const cell of batch) {
      this.ready.delete(cell);
      if (cell.stopped) continue;
      this.turns += 1;
      let tracked!: Promise<void>;
      tracked = cell._runTurn(this.messagesPerTurn)
        .catch((err: Error) => {
          if (this.onError) this.onError(err, cell);
        })
        .finally(() => {
          this._pendingTurns.delete(tracked);
        });
      this._pendingTurns.add(tracked);
      running.push(tracked);
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
   * @returns 是否排空；`timedOut` 为 true 表示有 Actor 卡在处理里（超时后放弃等待）。
   */
  async drain(timeoutMs = 0): Promise<{ drained: boolean; timedOut: boolean }> {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const bounded = async (promise: Promise<unknown>): Promise<unknown> => {
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

    while (this.ready.size > 0 || this._scheduled || this._pendingTurns.size > 0) {
      const inFlight = [...this._pendingTurns];
      if (inFlight.length > 0 && (await bounded(Promise.allSettled(inFlight))) === 'timeout') {
        return { drained: false, timedOut: true };
      }
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
