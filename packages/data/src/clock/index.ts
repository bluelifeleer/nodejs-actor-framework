/**
 * 数据层的时钟接口（结构型，不 import 内核——边界规则见 docs/design/m3-data-evolution.md §2.6）。
 *
 * 为什么需要：投递器与投影的轮询以前写死 `setInterval`，于是"跑一轮"在测试里必须真等
 * （内核那时也确实没有可注入定时器，见 M3 文档 §9.3 的如实记录）。现在时钟可以注入，
 * 测试用 `@actor/testkit` 的虚拟时钟就能把轮询瞬时推进。
 */

export interface TimerHandle {
  readonly id: number;
}

export interface DataClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | null | undefined): void;
}

/** 默认实现：真实定时器（生产路径不变）。 */
export function createDataClock(): DataClock {
  let seq = 0;
  const handles = new Map<number, NodeJS.Timeout>();
  return {
    now: () => Date.now(),
    setTimeout(callback, ms) {
      const id = (seq += 1);
      const timer = setTimeout(() => {
        handles.delete(id);
        callback();
      }, Math.max(0, ms));
      if (typeof timer.unref === 'function') timer.unref();
      handles.set(id, timer);
      return { id };
    },
    clearTimeout(handle) {
      if (handle === null || handle === undefined) return;
      const timer = handles.get(handle.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        handles.delete(handle.id);
      }
    },
    setInterval(callback, ms) {
      const id = (seq += 1);
      const timer = setInterval(callback, Math.max(1, ms));
      if (typeof timer.unref === 'function') timer.unref();
      handles.set(id, timer);
      return { id };
    },
    clearInterval(handle) {
      if (handle === null || handle === undefined) return;
      const timer = handles.get(handle.id);
      if (timer !== undefined) {
        clearInterval(timer);
        handles.delete(handle.id);
      }
    },
  };
}
