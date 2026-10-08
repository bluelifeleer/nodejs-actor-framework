import { test } from 'node:test';
import assert from 'node:assert';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createApp,
  deadLettersPlugin,
  defineApp,
  defineModule,
  type ActorCrashInfo,
  type DeadLetterLike,
} from '../src/index.ts';

/**
 * P1：**错误出口**（`createApp(..., { errors })`）。
 *
 * 这一层要证明四件事（都可证伪）：
 *   ① 内核后台事件（`actor_crash` / `dead_letter` / …）真的能到应用层；
 *   ② 强类型视图（Actor 崩溃 / 死信）字段对得上；`onCrash` 能拿到"声明名"而不是路径；
 *   ③ **钩子抛错不影响应用**（内核照常重启/停机，请求照常返回）；
 *   ④ 不给 `errors` 时行为与从前一致（静默、不装监听）。
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 一直抛错的 Actor（用于制造崩溃与死信）。 */
const alwaysFails = {
  preStart(this: { state: { n: number } }) {
    this.state = { n: 0 };
  },
  receive(this: { state: { n: number } }) {
    this.state.n += 1;
    throw new Error(`boom ${String(this.state.n)}`);
  },
};

const okActor = {
  preStart(this: { state: { hits: number } }) {
    this.state = { hits: 0 };
  },
  receive(this: { state: { hits: number } }, msg: unknown) {
    this.state.hits += 1;
    return { hits: this.state.hits, echo: msg };
  },
};

test('P1: 内核崩溃事件能到应用层，且带上"声明名"（不是只有路径）', async () => {
  const crashes: ActorCrashInfo[] = [];
  const kernelEvents: string[] = [];
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: { Crasher: { definition: alwaysFails, options: { restart: 'restart' } } },
        }),
      ],
    }),
    {
      configDir: null,
      env: {},
      errors: {
        onKernelLog: (info) => void kernelEvents.push(info.event),
        onActorCrash: (info) => void crashes.push(info),
      },
    },
  );
  await app.start();
  try {
    // 崩溃通过 ask 的 reject 传到调用方（这是"同步路径"）；后台事件是"异步路径"
    await assert.rejects(() => app.actor('Crasher').ask({}, 3000), /boom 1/);
    await sleep(150);
  } finally {
    await app.stop();
  }

  assert.ok(crashes.length >= 1, `崩溃必须到应用层：${JSON.stringify(crashes)}`);
  assert.strictEqual(crashes[0]?.name, 'Crasher', '要给声明名（actors 的键），不是只有路径');
  assert.strictEqual(crashes[0]?.path, 'Crasher');
  assert.match(crashes[0]?.error ?? '', /boom 1/);
  assert.ok(kernelEvents.includes('actor_crash'), `内核日志也要透传：${kernelEvents.join(', ')}`);
  // 重启事件也是普通内核日志（同一个出口，不需要第二个钩子）
  assert.ok(kernelEvents.includes('actor_restart'), '重启也要可见');
});

test('P1: Actor 级 onCrash —— 只通知、不干预（内核照常重启，消息照常被处理）', async () => {
  const seen: string[] = [];
  let alive = 0;
  const flakyButRecovering = {
    preStart(this: { state: { n: number } }) {
      this.state = { n: 0 };
      alive += 1;
    },
    receive(this: { state: { n: number } }, msg: { fail?: boolean }) {
      this.state.n += 1;
      if (msg.fail === true && this.state.n === 1) throw new Error('first message always fails');
      return { ok: true, n: this.state.n };
    },
  };
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: {
            Flaky: {
              definition: flakyButRecovering,
              options: { restart: 'restart', retryBackoffMs: 1 },
              onCrash: (info) => {
                seen.push(`${info.name}:${info.error}`);
              },
            },
          },
        }),
      ],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  try {
    await assert.rejects(() => app.actor('Flaky').ask({ fail: true }, 3000), /first message always fails/);
    await sleep(120);
    // 内核已按监督策略重启（onCrash 没插手）：新实例能正常处理消息
    await assert.rejects(() => app.actor('Flaky').ask({ fail: true }, 3000), /first message always fails/);
    await sleep(120);
    const ok = await app.actor('Flaky').ask({}, 3000);
    assert.deepStrictEqual(ok, { ok: true, n: 1 }, '重启后的实例照常工作');
  } finally {
    await app.stop();
  }
  assert.ok(seen.length >= 1, `onCrash 必须被调用：${JSON.stringify(seen)}`);
  assert.match(seen[0] ?? '', /^Flaky:/, '回调里要能看出是哪个 Actor');
  assert.ok(alive >= 2, `内核应当重启过（preStart 次数 ${String(alive)}）—— onCrash 不干预监督`);
});

