import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clusterPlugin, createApp, defineApp, defineModule } from '@actor/app';

import { defineController, defineRoutes, get, httpPlugin } from '../src/index.ts';

/**
 * 位置透明的**真实两节点**验证（M2 剩余项 1，也是 M4 集群里程碑的前置）。
 *
 * 与 `packages/app/test/app.test.ts` 里那条单测的区别：那条只证明"内核解析这条链路接通"，
 * 用的是**同一个进程里的同一个内核**；这里两个节点各有自己的 gossip 与网关，
 * B 节点的控制器 `ctx.actor('Room_A')` **只有经 gossip 发现** 才可能拿到远端 ref。
 *
 * 关键点：**全程没有 `app.kernel`**。网关由 `clusterPlugin` 自己在 onReady 启动
 * （见 packages/app/src/plugins.ts 的 clusterPlugin 注释）——这正是"应用层不出现内核概念"
 * 这一边界规则的兑现方式。
 */

interface ActorHandleLike {
  ask(message: unknown, timeoutMs?: number): Promise<unknown>;
}

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-web-cluster-'));
}

/** 两个节点共用的 gossip 参数：回环、随机端口、快周期（测试要快）。 */
const GOSSIP = {
  host: '127.0.0.1',
  advertiseHost: '127.0.0.1',
  port: 0,
  intervalMs: 50,
  peerTimeoutMs: 5000,
};

test('cluster: 控制器在 B 节点、Actor 在 A 节点，ctx.actor 经 gossip 发现后跨节点 ask', async (t) => {
  // A 节点：只声明 Actor，没有任何 HTTP 入口（"业务节点"）
  const servedOnA: unknown[] = [];
  const clusterA = clusterPlugin({ ...GOSSIP, nodeId: 'node-a' });
  const appA = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'rooms',
          actors: {
            Room_A: async (msg: unknown) => {
              // 只有 A 节点的 Actor 会执行到这里——这是"消息真的跑在 A 上"的证据，
              // 比断言返回值里的字符串更难伪造。
              servedOnA.push(msg);
              return { servedBy: 'node-a', echo: msg };
            },
          },
        }),
      ],
      plugins: [clusterA],
    }),
    { configDir: tempConfigDir(), env: {} },
  );

  await appA.start();
  // 网关是插件自己起的（无需 app.kernel.listen）；gossip 的地址用于给 B 当种子
  assert.ok(clusterA.address()?.port, 'A 节点的网关应由 clusterPlugin 自动启动');
  const gossipA = clusterA.gossipAddress()?.port;
  assert.ok(gossipA, 'A 节点的 gossip 应已监听（否则 B 无从发现）');

  // B 节点：只有控制器，**本地没有 Room_A**（"接入/边缘节点"）
  const httpB = httpPlugin({ port: 0, accessLog: false });
  const clusterB = clusterPlugin({
    ...GOSSIP,
    nodeId: 'node-b',
    seeds: [{ host: '127.0.0.1', port: gossipA }],
  });
  const appB = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'edge',
          routes: defineRoutes([
            get(
              '/rooms/:id',
              defineController({
                input: { id: { type: 'string' } },
                handle: async (input, ctx) => {
                  // 唯一桥梁：本地没有就交给内核按名字解析（装了 cluster 插件即查 gossip 索引）
                  const handle = ctx.actor(input.id) as ActorHandleLike;
                  return { askedFrom: 'node-b', answer: await handle.ask({ type: 'ping' }, 3000) };
                },
              }),
            ),
          ]),
        }),
      ],
      plugins: [httpB, clusterB],
    }),
    { configDir: tempConfigDir(), env: {} },
  );

  t.after(async () => {
    await appB.stop();
    await appA.stop();
  });

  await appB.start();

  // 发现是**最终一致**的：先等 gossip 把 A 的名册带到 B，再看 HTTP 行为
  const meta = await clusterB.waitFor('Room_A', 10_000);
  assert.strictEqual(meta.nodeId, 'node-a', 'Room_A 应被发现在 A 节点上');
  assert.ok(clusterB.remoteActors().includes('Room_A'), 'B 的索引里应有远端 Room_A（而不是本地）');
  assert.ok(
    clusterB.peers().some((peer) => peer.lastSeen > 0),
    'B 应有一个**活着的** peer，而不只是"听说过"',
  );

  const portB = httpB.address()?.port;
  assert.ok(portB, 'B 节点的 HTTP 入口应已就绪');

  const response = await fetch(`http://127.0.0.1:${String(portB)}/rooms/Room_A`);
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(await response.json(), {
    askedFrom: 'node-b',
    answer: { servedBy: 'node-a', echo: { type: 'ping' } },
  });

  // 关键证据：消息经真实网关 + gossip 发现，在 A 节点的 Actor 里执行过一次
  assert.deepStrictEqual(servedOnA, [{ type: 'ping' }], 'A 节点的 Actor 应恰好被调用一次');

  // 未发现的名字：明确 404 + Actor 名字进响应体，而不是不透明的 500
  // （这正是"发现未就绪/目标不存在"时调用方看到的东西）
  const missing = await fetch(`http://127.0.0.1:${String(portB)}/rooms/Room_Z`);
  assert.strictEqual(missing.status, 404);
  const body = (await missing.json()) as { error: { status: number; message: string } };
  assert.strictEqual(body.error.status, 404);
  assert.match(body.error.message, /Room_Z/, '404 应指名道姓，而不是 "internal error"');
});
