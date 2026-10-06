import { test } from 'node:test';
import assert from 'node:assert';

import { AskTimeoutError, createSystem } from 'nodejs-actor-framework';

import { createVirtualClock } from '../src/index.ts';

/**
 * 虚拟时钟与内核的配合：**超时、等待、限流**都应当能被"推进时间"确定性地触发，
 * 而不是靠 `sleep` 抢时序。这里的断言里有一条很关键：真实耗时必须极小——
 * 否则"虚拟"就是假的。
 */

test('testkit: ask 超时可以被时钟确定性触发（1000ms 的超时，0 真实毫秒内）', async () => {
  const vc = createVirtualClock();
  const system = createSystem({ logger: false, clock: vc.clock });
  try {
    // 这个 Actor 要"睡" 10 秒才回复：推进 1000ms 时它还没醒，所以 ask 必然超时
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { done: 0 };
        },
        async receive(_msg, ctx) {
          await ctx.sleep(10_000);
          this.state.done += 1;
          return 'finally';
        },
      },
      { id: 'sleeper' },
    );

    const realStart = Date.now();
    const pending = ref.ask('hi', 1000);
    // **先挂上断言处理器再推进时间**：超时是在 `advance()` 里触发的，
    // 如果此刻还没有处理器，Node 会把它当"未处理的拒绝"直接崩掉测试（真踩过）。
    const timeout = assert.rejects(
      () => pending,
      (err: unknown) => {
        assert.ok(err instanceof AskTimeoutError, `期望 AskTimeoutError，实际 ${(err as Error)?.name}`);
        return true;
      },
    );
    await vc.drain(); // 让消息真正投递（消息走真实调度器，定时器才是虚拟的）
    const fired = await vc.advance(1000);
    assert.strictEqual(fired >= 1, true, '推进时至少触发了超时定时器');
    await timeout;
    const realElapsed = Date.now() - realStart;
    assert.ok(realElapsed < 200, `真实耗时应当极小，实际 ${realElapsed}ms`);
    assert.strictEqual(vc.now(), 1000, '虚拟时间推进到了 1000');

    // 超时只是"调用方不再等"，Actor 的活还在虚拟时间里挂着：推进到 10000 它就会做完。
    // 这也解释了一条使用规则——**停系统之前要把还在虚拟等待里的 Actor 推醒**，
    // 否则 `system.stop()` 会一直等那一轮结束（虚拟时间里它永远不会自己醒）。
    await vc.advance(9000);
    assert.strictEqual((await system.cells.get('sleeper').ref.state()).done, 1, 'Actor 最终完成了那次处理');
  } finally {
    await vc.advance(60_000); // 把可能还挂着的虚拟等待推完，stop 才收得干净
    await system.stop();
  }
});

test('testkit: ctx.sleep 由时钟推进（推进到点时 Actor 醒来并回复）', async () => {
  const vc = createVirtualClock();
  const system = createSystem({ logger: false, clock: vc.clock });
  try {
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { woke: 0 };
        },
        async receive(_msg, ctx) {
          await ctx.sleep(5000);
          this.state.woke += 1;
          return `woke@${ctx.clock.now()}`;
        },
      },
      { id: 'waker' },
    );

    const pending = ref.ask('go', 60_000); // 超时给足，让等待由 sleep 决定
    await vc.drain(); // 先让 Actor 开始处理（它才会排下 ctx.sleep 的定时器）
    await vc.advance(5000);
    assert.strictEqual(await pending, 'woke@5000', '推进到 5000ms 时醒来并回复');
  } finally {
    await system.stop();
  }
});

test('testkit: 限流等待也走虚拟时钟（第二秒才有令牌）', async () => {
  const vc = createVirtualClock();
  const system = createSystem({ logger: false, clock: vc.clock });
  try {
    const ref = await system.spawn(
      {
        preStart() {
          this.state = { served: 0 };
        },
        receive() {
          this.state.served += 1;
          return this.state.served;
        },
      },
      { id: 'limited', rateLimit: { capacity: 1, rate: 1 } }, // 每秒 1 个令牌
    );

    assert.strictEqual(await ref.ask('first', 60_000), 1, '第一个立刻拿到令牌');
    const second = ref.ask('second', 60_000);
    await vc.drain(); // 让第二个消息进入 Actor 的限流等待循环
    await vc.advance(1000); // 推进 1 秒：令牌补充
    assert.strictEqual(await second, 2, '补了令牌之后第二个才被处理');
  } finally {
    await vc.advance(60_000); // 同上：先把虚拟等待推完再停
    await system.stop();
  }
});
