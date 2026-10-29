import { test } from 'node:test';
import assert from 'node:assert';

import { Actor, createSystem } from 'nodejs-actor-framework';

import { createFaultInjector, createProbe, createVirtualClock } from '../src/index.ts';

test('probe: 记录消息、回复、耗时与抛错（断言可观察行为，不戳内部字段）', async () => {
  const vc = createVirtualClock();
  const system = createSystem({ logger: false, clock: vc.clock });
  try {
    const probe = createProbe();
    const ref = await system.spawn(
      probe.wrap({
        preStart() {
          this.state = { total: 0 };
        },
        async receive(msg: { type: string; by?: number }, ctx: { sleep(ms: number): Promise<void> }) {
          if (msg.type === 'slow') await ctx.sleep(50);
          if (msg.type === 'boom') throw new Error('故意的');
          this.state.total += msg.by ?? 1;
          return this.state.total;
        },
      }),
      { id: 'probed' },
    );

    assert.strictEqual(await ref.ask({ type: 'add', by: 2 }), 2);
    const slow = ref.ask({ type: 'slow' });
    await vc.drain();
    await vc.advance(50);
    await slow;
    await assert.rejects(() => ref.ask({ type: 'boom' }), /故意的/);

    assert.deepStrictEqual(probe.types(), ['add', 'slow', 'boom']);
    assert.strictEqual(probe.countOf('slow'), 1);
    assert.strictEqual(probe.failures(), 1);
    assert.match(String((probe.lastError() as Error).message), /故意的/);
    assert.strictEqual(probe.calls()[0].reply, 2);
    assert.strictEqual(probe.calls()[1].durationMs, 50, '耗时按系统时钟（虚拟）计算');
    probe.reset();
    assert.strictEqual(probe.calls().length, 0);
  } finally {
    await vc.advance(1000);
    await system.stop();
  }
});

test('faults: 前两次失败、之后恢复（走的是真实的监督/重启路径）', async () => {
  const system = createSystem({ logger: false });
  try {
    const faults = createFaultInjector();
    faults.fail({ times: 2, error: new Error('下游 500') });
    const ref = await system.spawn(
      faults.wrap({
        preStart() {
          this.state = { ok: 0 };
        },
        receive() {
          this.state.ok += 1;
          return this.state.ok;
        },
      }),
      { id: 'flaky', supervision: { strategy: 'one_for_one', maxRestarts: 5, withinSeconds: 60 } },
    );

    // 前两次抛出注入的错误；Actor 会按监督策略重启，状态归零，第三次成功
    await assert.rejects(() => ref.ask('a'), /下游 500/);
    await assert.rejects(() => ref.ask('b'), /下游 500/);
    assert.strictEqual(await ref.ask('c'), 1, '第三次恢复正常（重启后计数从头开始）');
    assert.deepStrictEqual(
      faults.rules().map((rule) => rule.hits),
      [2],
      '规则命中次数可见',
    );
  } finally {
    await system.stop();
  }
});

test('faults: 只对匹配的消息生效（match 谓词），延迟走虚拟时钟', async () => {
  const vc = createVirtualClock();
  const system = createSystem({ logger: false, clock: vc.clock });
  try {
    const faults = createFaultInjector();
    faults.delay({ ms: 100, match: (msg) => (msg as { type?: string }).type === 'slow' });
    faults.fail({ match: (msg) => (msg as { type?: string }).type === 'bad' });
    const ref = await system.spawn(faults.wrap({ preStart() {}, receive: () => 'served' }), { id: 'selective' });

    assert.strictEqual(await ref.ask({ type: 'fast' }), 'served', '不匹配的消息不受影响');
    await assert.rejects(() => ref.ask({ type: 'bad' }), /注入的故障/);

    const slow = ref.ask({ type: 'slow' });
    await vc.drain();
    await vc.advance(100);
    assert.strictEqual(await slow, 'served', '延迟到点后正常服务');
  } finally {
    await vc.advance(1000);
    await system.stop();
  }
});

test('faults: drop 忽略这条消息（不执行 handler、不产生回复）；"调用方超时"用 delay 模拟', async () => {
  const vc = createVirtualClock();
  const system = createSystem({ logger: false, clock: vc.clock });
  try {
    const faults = createFaultInjector();
    faults.drop({ times: 1 });
    const probe = createProbe();
    const ref = await system.spawn(
      faults.wrap(
        probe.wrap({
          preStart() {
            this.state = { handled: 0 };
          },
          receive() {
            this.state.handled += 1;
            return this.state.handled;
          },
        }),
      ),
      { id: 'dropper' },
    );

    assert.strictEqual(await ref.ask('first'), undefined, '被忽略的消息没有回复');
    assert.strictEqual(probe.calls().length, 0, '被忽略的消息不该进入 handler（探针也没记录）');
    assert.strictEqual(await ref.ask('second'), 1, '只忽略一次，之后正常');

    // "石沉大海"的正确模拟：延迟超过调用方超时时间 → 调用方拿到 AskTimeoutError，
    // 而 Actor 只是慢（推进剩余时间后它照样把活干完，不会留下无法恢复的状态）
    const slowFaults = createFaultInjector();
    slowFaults.delay({ ms: 10_000 });
    const slowRef = await system.spawn(slowFaults.wrap({ preStart() {}, receive: () => 'late' }), { id: 'sunk' });
    const sunk = slowRef.ask('go', 500);
    const timedOut = assert.rejects(() => sunk, (err: unknown) => (err as Error).name === 'AskTimeoutError');
    await vc.drain();
    await vc.advance(500);
    await timedOut;
    await vc.advance(10_000); // 让 Actor 把那条慢消息做完，系统才能干净停止
  } finally {
    await vc.advance(60_000);
    await system.stop();
  }
});

test('probe/faults.wrap: 必须保留 class 原型上的生命周期钩子（回归：preStart 被丢掉）', async () => {
  class Counter extends Actor {
    preStart() {
      this.state = { n: 0 };
    }
    async receive() {
      this.state.n += 1;
      return this.state.n;
    }
  }
  const vc = createVirtualClock();
  const system = createSystem({ logger: false, clock: vc.clock });
  try {
    const wrappers = [
      ['probe', createProbe().wrap],
      ['faults', createFaultInjector().wrap],
    ] as const;
    for (const [name, wrap] of wrappers) {
      const ref = await system.spawn(wrap(new Counter()), { id: `wrap-${name}` });
      assert.strictEqual(await ref.ask('inc'), 1, 'preStart 必须执行（否则 state.n 是 NaN）');
    }
  } finally {
    await system.stop();
  }
});
