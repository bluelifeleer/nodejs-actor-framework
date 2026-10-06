/**
 * 可注入时钟（M5 第 3 步 / M0.2 的定时器原语）。
 *
 * 为什么需要它：测试"等 1 小时的定时逻辑"不该真的等 1 小时。把**时间与定时器**收敛到一个接缝上，
 * 测试就能注入虚拟时钟，让 1 小时在 0 真实毫秒内过去，并且**顺序确定**（不靠 sleep 抢时序）。
 *
 * 范围（刻意的，不是偷懒）：时钟接管**纯逻辑定时**——超时、限流、TTL、轮询、延迟。
 * **不接管网络 I/O 的等待**：真实 socket 的读写必须配真实时间，所以集群/网关里的定时器
 * （连接超时、gossip 心跳）保持真实时钟。混用会得到"虚拟时钟推不动真实网络"的困惑，
 * 与其假装统一，不如把边界写清楚（见 docs/design/m5-cli-and-testkit.md §6）。
 */

interface TimerHandle {
  /** 便于诊断；虚拟时钟会给它编号。 */
  readonly id: number;
}

interface Clock {
  /** 当前时间（毫秒）。业务逻辑判断"过了多久"必须用它，不要直接 `Date.now()`。 */
  now(): number;
  setTimeout(callback: () => void, ms: number, options?: { unref?: boolean }): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
  setInterval(callback: () => void, ms: number, options?: { unref?: boolean }): TimerHandle;
  clearInterval(handle: TimerHandle | null | undefined): void;
}

/**
 * 真实时钟：包装全局定时器。
 *
 * `unref` 透传是必要的：内核里有的定时器**刻意不钉住进程**（例如 `ask` 的超时、轮询）。
 * 注意它的后果——如果进程里没有别的待处理工作，unref 的定时器不会触发，进程会直接退出
 * （`docs/guide/06-testing.md` 里记了这条边界）。
 */
function createRealClock(): Clock {
  let seq = 0;
  const handles = new Map<number, NodeJS.Timeout>();
  return {
    now: () => Date.now(),
    setTimeout(callback, ms, options = {}) {
      const id = (seq += 1);
      const timer = setTimeout(() => {
        handles.delete(id);
        callback();
      }, Math.max(0, ms));
      if (options.unref === true && typeof timer.unref === 'function') timer.unref();
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
    setInterval(callback, ms, options = {}) {
      const id = (seq += 1);
      const timer = setInterval(callback, Math.max(1, ms));
      if (options.unref === true && typeof timer.unref === 'function') timer.unref();
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

/** 解析 `createSystem({ clock })`：没给就用真实时钟。 */
function resolveClock(value: unknown): Clock {
  if (value === undefined || value === null) return createRealClock();
  const candidate = value as Partial<Clock>;
  for (const method of ['now', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const) {
    if (typeof candidate[method] !== 'function') {
      throw new TypeError(
        `createSystem({ clock }) 必须是完整实现 Clock 的对象：缺少 ${method}()（虚拟时钟用 @actor/testkit 的 createVirtualClock）`,
      );
    }
  }
  return candidate as Clock;
}

module.exports = { createRealClock, resolveClock };