test('P1: Actor 级 onCrash 在**没配全局 errors** 时也必须触发（否则是静默失效）', async () => {
  const seen: string[] = [];
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: {
            Alone: {
              definition: alwaysFails,
              options: { failure: 'crash', restart: 'restart', retryBackoffMs: 1 },
              onCrash: (info) => void seen.push(info.name),
            },
          },
        }),
      ],
    }),
    { configDir: null, env: {} }, // 刻意不传 errors
  );
  await app.start();
  try {
    await assert.rejects(() => app.actor('Alone').ask({}), /boom 1/);
    await sleep(150);
  } finally {
    await app.stop();
  }
  assert.deepStrictEqual(seen, ['Alone'], '声明了 onCrash 就该被调用，与全局 errors 无关');
});

test('P1: 死信能到应用层，且 app.deadLetters()/clearDeadLetters() 可用', async () => {
  const dead: DeadLetterLike[] = [];
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          // failure: 'retry' = 重试耗尽后**进死信**（不崩 Actor）
          actors: { Sink: { definition: alwaysFails, options: { failure: 'retry', maxRetry: 1, retryBackoffMs: 1 } } },
        }),
      ],
    }),
    { configDir: null, env: {}, errors: { onDeadLetter: (entry) => void dead.push(entry) } },
  );
  await app.start();
  let readable: DeadLetterLike[] = [];
  let cleared = 0;
  try {
    await assert.rejects(() => app.actor('Sink').ask({ x: 1 }, 3000), /boom 2/, '重试耗尽后 ask 必须 reject');
    await sleep(150);
    readable = await app.deadLetters();
    cleared = await app.clearDeadLetters();
  } finally {
    await app.stop();
  }

  assert.strictEqual(dead.length, 1, `钩子应当收到一条死信：${JSON.stringify(dead)}`);
  assert.strictEqual(dead[0]?.path, 'Sink');
  assert.strictEqual(dead[0]?.retryCount, 1, '重试次数要如实带出来');
  assert.match(dead[0]?.error ?? '', /boom 2/);
  assert.ok(dead[0]?.payload !== undefined, '死信要带原始消息（否则没法排查）');
  assert.strictEqual(readable.length, 1, 'app.deadLetters() 要能读到同一条');
  assert.strictEqual(cleared, 1, 'clearDeadLetters() 返回清掉的条数');
  assert.deepStrictEqual(await app.deadLetters(), [], '清空后读回空');
});

test('P1: 钩子抛错不影响应用（内核照常重启、ask 照常有结果）', async () => {
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: {
            Flaky: { definition: alwaysFails, options: { failure: 'crash', restart: 'restart', retryBackoffMs: 1 } },
            Healthy: { definition: okActor },
          },
        }),
      ],
    }),
    {
      configDir: null,
      env: {},
      errors: {
        // 三个钩子全都抛：应用照常工作
        onKernelLog: () => {
          throw new Error('bad logger');
        },
        onActorCrash: () => {
          throw new Error('bad crash hook');
        },
        onDeadLetter: () => {
          throw new Error('bad dead-letter hook');
        },
      },
    },
  );
  await app.start();
  try {
    await assert.rejects(() => app.actor('Flaky').ask({}, 3000), /boom 1/);
    await sleep(120);
    // 关键：坏钩子没有把内核拖下水 —— 健康的 Actor 照常应答、照常能停
    const result = await app.actor('Healthy').ask({ hi: true }, 3000);
    assert.deepStrictEqual(result, { hits: 1, echo: { hi: true } });
  } finally {
    await app.stop();
  }
  assert.ok(true, '停机也走完了（没有因为钩子抛错挂住）');
});

test('P1: 不给 errors 时行为与从前一致（不装内核监听、不转发、死信仍可读）', async () => {
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: { Sink: { definition: alwaysFails, options: { failure: 'retry', maxRetry: 0, retryBackoffMs: 1 } } },
        }),
      ],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  try {
    await assert.rejects(() => app.actor('Sink').ask({}, 3000));
    await sleep(100);
    // 没给钩子也能读死信（读的是内核的内存环，与钩子无关）
    assert.strictEqual((await app.deadLetters()).length, 1);
  } finally {
    await app.stop();
  }
});

