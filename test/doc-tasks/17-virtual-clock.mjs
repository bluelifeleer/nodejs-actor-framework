/**
 * 任务脚本 ④：只看 [17 测试](../../docs/guide/17-testing.md) 就能跑通的虚拟时钟测试。
 *
 * 断言：虚拟时间前进 N 毫秒只花极少真实时间；定时器按顺序触发；真实时间不受影响。
 */
import assert from 'node:assert';

const repo = `file://${process.cwd()}/`;
const { createVirtualClock } = await import(`${repo}packages/testkit/src/index.ts`);

// 定时器挂在 `virtual.clock` 上（内核的定时器都可以改走它：createSystem({ clock: virtual.clock })）
const virtual = createVirtualClock({ start: 1_000_000 });
const fired = [];
virtual.clock.setTimeout(() => fired.push(virtual.now()), 30_000);
assert.deepStrictEqual(fired, [], '还没到点，不该触发');

const realStart = Date.now();
const count = await virtual.advance(30_000);
assert.strictEqual(count, 1, '到点应当触发一个定时器');
assert.deepStrictEqual(fired, [1_030_000], '触发时虚拟时间就是到期时刻');
assert.strictEqual(virtual.now(), 1_030_000);
assert.ok(Date.now() - realStart < 5_000, `真实耗时必须接近 0（实测 ${String(Date.now() - realStart)}ms）`);
assert.strictEqual(virtual.pending(), 0, '没有遗留定时器');

console.log('task-virtual-clock-ok');
