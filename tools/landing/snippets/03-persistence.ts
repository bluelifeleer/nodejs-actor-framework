// 持久化：snapshot 模式下，应用重启后状态还在（同一个持久化目录 = 同一份真相）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, defineApp, defineModule } from '@actor/app';
import { defineController, defineRoutes, get, httpPlugin, post } from '@actor/web';

type CounterRef = { ask<R>(msg: unknown): Promise<R> };

const Counter = {
  preStart(this: { state: { count: number } }) {
    this.state = { count: 0 };
  },
  receive(this: { state: { count: number } }, msg: { type: 'add'; by: number } | { type: 'get' }) {
    if (msg.type === 'add') this.state.count += msg.by;
    return this.state.count;
  },
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-landing-'));

/** 起一个真应用（端口 0 = 随机，避免和别的东西撞）。 */
async function boot(): Promise<{ app: Awaited<ReturnType<typeof createApp>>; base: string }> {
  const http = httpPlugin({ port: 0, accessLog: false });
  const app = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'app',
          actors: { Counter: { definition: Counter, options: { persistence: { mode: 'snapshot' } } } },
          routes: defineRoutes([
            post(
              '/add',
              defineController({
                body: ['by'],
                input: { by: { type: 'number', min: 1 } },
                async handle(input, ctx) {
                  return (ctx.actor('Counter') as CounterRef).ask({ type: 'add', by: Number(input.by) });
                },
              }),
            ),
            get(
              '/count',
              defineController({
                handle: (_input, ctx) => (ctx.actor('Counter') as CounterRef).ask({ type: 'get' }),
              }),
            ),
          ]),
        }),
      ],
      plugins: [http],
    }),
    // 快照写到同一个目录：这是"重启后还在"的全部前提
    { configDir: '', env: {}, kernel: { logger: false, persistence: { dir } } },
  );
  await app.start();
  return { app, base: `http://127.0.0.1:${String(http.address()?.port)}` };
}

const first = await boot();
await fetch(`${first.base}/add`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ by: 41 }),
});
assert.strictEqual(await (await fetch(`${first.base}/count`)).json(), 41);
await first.app.stop(); // 状态已经进快照

const second = await boot(); // 全新实例、同一个持久化目录
assert.strictEqual(await (await fetch(`${second.base}/count`)).json(), 41, '重启后状态必须还在');
await second.app.stop();

fs.rmSync(dir, { recursive: true, force: true });
console.log('before=41 after-restart=41');
