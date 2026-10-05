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
 * 应用层签名不暴露 listen/cluster（那是内核概念，见 app 层边界规则），因此与
 * `examples/game-cluster.js` 一样走 `app.kernel` 逃生通道显式启动网关。
 */

/** `app.kernel` 是逃生通道（unknown）：这里只声明本测试真正用到的内核面。 */
interface ClusterKernel {
  listen(options: { host?: string; port?: number }): Promise<number>;
  cluster: {
    port: number;
    waitFor(actorPath: string, timeoutMs?: number): Promise<unknown>;
    remoteActors(): string[];
    peers(): { lastSeen: number }[];
  };
}

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
      plugins: [clusterPlugin({ ...GOSSIP, nodeId: 'node-a' })],
    }),
    { configDir: tempConfigDir(), env: {} },
  );

  await appA.start();
  const kernelA = appA.kernel as ClusterKernel;
  await kernelA.listen({ host: '127.0.0.1', port: 0 });
  const gossipA = kernelA.cluster.port;
  assert.ok(gossipA > 0, 'A 节点的 gossip 应已监听（否则 B 无从发现）');

  // B 节点：只有控制器，**本地没有 Room_A**（"接入/边缘节点"）
  const httpB = httpPlugin({ port: 0, accessLog: false });
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
      plugins: [
        httpB,
        clusterPlugin({ ...GOSSIP, nodeId: 'node-b', seeds: [{ host: '127.0.0.1', port: gossipA }] }),
      ],
    }),
    { configDir: tempConfigDir(), env: {} },
  );

  t.after(async () => {
    await appB.stop();
    await appA.stop();
  });

  await appB.start();
  const kernelB = appB.kernel as ClusterKernel;
  await kernelB.listen({ host: '127.0.0.1', port: 0 });

  // 发现是**最终一致**的：先等 gossip 把 A 的名册带到 B，再看 HTTP 行为
  await kernelB.cluster.waitFor('Room_A', 10_000);
  assert.ok(
    kernelB.cluster.remoteActors().includes('Room_A'),
    'B 的索引里应有远端 Room_A（而不是本地）',
  );
  assert.ok(
    kernelB.cluster.peers().some((peer) => peer.lastSeen > 0),
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
