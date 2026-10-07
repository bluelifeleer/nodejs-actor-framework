import { test } from 'node:test';
import assert from 'node:assert';

import { defineApp, defineModule, runApp } from '@actor/app';
import { defineController, defineWebPlugin, get, httpPlugin } from '@actor/web';

/**
 * `runApp()` 的信号路径也要能测：退出行为是**注入**的（默认 process.exit），
 * 所以测试里换成 spy，就能断言"停一次、退 0、重复信号不重复退"。
 */
function makeApp() {
  return defineApp({
    name: 'run-app-test',
    modules: [defineModule({ name: 'app', routes: [] })],
    plugins: [
      defineWebPlugin({
        name: 'probe',
        routes: [get('/ping', () => ({ pong: true }))],
      }),
      httpPlugin({ port: 0 }),
    ],
  });
}

test('runApp: 启动 → 处理信号 → 优雅停 → 退出码 0，且重复信号不会重复退出', async () => {
  const exits: number[] = [];
  const logs: string[] = [];
  // 用 SIGWINCH：它的**默认动作是被忽略**，所以在共享的测试进程里 emit 它不会误杀测试运行器
  // （早先用 SIGUSR2 试过：默认动作是终止进程，Node 会写出 report.*.json 崩溃报告）
  const app = await runApp(makeApp(), {
    signals: ['SIGWINCH'],
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
  });

  // 起来了
  assert.ok(app !== undefined, 'runApp 应当返回已启动的 application');
  process.emit('SIGWINCH');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepStrictEqual(exits, [0], `信号后应当以 0 退出一次：${JSON.stringify(exits)}`);
  assert.ok(logs.some((line) => line.includes('stopped gracefully')), `要有优雅停日志：${JSON.stringify(logs)}`);

  // 重复信号不该再退一次（第二个信号在第一个处理中被忽略）
  process.emit('SIGWINCH');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepStrictEqual(exits, [0], `重复信号不该重复退出：${JSON.stringify(exits)}`);
});

test('runApp: onStarted 能拿到已启动的 application（示例用它打印监听地址）', async () => {
  let started = false;
  let sawApp: unknown;
  const app = await runApp(makeApp(), {
    signals: [],
    onStarted: (instance) => {
      started = true;
      sawApp = instance;
    },
  });
  assert.strictEqual(started, true, 'onStarted 必须被调用（且是在 start 之后）');
  assert.strictEqual(sawApp, app, 'onStarted 拿到的就是返回的那个 application');
  await app.stop({ timeoutMs: 5000 });
});
