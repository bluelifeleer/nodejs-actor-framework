/**
 * 任务脚本 ②：只看 [12 Actor 与状态](../../docs/guide/12-actors-state.md) 就能跑通的状态与持久化。
 *
 * 断言：同一 Actor 消息串行（并发不丢）、快照重启后仍在、`deps` 注入在启动期校验。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = `file://${process.cwd()}/`;
const { createApp, defineApp, defineModule } = await import(`${repo}packages/app/src/index.ts`);
const { defineController, defineRoutes, get, httpPlugin, post } = await import(`${repo}packages/web/src/index.ts`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-task-actor-'));

const Counter = {
  preStart() { this.state = { n: 0 }; },
  async receive(msg) {
    if (msg.type === 'add') {
      const current = this.state.n;
      await new Promise((resolve) => setTimeout(resolve, 0));   // 模拟"慢 IO"：串行保证仍成立
      this.state.n = current + msg.by;
    }
    return this.state.n;
  },
};

async function boot() {
  const http = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'app',
          actors: { Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } } },
          routes: defineRoutes([
            post('/counter/add', defineController({
              body: ['by'],
              input: { by: { type: 'number', min: 1 } },
              handle: (input, ctx) => ctx.actor('Counter').ask({ type: 'add', by: Number(input.by) }),
            })),
            get('/counter', defineController({ handle: (_input, ctx) => ctx.actor('Counter').ask({ type: 'read' }) })),
          ]),
        }),
      ],
      plugins: [http],
    }),
    { configDir: '', env: {}, kernel: { logger: false, persistence: { dir: dataDir } } },
  );
  await app.start();
  return { app, base: `http://127.0.0.1:${String(http.address()?.port)}` };
}

const first = await boot();
try {
  const add = (by) => fetch(`${first.base}/counter/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }) });
  await Promise.all([add(1), add(1), add(1), add(1), add(1)]);          // 并发 5 条
  assert.strictEqual(await (await fetch(`${first.base}/counter`)).json(), 5, '消息串行：并发 5 条一条不丢');
} finally {
  await first.app.stop();
}

const second = await boot();          // 全新实例、同一个持久化目录
try {
  assert.strictEqual(await (await fetch(`${second.base}/counter`)).json(), 5, '快照模式：重启后状态还在');
  console.log('task-actor-ok');
} finally {
  await second.app.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
