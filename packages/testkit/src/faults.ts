/**
 * 故障注入：按次数/按消息让 Actor **失败、变慢、丢消息**。
 *
 * 这些都是"生产里会发生、但很难复现"的情况：下游偶发 500、某个依赖变慢、消息石沉大海。
 * 把它们变成测试里的显式声明，就不用靠"手改代码再跑一遍"。
 *
 * 用法：
 *   const faults = createFaultInjector();
 *   faults.fail({ times: 2 });            // 前两次调用抛错（触发监督/重启路径）
 *   faults.delay({ ms: 500, match: (m) => m.type === 'slow' });
 *   const ref = await system.spawn(faults.wrap(definition), { id: 'a' });
 *
 * 延迟走 `ctx.sleep()`——注入虚拟时钟后，延迟是**瞬时**推进的（不用真等）。
 */

export interface FaultMatch {
  (message: unknown): boolean;
}

export interface FaultRule {
  kind: 'fail' | 'delay' | 'drop';
  /** 命中多少次（默认 1）。 */
  times: number;
  /** 从第几次命中开始生效（默认 1）。 */
  from: number;
  match: FaultMatch | undefined;
  error: Error | undefined;
  ms: number;
  hits: number;
}

export interface Faults {
  fail(options?: { times?: number; from?: number; match?: FaultMatch; error?: Error }): Faults;
  delay(options: { ms: number; times?: number; from?: number; match?: FaultMatch }): Faults;
  /**
   * 让这条消息被**忽略**：不执行原 handler，也不产生回复（调用方拿到 `undefined`）。
   *
   * 注意它**不是**"石沉大海"：内核的 `ask` 一定会为一次投递等一个回复，定义层没办法"完全不回音"。
   * 要模拟"调用方超时"，用 `delay({ ms: 超过超时时间 })`——超时是调用方的事，Actor 那边只是慢。
   * （第一版 `drop` 返回一个永不 settle 的 Promise，结果把 Actor **永久卡住**：连 `system.stop()`
   * 都收不了尾。故障注入不该制造无法恢复的状态。）
   */
  drop(options?: { times?: number; from?: number; match?: FaultMatch }): Faults;
  wrap<T extends Record<string, unknown>>(definition: T): T;
  /** 每条规则的命中次数（诊断用）。 */
  rules(): readonly { kind: string; hits: number; times: number }[];
  /** 清空规则（用例之间复用同一个注入器时用）。 */
  reset(): void;
}

export function createFaultInjector(): Faults {
  const rules: FaultRule[] = [];

  const api: Faults = {
    fail(options = {}) {
      rules.push({
        kind: 'fail',
        times: options.times ?? 1,
        from: options.from ?? 1,
        match: options.match,
        error: options.error ?? new Error('注入的故障（fault injection）'),
        ms: 0,
        hits: 0,
      });
      return api;
    },
    delay(options) {
      if (!Number.isFinite(options.ms) || options.ms < 0) throw new TypeError('faults.delay() 需要非负的 ms');
      rules.push({
        kind: 'delay',
        times: options.times ?? 1,
        from: options.from ?? 1,
        match: options.match,
        error: undefined,
        ms: options.ms,
        hits: 0,
      });
      return api;
    },
    drop(options = {}) {
      rules.push({
        kind: 'drop',
        times: options.times ?? 1,
        from: options.from ?? 1,
        match: options.match,
        error: undefined,
        ms: 0,
        hits: 0,
      });
      return api;
    },
    wrap(definition) {
      const originalReceive = definition.receive as
        | ((msg: unknown, ctx: { sleep(ms: number): Promise<void> }) => unknown)
        | undefined;
      if (typeof originalReceive !== 'function') {
        throw new TypeError('createFaultInjector().wrap() 需要一个带 receive() 的 Actor 定义');
      }
      const wrapped: Record<string, unknown> = { ...definition };
      wrapped.receive = async function receive(this: unknown, msg: unknown, ctx: { sleep(ms: number): Promise<void> }) {
        for (const rule of rules) {
          if (rule.match !== undefined && !rule.match(msg)) continue;
          if (rule.hits + 1 < rule.from) {
            rule.hits += 1; // 还没轮到它生效，但要计入"第几次命中"
            continue;
          }
          if (rule.hits - (rule.from - 1) >= rule.times) continue; // 次数用完了
          rule.hits += 1;
          if (rule.kind === 'fail') throw rule.error as Error;
          if (rule.kind === 'delay') await ctx.sleep(rule.ms);
          if (rule.kind === 'drop') return undefined; // 忽略这条消息：不执行 handler、不产生回复
        }
        return originalReceive.call(this, msg, ctx);
      };
      return wrapped as never;
    },
    rules: () => rules.map((rule) => ({ kind: rule.kind, hits: rule.hits, times: rule.times })),
    reset: () => {
      rules.length = 0;
    },
  };
  return api;
}
