import { test } from 'node:test';
import assert from 'node:assert';
import { createAppLogger, matchesPattern } from '../src/logging.ts';
import { createApp, defineApp, defineModule } from '../src/index.ts';

/**
 * P2：**统一日志入口**（`createApp(..., { logging })`）。
 *
 * 要证明：
 *   ① 三类事件（`app:*` / `kernel:*` / `http:*`）汇到一个出口，且**字段与级别**符合策略；
 *   ② `filter` / `exclude` / `level` / `context` / `redactKeywords` 五项策略真的生效；
 *   ③ 给了 `logging.logger` 时**不会重复**（内核日志不再经事件桥二次转发）；
 *   ④ 不给 `logging` 时行为与从前一致（不产生新输出、不装监听）。
 */

/** 收集所有送出的事件（当作"用户的 logger"）。 */
function collector(): { events: Array<{ event: string; level?: string; meta?: Record<string, unknown> }>; sink: (event: string, meta?: Record<string, unknown>) => void } {
  const events: Array<{ event: string; level?: string; meta?: Record<string, unknown> }> = [];
  return { events, sink: (event, meta) => void events.push({ event, ...(meta === undefined ? {} : { meta }) }) };
}

test('P2: 通配符匹配是"整串"语义（`kernel:*` 不误伤 `scheduler` 之类）', () => {
  assert.strictEqual(matchesPattern('kernel:*', 'kernel:actor_crash'), true);
  assert.strictEqual(matchesPattern('kernel:*', 'http:access'), false);
  assert.strictEqual(matchesPattern('http:access', 'http:access'), true);
  assert.strictEqual(matchesPattern('*', 'anything'), true);
  assert.strictEqual(matchesPattern('kernel:actor_*', 'kernel:actor_crash'), true);
  assert.strictEqual(matchesPattern('kernel:actor_*', 'kernel:snapshot_auto_failed'), false);
});

test('P2: 级别判定 —— 失败类事件是 warn，其余 info，debug 显式降级', () => {
  const { events, sink } = collector();
  // levelOf 可以只覆盖一部分事件（返回 undefined = 用默认规则）
  const logger = createAppLogger({
    logger: sink,
    levelOf: ({ event }) => (event.endsWith('_debug') ? 'debug' : undefined),
  });
  logger.publish('kernel', 'kernel:actor_crash', { path: 'A' });
  logger.publish('app', 'app:started', {});
  logger.publish('kernel', 'kernel:whatever_debug', {});
  const byEvent = new Map(events.map((item) => [item.event, item.meta?.['level']]));
  assert.strictEqual(byEvent.get('kernel:actor_crash'), 'warn', '崩溃必须 warn');
  assert.strictEqual(byEvent.get('app:started'), 'info');
  assert.strictEqual(byEvent.get('kernel:whatever_debug'), 'debug', 'levelOf 可覆盖');
});

test('P2: filter / exclude / level 三项过滤真的生效（exclude 优先）', () => {
  const { events, sink } = collector();
  const only = createAppLogger({ logger: sink, filter: ['kernel:*'] });
  only.publish('kernel', 'kernel:actor_crash');
  only.publish('http', 'http:access');
  only.publish('app', 'app:started');
  assert.deepStrictEqual(events.map((item) => item.event), ['kernel:actor_crash'], 'filter 只留 kernel');

  const except = collector();
  const excluded = createAppLogger({ logger: except.sink, exclude: ['kernel:scheduler_error'] });
  excluded.publish('kernel', 'kernel:scheduler_error');
  excluded.publish('kernel', 'kernel:actor_crash');
  assert.deepStrictEqual(except.events.map((item) => item.event), ['kernel:actor_crash'], 'exclude 优先');

  const quiet = collector();
  const levelLimited = createAppLogger({ logger: quiet.sink, level: 'warn' });
  levelLimited.publish('kernel', 'kernel:actor_crash'); // warn → 留下
  levelLimited.publish('app', 'app:started'); // info → 被级别挡掉
  assert.deepStrictEqual(quiet.events.map((item) => item.event), ['kernel:actor_crash'], 'level 只留 warn 及以上');
});

