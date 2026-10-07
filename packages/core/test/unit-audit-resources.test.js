'use strict';

/**
 * 审计 Round 3 的回归测试：资源与"界"。
 *
 * 对应审计发现：
 *   F8  Metrics.data 以 actor 路径为键、随 churn 无界增长（reset 存在但没有调用方）；
 *   F9  FileStore 的 index/chain 永不收缩；
 *   F11 顶层重启配额是全系统共享的（4 个互不相关的崩溃会停掉整个系统）——这里只固定"可配置 + 有记录"；
 *   F12 Application.stop({ timeoutMs }) 被内核静默忽略；
 *   F13 ClientConnection.next* 超时后不移除 once 监听器；
 *   S14 applyEvent 用 Object.assign 处理 JSON 事件 → __proto__ 会改写 state 原型。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSystem, plugins } = require('../src/index.ts');
const { FileStore } = require('../src/store/backends/file-store.ts');
const { WebSocketServer, connect: wsConnect } = require('../src/ops/ws-server.ts');

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

test('audit/metrics: 停止的 Actor 必须从 Metrics.data 里被剔除（否则随 churn 无界增长）', async () => {
  const system = createSystem({
    logger: false,
    shutdownTimeoutMs: 300,
    plugins: [plugins.metrics({ exporter: { enabled: false }, intervalMs: 50 })],
  });
  try {
    // 动态 id：这正是"会无界增长"的用法（session-1、session-2……）
    for (let i = 0; i < 12; i += 1) {
      const ref = await system.spawn({ receive: (m) => m }, { id: `session-${i}` });
      await ref.stop();
    }
    await settle(200);
    const tracked = system.metrics?.data ? system.metrics.data.size : 0;
    assert.ok(tracked <= 2, `已停止的 Actor 仍留在 Metrics.data 里：${tracked} 条（应当是 0~2）`);
  } finally {
    await system.stop().catch(() => {});
  }
});

test('audit/store: FileStore 的串行化链与 index 不得无限累积', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-store-'));
  try {
    const store = new FileStore({ baseDir: dir, maxTrackedActors: 8 });
    for (let i = 0; i < 40; i += 1) {
      await store.append(`actor-${i}`, [{ seq: 1, payload: Buffer.from('x') }]);
    }
    // index/chain 是进程内缓存：清掉的应当能被重新读盘恢复，所以给它们设上界是安全的
    assert.ok((store.index?.size ?? 0) <= 8, `index 无界增长：${store.index?.size}`);
    assert.ok((store.chain?.size ?? 0) <= 8, `chain 无界增长：${store.chain?.size}`);
    // 被淘汰的 actor 仍然要能正常读写（状态从盘上恢复）
    const records = await store.load('actor-0');
    assert.strictEqual(records.length, 1, '淘汰缓存后读不到已经写下的记录');
    await store.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit/ws: nextMessage 超时后必须移除 once 监听器', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let serverSide = null;
  server.on('connection', (socket) => (serverSide = socket));
  try {
    const port = await server.listen();
    const client = await wsConnect(`ws://127.0.0.1:${port}`);
    await settle(50);
    assert.ok(serverSide, '没有拿到服务端连接');
    const before = client.listenerCount('message');
    for (let i = 0; i < 30; i += 1) {
      await client.nextMessage(5).catch(() => null); // 每次都超时
    }
    const after = client.listenerCount('message');
    assert.ok(
      after <= before + 1,
      `超时没有移除监听器：message 监听器从 ${before} 涨到 ${after}（MaxListenersExceededWarning 就是这么来的）`,
    );
    client.socket?.destroy?.();
  } finally {
    await server.close().catch(() => {});
  }
});

test('audit/kernel: system.stop({ timeoutMs }) 必须生效，而不是静默用默认值', async () => {
  // 审计 F12 的实质：`@actor/app` 的 Application.stop({timeoutMs}) 会把值传给 system.stop()，
  // 而 system.stop() 原本**不接受参数**，于是调用方请求多少都白搭（默认 2000ms）。
  // 这里直接测内核语义：卡在 handler 里的 Actor，其停机预算应当由传入的 timeoutMs 决定。
  const system = createSystem({ logger: false, shutdownTimeoutMs: 5000 });
  let stuck = false;
  const ref = await system.spawn(
    {
      receive() {
        stuck = true;
        return new Promise(() => {}); // 永不返回
      },
    },
    { id: 'stuck-1' },
  );
  await ref.ask('go', 200).catch(() => null);
  await settle(50);
  assert.strictEqual(stuck, true, 'Actor 没有进入 handler');

  const startedAt = Date.now();
  await system.stop({ timeoutMs: 300 });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1500, `stop({ timeoutMs: 300 }) 实际用了 ${elapsed}ms（默认 5000ms 被用了 —— 参数被忽略）`);
  assert.ok(elapsed >= 200, `stop() 返回得太快（${elapsed}ms），可能没等停机预算`);
});

test('audit/actor: applyEvent 的 __proto__ 不得改写 state 原型', async () => {
  const { Actor } = require('../src/index.ts');
  class ProtoActor extends Actor {
    preStart() {
      this.state = { safe: true };
    }
    receive() {
      return null;
    }
  }
  const actor = new ProtoActor();
  actor.preStart();
  // 模拟从磁盘事件日志里读回来的事件（JSON.parse 会产生自有属性 __proto__）
  actor.applyEvent(JSON.parse('{"__proto__":{"polluted":42}}'));
  assert.strictEqual(
    Object.getPrototypeOf(actor.state).polluted,
    undefined,
    'applyEvent 让 __proto__ 改写了 state 的原型',
  );
  assert.strictEqual({}.polluted, undefined);
});

test('audit/dlq: 死信队列要有字节上限，且不再每次 enqueue 都全量读文件', async () => {
  const { DeadLetterQueue } = require('../src/store/dead-letter-queue.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-dlq-'));
  try {
    const dlq = new DeadLetterQueue({ baseDir: dir, maxEntries: 100000, maxBytes: 2048 });
    await dlq.init();
    for (let i = 0; i < 200; i += 1) {
      await dlq.enqueue({ actorId: 'a', reason: 'boom', msg: { pad: 'x'.repeat(64), i } });
    }
    const bytes = fs.statSync(path.join(dir, 'dlq.jsonl')).size;
    assert.ok(bytes <= 4096, `死信文件超过字节上限：${bytes} 字节（上限 2048，允许一倍余量）`);
    const listed = await dlq.list(10);
    assert.ok(Array.isArray(listed) && listed.length > 0, '裁剪之后仍然要能读出来');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit/plugins: teardown 必须把挂在 system/gossip 上的监听器摘掉', async () => {
  const { createSystem, plugins } = require('../src/index.ts');
  const system = createSystem({
    logger: false,
    shutdownTimeoutMs: 500,
    plugins: [plugins.cluster({ nodeId: 'n1', port: 0, shardCount: 4 }), plugins.pubsub()],
  });
  try {
    await system.init(); // 插件在 init()（或首个 spawn/listen）时安装
    const gossip = system.cluster?.gossip;
    assert.ok(gossip, '没有拿到 gossip 实例（测试前提不成立）');
    const before = {
      system: system.listenerCount('actor_stopped') + system.listenerCount('actor_registered'),
      gossip: gossip.listenerCount('registry_update') + gossip.listenerCount('node_timeout'),
    };
    assert.ok(before.system + before.gossip > 0, '插件没有挂任何监听器（测试前提不成立）');
    await system.stop();
    const after = {
      system: system.listenerCount('actor_stopped') + system.listenerCount('actor_registered'),
      gossip: gossip.listenerCount('registry_update') + gossip.listenerCount('node_timeout'),
    };
    assert.deepStrictEqual(after, { system: 0, gossip: 0 }, `teardown 之后监听器没摘干净：${JSON.stringify(after)}`);
  } finally {
    await system.stop().catch(() => {});
  }
});

test('audit/supervision: 顶层重启配额是可配置的，且整系统共享（语义要写清楚）', async () => {
  const { createSystem } = require('../src/index.ts');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const boom = {
    preStart() {
      this.n = 0;
    },
    receive(m) {
      if (m === 'boom') throw new Error('x');
      return 1;
    },
  };

  // 配额 1：同一个 Actor 崩第二次就该升级 → 停掉整个系统
  const strict = createSystem({ logger: false, shutdownTimeoutMs: 300, supervision: { maxRestarts: 1, withinSeconds: 60 } });
  try {
    const ref = await strict.spawn(boom, { id: 'a' });
    for (let i = 0; i < 6 && strict.stopped === false; i += 1) {
      await ref.ask('boom', 300).catch(() => null);
      await wait(150);
    }
    assert.strictEqual(strict.stopped, true, 'maxRestarts=1 时连续崩溃没有触发升级（配额没生效）');
  } finally {
    await strict.stop().catch(() => {});
  }

  // 配额 5：同样两次崩溃不应当停掉系统
  const loose = createSystem({ logger: false, shutdownTimeoutMs: 300, supervision: { maxRestarts: 5, withinSeconds: 60 } });
  try {
    const ref = await loose.spawn(boom, { id: 'a' });
    for (let i = 0; i < 3; i += 1) {
      await ref.ask('boom', 300).catch(() => null);
      await wait(150);
    }
    assert.strictEqual(loose.stopped, false, 'maxRestarts=5 时两三次崩溃就把系统停了（配额被共享放大）');
  } finally {
    await loose.stop().catch(() => {});
  }
});
