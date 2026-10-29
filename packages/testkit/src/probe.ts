/**
 * 探针：包在 Actor 定义外面，记录**每条进入的消息与结果**。
 *
 * 为什么不用 mock：内核里 Actor 的"可观察行为"就是"收到了什么、回了什么、抛了什么"。
 * 把这三件事记下来，测试里就能直接断言，而不用去戳内部字段（那样重构一下就红）。
 *
 * 用法：
 *   const probe = createProbe();
 *   const ref = await system.spawn(probe.wrap({ preStart() {...}, receive(msg) {...} }), { id: 'a' });
 *   await ref.ask(...);
 *   assert.deepStrictEqual(probe.types(), ['add', 'get']);
 */

export interface ProbeCall {
  /** 第几条（从 1 开始）。 */
  index: number;
  /** 消息类型（`msg.type`，没有就是 undefined）。 */
  type: string | undefined;
  /** 原始消息（原样保存，不做拷贝——测试里想看什么就看什么）。 */
  message: unknown;
  /** 处理耗时（毫秒；注入虚拟时钟时是虚拟时长）。 */
  durationMs: number;
  /** 返回给调用方的值（抛错时为 undefined）。 */
  reply?: unknown;
  /** 抛出的错误（成功时为 undefined）。 */
  error?: unknown;
  /** 何时处理（系统时钟）。 */
  at: number;
}

export interface Probe {
  /** 包装一个 Actor 定义（保留 preStart / postStop / applyEvent 等原有回调）。 */
  wrap<T extends Record<string, unknown>>(definition: T): T;
  /** 记录下来的调用（按顺序）。 */
  calls(): readonly ProbeCall[];
  /** 只取消息类型序列。 */
  types(): (string | undefined)[];
  /** 某个类型出现了几次。 */
  countOf(type: string): number;
  /** 最后一次抛错（没有就 undefined）。 */
  lastError(): unknown;
  /** 清空记录（用例之间复用同一个探针时用）。 */
  reset(): void;
  /** 有多少次调用抛了错。 */
  failures(): number;
}

export function createProbe(): Probe {
  const calls: ProbeCall[] = [];

  return {
    wrap(definition) {
      const originalReceive = definition.receive as
        | ((msg: unknown, ctx: { clock: { now(): number } }) => unknown)
        | undefined;
      if (typeof originalReceive !== 'function') {
        throw new TypeError('createProbe().wrap() 需要一个带 receive() 的 Actor 定义');
      }
      // 不能只 spread：class 的生命周期方法在 prototype 上，spread 会全部丢掉
      const wrapped: Record<string, unknown> = Object.create(
        Object.getPrototypeOf(definition),
        Object.getOwnPropertyDescriptors(definition),
      ) as Record<string, unknown>;
      wrapped.receive = async function receive(this: unknown, msg: unknown, ctx: { clock: { now(): number } }) {
        const index = calls.length + 1;
        const type = msg !== null && typeof msg === 'object' ? (msg as { type?: string }).type : undefined;
        const startedAt = ctx.clock.now();
        const record: ProbeCall = {
          index,
          type: typeof type === 'string' ? type : undefined,
          message: msg,
          durationMs: 0,
          at: startedAt,
        };
        calls.push(record);
        try {
          const reply = await originalReceive.call(this, msg, ctx);
          record.reply = reply;
          return reply;
        } catch (err) {
          record.error = err;
          throw err;
        } finally {
          record.durationMs = ctx.clock.now() - startedAt;
        }
      };
      return wrapped as never;
    },
    calls: () => calls,
    types: () => calls.map((call) => call.type),
    countOf: (type) => calls.filter((call) => call.type === type).length,
    lastError: () => [...calls].reverse().find((call) => call.error !== undefined)?.error,
    reset: () => {
      calls.length = 0;
    },
    failures: () => calls.filter((call) => call.error !== undefined).length,
  };
}
