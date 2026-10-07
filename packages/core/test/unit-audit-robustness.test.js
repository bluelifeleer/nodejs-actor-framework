'use strict';

/**
 * 审计发现的回归测试（docs/audit/2026-10-07-audit.md）。
 *
 * 这些用例在修复前**必须失败**——它们就是审计里那几条"绿了但会崩/会挂"的问题：
 *   1. WebSocket 连接没有 error 监听 → 客户端一次 RST 打崩整个进程（用子进程验证，因为崩的是进程）；
 *   2. 遥测监听器抛异常 → system.stop() 永久挂住；崩溃的 Actor 永不重启；
 *   3. spawn() 失败后 cell 泄漏，半初始化的 Actor 仍在处理消息；
 *   4. FilePersistence 的"进程内条件写"在同进程并发下不成立（双写成功、事件重复落盘）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const { createSystem } = require('../src/index.ts');
const { FilePersistence } = require('../src/store/persistence.ts');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/** 跑到超时就判"挂住"（而不是让测试进程一起挂）。 */
async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise.then(
      (value) => ({ settled: true, value }),
      (err) => ({ settled: true, error: err }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false, label }), ms)),
  ]);
}

test('audit/ws: 客户端异常断开（RST）不得打崩进程', async () => {
  // 崩的是**进程**，所以必须在子进程里验证：退出码 0 = 活下来，7 = 被未捕获异常打死。
  const script = `
    const { WebSocketServer, connect } = require(${JSON.stringify(path.join(REPO_ROOT, 'packages/core/src/ops/ws-server.ts'))});
    (async () => {
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      // 与 packages/web/src/ws.ts 的挂法一致：只挂 close/message
      server.on('connection', (s) => { s.on('close', () => {}); s.on('message', () => {}); });
      await server.listen();
      process.on('uncaughtException', (e) => {
        process.stdout.write('CRASHED ' + e.code + ' ' + e.message + '\\n');
        process.exit(7);
      });
      const c = await connect('ws://127.0.0.1:' + server.port);
      c.socket.resetAndDestroy();
      setTimeout(() => { process.stdout.write('SURVIVED\\n'); process.exit(0); }, 700);
    })();
  `;
  const result = await run(process.execPath, ['-e', script], { timeout: 30_000 }).catch((err) => err);
  const stdout = String(result.stdout ?? '');
  assert.ok(!stdout.includes('CRASHED'), `进程被未捕获异常打崩：${stdout.trim()}`);
  assert.match(stdout, /SURVIVED/, `子进程没有正常存活：${stdout.trim()} ${String(result.stderr ?? '').slice(0, 300)}`);
});

test('audit/emit: 抛异常的遥测监听器不得挂死 system.stop()', async () => {
  const system = createSystem({ logger: false, shutdownTimeoutMs: 300 });
  system.on('actor_stopped', () => {
    throw new Error('bad actor_stopped listener');
  });
  await system.spawn({ receive: (msg) => msg }, { id: 'a' });

  const outcome = await withTimeout(system.stop(), 3000, 'STOP_HUNG');
  assert.strictEqual(outcome.settled, true, 'system.stop() 被一个抛异常的事件监听器永久挂住了');
});

test('audit/emit: 抛异常的日志监听器不得中止崩溃监督', async () => {
  const system = createSystem({ logger: false });
  system.on('log', () => {
    throw new Error('bad log listener');
  });
  try {
    const ref = await system.spawn(
      {
        preStart() {
          this.n = 0;
        },
        receive(msg) {
          if (msg === 'boom') throw new Error('boom');
          return this.n;
        },
      },
      { id: 'b' },
    );
    await ref.ask('boom').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    const info = system.inspect('b');
    assert.strictEqual(info.restarts, 1, '崩溃监听器抛错后监督被中止（Actor 没有重启）');
  } finally {
    await withTimeout(system.stop(), 3000, 'STOP_HUNG');
  }
});

test('audit/spawn: 初始化失败不得遗留 cell，也不得让半初始化实例接收消息', async () => {
  const system = createSystem({ logger: false });
  try {
    const bad = {
      preStart() {
        throw new Error('preStart exploded');
      },
      receive() {
        return 'SERVED';
      },
    };
    for (const id of ['bad-a', 'bad-b']) {
      await assert.rejects(() => system.spawn(bad, { id }), /preStart exploded/);
    }
    assert.deepStrictEqual(system.listActors(), [], '失败的 spawn 把 cell 留在了注册表里');
    assert.strictEqual(system.resolve('bad-a'), null, '失败的 spawn 仍能被 resolve 到');
    assert.throws(() => system.inspect('bad-a'), /no actor registered/i);
  } finally {
    await withTimeout(system.stop(), 3000, 'STOP_HUNG');
  }
});

test('audit/persistence: 同进程两个 owner 的并发条件写必须恰好一个成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cond-'));
  const definition = {
    preStart() {
      this.n = 0;
    },
    async receive(msg, ctx) {
      if (msg === 'bump') await ctx.persist({ type: 'Bump', n: 1 });
      return this.n;
    },
    applyEvent(event) {
      if (event.type === 'Bump') this.n += event.n;
    },
  };
  const a = createSystem({ logger: false, persistence: { dir } });
  const b = createSystem({ logger: false, persistence: { dir } });
  try {
    const options = { id: 'shared', persistence: { mode: 'events' } };
    const refA = await a.spawn(definition, options);
    const refB = await b.spawn(definition, options); // 两个 owner 都从版本 0 开始

    const results = await Promise.allSettled([refA.ask('bump'), refB.ask('bump')]);
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    assert.strictEqual(okCount, 1, `并发条件写应当恰好一个成功，实际 ${okCount} 个成功（另一个应抛 PersistenceConflictError）`);

    const onDisk = await new FilePersistence({ baseDir: dir }).loadEvents('shared');
    assert.strictEqual(onDisk.length, 1, `条件写被绕过：落盘了 ${onDisk.length} 条事件（期望 1）`);
  } finally {
    await withTimeout(b.stop(), 3000, 'STOP_HUNG').catch(() => {});
    await withTimeout(a.stop(), 3000, 'STOP_HUNG').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit/persistence: 临时文件名不得只由 pid 组成（并发写会互相 rename）', () => {
  const files = [
    'packages/core/src/store/persistence.ts',
    'packages/data/src/outbox/stores.ts',
    'packages/data/src/migration/stores.ts',
    'packages/data/src/repository/file.ts',
  ];
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const line of text.split('\n')) {
      if (/\$\{process\.pid\}\.tmp/.test(line)) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `这些临时文件名没有随机后缀，并发写会互相 rename：\n${offenders.join('\n')}`);
});
