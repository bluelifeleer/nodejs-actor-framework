import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { clusterPlugin, createApp, defineApp, defineModule } from '../src/index.ts';

/**
 * `clusterPlugin` 的入口自理（DX 缺口）：装上插件就该能跨节点，
 * 不该要求用户去写 `app.kernel.listen(...)` 逃生通道。
 *
 * 真实跨节点的验收在 `packages/web/test/cluster-location-transparency.test.ts`；
 * 这里测的是本插件自己的契约：自动监听、地址可见、可关掉、配置可覆盖、重复 listen 不重复绑定。
 */

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actor-app-cluster-'));
}

/** 拿一个当前空闲的端口（用于断言"显式 gatewayPort 真的被用作绑定端口"）。 */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

const ECHO = { Echo: async (msg: unknown) => `echo:${String(msg)}` };

test('cluster: 默认自动启动网关，且地址可查（无需 app.kernel）', async () => {
  const cluster = clusterPlugin({ nodeId: 'auto', intervalMs: 50 });
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'm', actors: ECHO })], plugins: [cluster] }),
    { configDir: tempConfigDir(), env: {} },
  );

  // start() 之前没有任何监听
  assert.strictEqual(cluster.address(), null);
  assert.strictEqual(cluster.gossipAddress(), null);

  await app.start();
  try {
    const gateway = cluster.address();
    assert.ok(gateway, 'clusterPlugin 应在 onReady 自动启动网关');
    assert.strictEqual(gateway.host, '127.0.0.1', '默认绑定回环地址（安全默认）');
    assert.ok(gateway.port > 0, '默认端口 0 → 由系统分配，gossip 广播实际端口');

    const gossip = cluster.gossipAddress();
    assert.ok(gossip?.port, 'gossip 也应已监听');
    assert.notStrictEqual(gossip.port, gateway.port, '网关与 gossip 是两个不同的监听');

    // 视图可用（本节点自己的 Actor 不算"远端"）
    assert.deepStrictEqual(cluster.remoteActors(), []);
    assert.ok(Array.isArray(cluster.peers()));
  } finally {
    await app.stop();
  }

  // 停止后端口释放：再起一个应用不应因为端口占用而失败
  const again = clusterPlugin({ nodeId: 'auto-2', intervalMs: 50 });
  const app2 = createApp(
    defineApp({ modules: [defineModule({ name: 'm', actors: ECHO })], plugins: [again] }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app2.start();
  assert.ok(again.address()?.port, '第二个节点也应能自动起网关（默认端口不冲突）');
  await app2.stop();
});

test('cluster: autoListen:false 时不起网关；网关/视图未就绪时给出可执行的错误', async () => {
  // (a) 有 Actor ⇒ 内核插件已装上（gossip 在跑），只是网关没起
  const cluster = clusterPlugin({ nodeId: 'manual', autoListen: false, intervalMs: 50 });
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'm', actors: ECHO })], plugins: [cluster] }),
    { configDir: tempConfigDir(), env: {} },
  );

  await app.start();
  try {
    assert.strictEqual(cluster.address(), null, 'autoListen:false 时不应自动绑定网关');
    // gossip 与网关无关，仍然在跑（本地名册是给对端用的）
    assert.ok(cluster.gossipAddress()?.port, 'gossip 仍应监听');

    // 用户自己起网关（逃生通道）后即可跨节点
    const kernel = app.kernel as { listen(o: { host: string; port: number }): Promise<number> };
    const port = await kernel.listen({ host: '127.0.0.1', port: 0 });
    assert.ok(port > 0);
    assert.strictEqual(cluster.address(), null, 'address() 只报告**插件自己**绑定的网关');
    assert.deepStrictEqual(cluster.remoteActors(), []);
  } finally {
    await app.stop();
  }

  // (b) 没有 Actor 且不自动监听 ⇒ 内核插件根本没被装上：视图方法给出**可执行**的错误，
  //     而不是返回 undefined 之类的静默失败
  const idle = clusterPlugin({ nodeId: 'idle', autoListen: false, intervalMs: 50 });
  const idleApp = createApp(
    defineApp({ modules: [defineModule({ name: 'm' })], plugins: [idle] }),
    { configDir: tempConfigDir(), env: {} },
  );
  await idleApp.start();
  try {
    assert.strictEqual(idle.gossipAddress(), null);
    assert.throws(() => idle.remoteActors(), /集群尚未就绪.*app\.kernel\.listen/s);
  } finally {
    await idleApp.stop();
  }
});

test('cluster: 环境变量可覆盖 gatewayHost/gatewayPort/autoListen（一套配置体系）', async () => {
  const autoOff = clusterPlugin({ nodeId: 'env-off', intervalMs: 50 });
  const appOff = createApp(
    defineApp({ modules: [defineModule({ name: 'm', actors: ECHO })], plugins: [autoOff] }),
    { configDir: tempConfigDir(), env: { APP_PLUGINS__CLUSTER__AUTO_LISTEN: 'false' } },
  );
  await appOff.start();
  try {
    assert.strictEqual(autoOff.address(), null, 'APP_PLUGINS__CLUSTER__AUTO_LISTEN=false 应生效');
  } finally {
    await appOff.stop();
  }

  const port = await freePort();
  const explicit = clusterPlugin({ nodeId: 'env-port', intervalMs: 50 });
  const appPort = createApp(
    defineApp({ modules: [defineModule({ name: 'm', actors: ECHO })], plugins: [explicit] }),
    { configDir: tempConfigDir(), env: { APP_PLUGINS__CLUSTER__GATEWAY_PORT: String(port) } },
  );
  await appPort.start();
  try {
    assert.strictEqual(explicit.address()?.port, port, '配置里的端口应是真正绑定的端口');
  } finally {
    await appPort.stop();
  }
});

test('cluster: 显式 gatewayPort 被用作绑定端口；用户已 listen 时不重复绑定', async () => {
  const port = await freePort();
  const cluster = clusterPlugin({ nodeId: 'explicit', gatewayPort: port, intervalMs: 50 });
  const app = createApp(
    defineApp({ modules: [defineModule({ name: 'm', actors: ECHO })], plugins: [cluster] }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app.start();
  try {
    assert.strictEqual(cluster.address()?.port, port, 'gatewayPort 应是真正的绑定端口');
  } finally {
    await app.stop();
  }

  // 另一个应用：模块在 onStart 里自己先把网关起起来，插件的 onReady 不应重复绑定
  let manualPort = 0;
  const second = clusterPlugin({ nodeId: 'pre-listened', intervalMs: 50 });
  const app2 = createApp(
    defineApp({
      modules: [
        defineModule({
          name: 'm',
          actors: ECHO,
          async onStart(application) {
            const kernel = application.kernel as { listen(o: { host: string; port: number }): Promise<number> };
            manualPort = await kernel.listen({ host: '127.0.0.1', port: 0 });
          },
        }),
      ],
      plugins: [second],
    }),
    { configDir: tempConfigDir(), env: {} },
  );
  await app2.start();
  try {
    assert.ok(manualPort > 0);
    assert.strictEqual(second.address()?.port, manualPort, 'address() 应报告**实际**已绑定的端口');
  } finally {
    await app2.stop();
  }
});
