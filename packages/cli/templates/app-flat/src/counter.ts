/**
 * Actor 的两种形态：
 *
 * - **handler bag**（这里用的）：`preStart` / `receive` / `postStop`，能配合
 *   `mode: 'snapshot'` / `'events'` 持久化。
 * - **普通类**：可以直接用依赖注入（构造函数收 deps），但**不能开 snapshot/events 持久化**——
 *   框架在启动期就会拒绝（类实例的状态无法被正确恢复），`@actor/app` 里有明确报错。
 *
 * **持久化的契约是 `this.state`**：快照模式存的就是这个属性，恢复时也写回它。
 * 状态放在别的字段（比如 `this.count`）看起来能跑，但**重启后会归零**——骨架自带的测试
 * 就有一条"重启后状态还在"的用例专门盯这个。
 */
export const Counter = {
  preStart(this: { state: { count: number } }) {
    this.state = { count: 0 };
  },

  async receive(
    this: { state: { count: number } },
    msg: { type: 'add'; by?: number } | { type: 'get' },
    ctx: { saveSnapshot(): Promise<void> },
  ) {
    if (msg.type === 'add') {
      this.state.count += msg.by ?? 1;
      await ctx.saveSnapshot();
    }
    return this.state.count;
  },
};
