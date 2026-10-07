'use strict';

/**
 * 审计里的"时钟接缝不一致"（审计 F：#5 类）。
 *
 * M5 划定的范围是"**纯逻辑定时**走可注入时钟；网络 I/O 与停机安全边界保持真实时间"。
 * 但有两处属于纯逻辑定时却绕过时钟：
 *   1. `guardian.decide()/checkQuota()` 的**重启强度窗口**（4 个调用点都没传 now）；
 *   2. `obs/alerting.ts` 的**告警评估**（`evaluateOnce(now = Date.now())` + 真 `setInterval`）。
 *
 * 影响：生产（真实时钟）行为正确，但注入了虚拟时钟的测试"推不动"这两处 —— 于是"等 1 小时看看窗口过期"
 * 这类断言只能靠真等，或者写出与生产不一致的期望。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createSystem } = require('../src/index.ts');
const { AlertManager } = require('../src/obs/alerting.ts');

/** 最小虚拟时钟（只实现这套测试用到的部分）。 */
function makeVirtualClock(startMs = 0) {
  let now = startMs;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    async sleep(ms) {
      return new Promise((resolve) => {
        seq += 1;
        timers.set(seq, { at: now + ms, resolve, repeat: null });
      });
    },
    setTimeout(fn, ms) {
      seq += 1;
      const id = seq;
      timers.set(id, { at: now + ms, fn, repeat: null });
      return { id };
    },
    clearTimeout(handle) {
      if (handle) timers.delete(handle.id);
    },
    setInterval(fn, ms) {
      seq += 1;
      const id = seq;
      timers.set(id, { at: now + ms, fn, repeat: ms });
      return { id };
    },
    clearInterval(handle) {
      if (handle) timers.delete(handle.id);
    },
    /** 把时间推进 ms，并触发到期的定时器。 */
    async advance(ms) {
      now += ms;
      let ran = true;
      while (ran) {
        ran = false;
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue;
          ran = true;
          if (timer.repeat === null) timers.delete(id);
          else timer.at = now + timer.repeat;
          if (timer.fn) timer.fn();
          else if (timer.resolve) timer.resolve();
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test('audit/clock: 重启强度窗口必须走可注入时钟（虚拟时间推进后窗口要过期）', async () => {
  const clock = makeVirtualClock(1_000_000);
  const system = createSystem({
    logger: false,
    clock,
    shutdownTimeoutMs: 300,
    supervision: { strategy: 'one_for_one', maxRestarts: 2, withinSeconds: 5 },
  });
  const boom = {
    preStart() {
      this.n = 0;
    },
    receive(m) {
      if (m === 'boom') throw new Error('x');
      return this.n;
    },
  };
  /** 崩到指定次数（重启是异步的，所以要循环等它真的涨上去）。 */
  const crashUntil = async (target) => {
    for (let i = 0; i < 40; i += 1) {
      const ref = system.resolve('a');
      if (ref === null) return system.inspect('a')?.restarts ?? 0;
      await ref.ask('boom', 100).catch(() => null);
      await clock.advance(50);
      const info = system.stopped ? null : system.inspect('a');
      if (info === null) return 0;
      if (info.restarts >= target) return info.restarts;
    }
    return system.inspect('a')?.restarts ?? 0;
  };

  try {
    await system.spawn(boom, { id: 'a' });
    // 先用掉配额：配额 2，所以崩 2 次后仍在运行
    const after = await crashUntil(2);
    assert.ok(after >= 2, `测试前提不成立：只崩了 ${after} 次（需要 ≥2）`);
    assert.strictEqual(system.stopped, false, '用掉配额后系统就停了（测试前提不成立）');

    // 关键断言：把**虚拟时间**推过窗口（withinSeconds=5），配额必须刷新
    await clock.advance(6_000);
    const before = system.inspect('a').restarts;
    const afterAdvance = await crashUntil(before + 2);
    assert.ok(afterAdvance >= before + 1, `推进后没能继续崩溃（restarts ${before} → ${afterAdvance}）`);
    assert.strictEqual(
      system.stopped,
      false,
      '虚拟时间推进 6 秒后配额没有刷新（系统被停）—— 重启窗口在用真实时间，没走注入时钟',
    );
  } finally {
    await system.stop().catch(() => {});
  }
});

test('audit/clock: 告警评估必须能被虚拟时钟推进（intervalMs 不用真等）', async () => {
  const clock = makeVirtualClock(0);
  const manager = new AlertManager({
    clock,
    intervalMs: 1_000,
    source: {
      // 永远"指标很高" → 规则应当 firing
      snapshot: () => ({ families: [], samples: [{ name: 'actor_mailbox_depth_total', value: 999 }] }),
    },
    rules: [{ name: 'Backlog', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 10, forDuration: 0 }],
    notifiers: [],
  });
  try {
    await manager.start();
    const before = manager.evaluations; // start() 会立即评估一次，基准要在它之后取
    await clock.advance(1_100);
    await clock.advance(1_100);
    assert.ok(
      manager.evaluations > before,
      `虚拟时钟推进后告警没有重新评估（evaluations 仍是 ${manager.evaluations}）—— 定时器没走注入时钟`,
    );
  } finally {
    await manager.stop().catch(() => {});
  }
});
