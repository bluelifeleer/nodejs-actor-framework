// 应用层：控制器只放 HTTP 语义，状态放 Actor（串行、可持久化）
// 这一段会被 typecheck + 真跑（起真服务器、发真请求）。
import assert from 'node:assert';

import { createApp, defineApp, defineModule } from '@actor/app';
import { defineController, defineRoutes, get, httpPlugin, post, reply } from '@actor/web';

// 状态**只放 this.state** —— 这就是快照/恢复的契约
const Counter = {
  preStart(this: { state: { hits: number } }) {
    this.state = { hits: 0 };
  },
  receive(this: { state: { hits: number } }, msg: { delta: number }) {
    this.state.hits += msg.delta; // 消息串行执行：读-改-写不会交错
    return this.state.hits;
  },
};

const hit = defineController({
  body: ['delta'],
  input: { delta: { type: 'number', default: 1, min: 0, max: 100 } },
  async handle(input, ctx) {
    // ctx.actor() 故意返回 unknown（内核类型不进应用层）：边界上显式收窄一次
    const counter = ctx.actor('Counter') as { ask<R>(msg: unknown): Promise<R> };
    return { total: await counter.ask<number>({ delta: Number(input.delta) }) };
  },
});

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'main',
        // 这一段只演示"HTTP + Actor"：要持久化见下面第三段（snapshot 模式必须配持久化目录，
        // 否则框架会在**启动期**就报 PersistenceError —— 这正是"启动期失败优于运行期事故"）
        actors: { Counter: { definition: Counter } },
        routes: defineRoutes([get('/health', () => reply.json({ ok: true })), post('/hit', hit)]),
      }),
    ],
    plugins: [http],
  }),
  { configDir: '', env: {}, kernel: { logger: false } },
);

await app.start();
const base = `http://127.0.0.1:${String(http.address()?.port)}`;
const hitWith = (body: unknown): Promise<Response> =>
  fetch(`${base}/hit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

assert.strictEqual((await fetch(`${base}/health`)).status, 200);
assert.deepStrictEqual(await (await hitWith({ delta: 2 })).json(), { total: 2 });
assert.deepStrictEqual(await (await hitWith({ delta: 3 })).json(), { total: 5 });
assert.strictEqual((await hitWith({ delta: 999 })).status, 400, '输入校验是 400（不是 500）');

await app.stop();
console.log('health=200 total=2→5 bad-input=400');