test('P1: onSystemFailure —— 顶层 Actor 耗尽重启强度时能收到', async () => {
  const failures: Array<{ error: unknown; path?: string }> = [];
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: { Doomed: { definition: alwaysFails, options: { restart: 'restart' } } },
        }),
      ],
    }),
    {
      configDir: null,
      env: {},
      // 把"重启强度"降到 0：第一次崩溃就升级 → 明确触发 system_failure（而不是靠时间窗口碰运气）
      kernel: { defaults: { supervision: { maxRestarts: 0, withinSeconds: 1 } } },
      errors: { onSystemFailure: (info) => void failures.push(info) },
    },
  );
  await app.start();
  try {
    await assert.rejects(() => app.actor('Doomed').ask({}, 3000));
    // 升级是异步的：给它几个 tick
    for (let index = 0; index < 40 && failures.length === 0; index += 1) await sleep(25);
  } finally {
    await app.stop();
  }
  assert.ok(failures.length >= 1, `耗尽重启强度必须上报 system_failure：${JSON.stringify(failures.map((f) => String(f.error)))}`);
  assert.ok(failures[0]?.error !== undefined, '要带原始错误对象（不是只有字符串）');
  assert.match(String(failures[0]?.error), /could not be restarted/);
  assert.strictEqual(failures[0]?.path, 'Doomed', '要能看出是哪个 Actor');
});

test('P1: 重复 start 不叠加内核监听（同一个 Application 实例）', async () => {
  const events: string[] = [];
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: { Flaky: { definition: alwaysFails, options: { failure: 'crash', restart: 'restart', retryBackoffMs: 1 } } },
        }),
      ],
    }),
    { configDir: null, env: {}, errors: { onKernelLog: (info) => void events.push(info.event) } },
  );
  await app.start();
  await app.start(); // 幂等：第二次直接 return（"已启动"）
  await assert.rejects(() => app.actor('Flaky').ask({}), /boom 1/);
  await sleep(120);
  await app.stop();

  // 一次崩溃 = 一次 actor_crash；若监听被叠加两次，这里会数到 2
  const crashes = events.filter((event) => event === 'actor_crash').length;
  assert.strictEqual(crashes, 1, `内核监听只该装一次，实测收到 ${String(crashes)} 次：${events.join(', ')}`);
});

test('P1: 持久化死信 —— deadLettersPlugin({ path }) 之后，重启应用仍读得到（消息不会静默消失）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-dlq-'));
  const queue = path.join(dir, 'dlq.jsonl');
  const boot = async () => {
    const app = createApp(
      defineApp({
        modules: [
          defineModule({
            name: 'main',
            actors: { Sink: { definition: alwaysFails, options: { failure: 'retry', maxRetry: 0, retryBackoffMs: 1 } } },
          }),
        ],
        plugins: [deadLettersPlugin({ path: queue })],
      }),
      { configDir: '', env: {}, errors: { onDeadLetter: () => undefined } },
    );
    await app.start();
    return app;
  };

  try {
    const first = await boot();
    try {
      await assert.rejects(() => first.actor('Sink').ask({ x: 1 }), /boom 1/);
      await sleep(200);
      const inMemory = await first.deadLetters();
      assert.strictEqual(inMemory.length, 1, `落盘插件生效时也应当读得到：${JSON.stringify(inMemory)}`);
      assert.strictEqual(inMemory[0]?.path, 'Sink', '读回来的形状要和内存环一致（path/retryCount/error）');
      assert.strictEqual(inMemory[0]?.retryCount, 0);
      assert.match(inMemory[0]?.error ?? '', /boom 1/);
      assert.deepStrictEqual(inMemory[0]?.payload, { x: 1 }, '原始消息要留住（否则没法重放排查）');
    } finally {
      await first.stop();
    }

    assert.ok(fs.existsSync(queue), `死信应当落盘到 ${queue}`);
    assert.match(fs.readFileSync(queue, 'utf8'), /boom 1/);

    // 新实例（新进程也一样）从磁盘读回同一条 —— 这就是"持久化"的意思
    const second = await boot();
    try {
      const persisted = await second.deadLetters();
      assert.strictEqual(persisted.length, 1, `重启后仍要读得到：${JSON.stringify(persisted)}`);
      assert.match(persisted[0]?.error ?? '', /boom 1/);
      assert.strictEqual(await second.clearDeadLetters(), 1, 'clear 要把落盘的那份也清掉');
      assert.deepStrictEqual(await second.deadLetters(), []);
    } finally {
      await second.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
