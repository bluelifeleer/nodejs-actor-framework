/**
 * 虚拟时钟：让"等一小时"在 0 真实毫秒内过去，而且**顺序确定**。
 *
 * 用法（配 `createSystem({ clock })`）：
 *
 *   const vc = createVirtualClock();
 *   const system = createSystem({ clock: vc.clock });
 *   const pending = ref.ask('hi', 1000);   // 超时 1000ms
 *   await vc.advance(1000);                // 立刻触发（真实时间几乎没走）
 *   await assert.rejects(pending, AskTimeoutError);
 *
 * 两条刻意的语义：
 *   - **到期时间相同**的定时器按**注册顺序**触发（确定性，不靠 sleep 抢）；
 *   - `advance()` 会推动"新排上的定时器"：一个回调里再 `setTimeout` 的，只要没超过目标时间就会
 *     在同一轮里继续跑；这既是能力也是陷阱（写错会造成无限自调度），所以有步数上限并**明确报错**，
 *     而不是把测试挂死。
 *
 * 边界：虚拟时钟接管的是**定时器与 now()**。真实网络 I/O（socket 读写、跨进程调用）仍然需要真实
 * 时间——集群/网关里的连接超时与心跳保持真实时钟（见 docs/design/m5-cli-and-testkit.md §6）。
 */

/** 与内核 `Clock` 同形（内核是 CJS，这里是 ESM，所以结构一致而不是类型导入）。 */
export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number, options?: { unref?: boolean }): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
  setInterval(callback: () => void, ms: number, options?: { unref?: boolean }): TimerHandle;
  clearInterval(handle: TimerHandle | null | undefined): void;
}

interface Entry {
  id: number;
  due: number;
  seq: number;
  callback: () => void;
  intervalMs: number | null;
}

export interface VirtualClock {
  /** 注入 `createSystem({ clock })` 的那个对象。 */
  clock: Clock;
  /** 推进虚拟时间；返回实际触发过的定时器数量。 */
  advance(ms: number): Promise<number>;
  /** 推进到绝对时间点。 */
  advanceTo(time: number): Promise<number>;
  /** 当前虚拟时间。 */
  now(): number;
  /** 还没触发的定时器数量（诊断用）。 */
  pending(): number;
  /** 把**所有**已排期的定时器都跑掉（周期定时器会跑 `maxSteps` 轮，超出即报错）。 */
  runAll(options?: { maxSteps?: number }): Promise<number>;
  /**
   * 让**真实的任务队列**先跑一轮（microtask + 若干次 setImmediate）。
   *
   * 为什么必须有它：虚拟时钟只接管定时器，**消息投递仍然走内核真实的调度器**。
   * 所以"发消息 → Actor 开始处理 → 它内部排了一个定时器"这条链要先把真实队列放行，
   * 之后 `advance()` 才有东西可推进。不 drain 就 advance，会看到"什么都没发生"——
   * 这不是 bug，是虚拟时间与真实调度的交界（见 docs/guide/06-testing.md）。
   */
  drain(turns?: number): Promise<void>;
}

export interface VirtualClockOptions {
  /** 起始时间（默认 0）。 */
  start?: number;
  /** 单次 advance/runAll 里最多触发多少个定时器（防"无限自调度"挂死测试）。 */
  maxSteps?: number;
  /**
   * 每次触发定时器之后，让**真实任务队列**跑几轮（默认 3）。
   *
   * 为什么需要：虚拟时钟只管定时器，Actor 的续体、消息投递仍走内核真实的调度器。
   * 回调返回后如果立刻推进下一个定时器，上一次的续体可能还没登记它要排的东西
   * （实测：`advance(1000)` 一把推完时，最后那次续体要等下一轮真实任务才跑）。
   */
  flushTurns?: number;
}

export function createVirtualClock(options: VirtualClockOptions = {}): VirtualClock {
  let now = options.start ?? 0;
  let seq = 0;
  let nextId = 1;
  const entries = new Map<number, Entry>();

  const schedule = (callback: () => void, ms: number, intervalMs: number | null): TimerHandle => {
    const id = nextId;
    nextId += 1;
    seq += 1;
    entries.set(id, { id, due: now + Math.max(0, ms), seq, callback, intervalMs });
    return { id };
  };
  const cancel = (handle: TimerHandle | null | undefined): void => {
    if (handle === null || handle === undefined) return;
    entries.delete(handle.id);
  };

  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, ms) => schedule(callback, ms, null),
    clearTimeout: cancel,
    setInterval: (callback, ms) => schedule(callback, Math.max(1, ms), Math.max(1, ms)),
    clearInterval: cancel,
  };

  /** 取出下一个到期的定时器（到期时间优先，其次注册顺序）——确定性来自这里。 */
  const nextDue = (): Entry | null => {
    let best: Entry | null = null;
    for (const entry of entries.values()) {
      if (best === null || entry.due < best.due || (entry.due === best.due && entry.seq < best.seq)) best = entry;
    }
    return best;
  };

  const runUntil = async (target: number, maxSteps: number): Promise<number> => {
    let fired = 0;
    for (;;) {
      const entry = nextDue();
      if (entry === null || entry.due > target) break;
      if (fired >= maxSteps) {
        throw new Error(
          `虚拟时钟在一次推进里触发了 ${fired} 个定时器仍未停下来（上限 ${maxSteps}）：` +
            '多半是有定时器在自己回调里无限重排（检查 interval 的清理，或调大 maxSteps）',
        );
      }
      // 间隔定时器：先重排下一次，再触发（与真实 setInterval 一致）
      if (entry.intervalMs !== null) {
        entries.set(entry.id, { ...entry, due: entry.due + entry.intervalMs, seq: (seq += 1) });
      } else {
        entries.delete(entry.id);
      }
      now = Math.max(now, entry.due);
      fired += 1;
      entry.callback();
      // 让回调里的 await（微任务）与真实调度器都往前走几轮，再继续推进：
      // 否则"回调里 await 之后再排定时器"会被漏掉（见 flushTurns 的注释）
      for (let turn = 0; turn < flushTurns; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    now = Math.max(now, target);
    return fired;
  };

  const maxStepsDefault = options.maxSteps ?? 10_000;
  const flushTurns = Math.max(1, options.flushTurns ?? 3);

  return {
    clock,
    now: () => now,
    pending: () => entries.size,
    drain: async (turns = 8) => {
      for (let index = 0; index < Math.max(1, turns); index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    advance: (ms) => runUntil(now + Math.max(0, ms), maxStepsDefault),
    advanceTo: (time) => runUntil(Math.max(now, time), maxStepsDefault),
    runAll: async (runOptions = {}) => {
      const maxSteps = runOptions.maxSteps ?? maxStepsDefault;
      let total = 0;
      for (;;) {
        const entry = nextDue();
        if (entry === null) break;
        // 周期定时器永远"还有下一个"，所以用 maxSteps 作为停止条件
        const fired = await runUntil(entry.due, maxSteps - total);
        total += fired;
        if (total >= maxSteps) {
          throw new Error(`runAll 达到上限 ${maxSteps}：仍有周期定时器在排期（这是预期的，请用 advance）`);
        }
        if (nextDue() === null) break;
        // 只剩周期定时器：把它推进到"下一个到期时间"（避免死循环）
        if (entries.size > 0 && nextDue()!.due === entry.due) {
          now += 1;
        }
      }
      return total;
    },
  };
}
