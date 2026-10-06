import { test } from 'node:test';
import assert from 'node:assert';

import { createVirtualClock } from '../src/index.ts';

test('virtual clock: 到期时间优先，同一时间按注册顺序（确定性，不靠 sleep 抢）', async () => {
  const vc = createVirtualClock();
  const order: string[] = [];
  vc.clock.setTimeout(() => order.push('late@100'), 100);
  vc.clock.setTimeout(() => order.push('first@50'), 50);
  vc.clock.setTimeout(() => order.push('second@50'), 50);
  vc.clock.setTimeout(() => order.push('zero@0'), 0);

  const fired = await vc.advance(100);
  assert.deepStrictEqual(order, ['zero@0', 'first@50', 'second@50', 'late@100']);
  assert.strictEqual(fired, 4);
  assert.strictEqual(vc.now(), 100, '推进后 now() 到目标时间');
  assert.strictEqual(vc.pending(), 0);
});

test('virtual clock: 回调里再排定时器会被同一轮推进接着跑', async () => {
  const vc = createVirtualClock();
  const order: string[] = [];
  vc.clock.setTimeout(() => {
    order.push('outer');
    vc.clock.setTimeout(() => order.push('inner'), 10);
  }, 5);

  assert.strictEqual(await vc.advance(20), 2);
  assert.deepStrictEqual(order, ['outer', 'inner']);

  // 回调里 await 之后再排：也必须被接住（这也是"推进前先让微任务跑完"的原因）
  const vc2 = createVirtualClock();
  const seen: string[] = [];
  vc2.clock.setTimeout(async () => {
    await Promise.resolve();
    seen.push('after-await');
    vc2.clock.setTimeout(() => seen.push('scheduled-later'), 1);
  }, 1);
  assert.strictEqual(await vc2.advance(10), 2);
  assert.deepStrictEqual(seen, ['after-await', 'scheduled-later']);
});

test('virtual clock: interval 按周期触发；clearInterval 之后不再触发', async () => {
  const vc = createVirtualClock();
  const ticks: number[] = [];
  const handle = vc.clock.setInterval(() => ticks.push(vc.now()), 100);

  await vc.advance(350);
  assert.deepStrictEqual(ticks, [100, 200, 300], '350ms 内触发 3 次（不包含 400）');

  vc.clock.clearInterval(handle);
  await vc.advance(1000);
  assert.deepStrictEqual(ticks, [100, 200, 300], '清掉之后不再触发');
  assert.strictEqual(vc.pending(), 0);
});

test('virtual clock: clearTimeout / advance(0) / advanceTo / 未到期不触发', async () => {
  const vc = createVirtualClock({ start: 1000 });
  assert.strictEqual(vc.now(), 1000);

  let fired = 0;
  const cancelled = vc.clock.setTimeout(() => (fired += 1), 50);
  vc.clock.clearTimeout(cancelled);
  assert.strictEqual(await vc.advance(100), 0, '被取消的不触发');

  vc.clock.setTimeout(() => (fired += 1), 10); // 前面 advance(100) 之后 now = 1100
  assert.strictEqual(await vc.advance(0), 0, 'advance(0) 不推进时间');
  assert.strictEqual(vc.pending(), 1);

  assert.strictEqual(await vc.advanceTo(1110), 1);
  assert.strictEqual(fired, 1);
  assert.strictEqual(vc.now(), 1110);
  assert.strictEqual(await vc.advanceTo(500), 0, '往过去推进没有意义，也不会倒退');
  assert.strictEqual(vc.now(), 1110);
});

test('virtual clock: 无限自调度不会把测试挂死，而是明确报错', async () => {
  const vc = createVirtualClock({ maxSteps: 50 });
  const spin = () => {
    vc.clock.setTimeout(spin, 1);
  };
  spin();
  await assert.rejects(() => vc.advance(10_000), /仍未停下来（上限 50）.*无限重排/s);
});

test('virtual clock: runAll 会把非周期定时器全部跑完（周期定时器要报错提醒用 advance）', async () => {
  const vc = createVirtualClock();
  let count = 0;
  vc.clock.setTimeout(() => {
    count += 1;
    vc.clock.setTimeout(() => (count += 1), 5);
  }, 5);
  assert.strictEqual(await vc.runAll(), 2);
  assert.strictEqual(count, 2);

  const busy = createVirtualClock({ maxSteps: 20 });
  busy.clock.setInterval(() => undefined, 1);
  await assert.rejects(() => busy.runAll(), /runAll 达到上限/);
});