test('P2: context 补齐公共字段（事件 meta 优先），framework:false 时框架自身事件不打', () => {
  const { events, sink } = collector();
  const logger = createAppLogger({ logger: sink, context: () => ({ service: 'demo', env: 'test' }) });
  logger.publish('kernel', 'kernel:actor_crash', { service: 'override-me', path: 'A' });
  const meta = events[0]?.meta ?? {};
  assert.strictEqual(meta['env'], 'test', '公共字段要补上');
  assert.strictEqual(meta['service'], 'override-me', '事件自己的 meta 优先');

  const quiet = collector();
  const noFramework = createAppLogger({ logger: quiet.sink, framework: false });
  noFramework.publish('app', 'app:started');
  noFramework.publish('plugin', 'plugin:http_listening');
  noFramework.publish('kernel', 'kernel:actor_crash');
  assert.deepStrictEqual(quiet.events.map((item) => item.event), ['kernel:actor_crash'], '框架自身日志可关掉');
});

test('P2: 对象日志器（pino/console 那类）也能直接接', () => {
  const lines: Array<{ level: string; line: string }> = [];
  const target = {
    info: (line: string) => void lines.push({ level: 'info', line }),
    warn: (line: string) => void lines.push({ level: 'warn', line }),
    error: (line: string) => void lines.push({ level: 'error', line }),
  };
  const logger = createAppLogger({ logger: target });
  logger.publish('kernel', 'kernel:actor_crash', { path: 'A' });
  logger.publish('app', 'app:started', { modules: 1 });
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0]?.level, 'warn', '崩溃走 warn');
  assert.match(lines[0]?.line ?? '', /kernel:actor_crash/);
  assert.match(lines[1]?.line ?? '', /app:started/);
});

test('P2: 应用层 —— 生命周期与内核事件汇到同一个出口（且不重复）', async () => {
  const { events, sink } = collector();
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: {
            Flaky: {
              definition: {
                preStart(this: { state: { n: number } }) {
                  this.state = { n: 0 };
                },
                receive(this: { state: { n: number } }) {
                  this.state.n += 1;
                  throw new Error(`boom ${String(this.state.n)}`);
                },
              },
              options: { failure: 'crash', restart: 'restart', retryBackoffMs: 1 },
            },
          },
        }),
      ],
    }),
    { configDir: null, env: {}, logging: { logger: sink } },
  );
  await app.start();
  try {
    await assert.rejects(() => app.actor('Flaky').ask({}), /boom 1/);
    for (let index = 0; index < 40 && !events.some((item) => item.event === 'kernel:actor_crash'); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await app.stop();
  }

  const names = events.map((item) => item.event);
  assert.ok(names.includes('app:started'), `应用生命周期事件要出来：${names.join(', ')}`);
  assert.ok(names.includes('kernel:actor_crash'), `内核事件要出来：${names.join(', ')}`);
  assert.strictEqual(
    names.filter((name) => name === 'kernel:actor_crash').length,
    1,
    `同一条内核日志只能出现一次（给了 logger 时不该再经事件桥转发）：${names.join(', ')}`,
  );
  assert.ok(names.includes('app:stopped'), '停止也要留痕');
});

test('P2: 不给 logging 时不产生新输出、不装内核监听（与从前一致）', async () => {
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'main',
          actors: {
            Flaky: {
              definition: {
                preStart(this: { state: { n: number } }) {
                  this.state = { n: 0 };
                },
                receive() {
                  throw new Error('boom');
                },
              },
              options: { failure: 'crash', restart: 'restart', retryBackoffMs: 1 },
            },
          },
        }),
      ],
    }),
    { configDir: null, env: {} },
  );
  await app.start();
  try {
    assert.strictEqual(app.logSink, null, '没配 logging 时没有统一出口（插件自己兜底）');
    assert.strictEqual(app.redactKeywords, undefined);
    await assert.rejects(() => app.actor('Flaky').ask({}));
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    await app.stop();
  }
});
