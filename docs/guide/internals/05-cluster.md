# 5. 集群

集群能力分两半：**发现**（按名字找到 Actor）与**治理**（谁拥有、怎么交接、少数派怎么办）。
用户侧只有一个开关：装 `clusterPlugin`（`@actor/app`）。

```ts
// app.ts
import { createApp, defineApp, clusterPlugin } from '@actor/app';

const app = defineApp({
  modules: [/* ... */],
  plugins: [
    clusterPlugin({
      nodeId: 'node-a',            // 默认取 system.name
      port: process.env.GOSSIP_PORT ? Number(process.env.GOSSIP_PORT) : 0, // 0 = 随机（测试/本机）
      seeds: ['10.0.0.1:7946'],     // 至少一个已知节点
      shardCount: 256,              // **运维常量**：改它等于全量重分布
      intervalMs: 1000,
      peerTimeoutMs: 6000,
    }),
  ],
});
```

装好之后，`system.resolve('room-1')` 在本地找不到时会去集群索引里找（懒连接，第一次用才拨号）。

## 发现 + 所有权 + 交接（真的会跑）

```js verify
import assert from 'node:assert';
import { createSystem, plugins, ring } from 'nodejs-actor-framework';

const SHARDS = 256;
const [gossipPort, portA, portB] = [17946, 0, 0];

const mk = (id, seeds) =>
  createSystem({
    name: id,
    logger: false,
    plugins: [plugins.cluster({ nodeId: id, port: seeds.length === 0 ? gossipPort : 0, shardCount: SHARDS, intervalMs: 100, seeds })],
  });

const a = mk('node-a', []);
const b = mk('node-b', [`127.0.0.1:${gossipPort}`]);
try {
  await a.listen({ host: '127.0.0.1', port: portA });
  await b.listen({ host: '127.0.0.1', port: portB });

  // 1) 成员视图收敛（所有权是"成员视图的纯函数"，视图不一致什么都别谈）
  const deadline = Date.now() + 15_000;
  while (!(a.cluster.nodes().length === 2 && b.cluster.nodes().length === 2) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepStrictEqual([...a.cluster.nodes()].sort(), ['node-a', 'node-b']);

  // 2) 按名字发现并跨节点调用：a 上的 Actor，b 直接 ask（没有 host:port）
  await a.spawn({ preStart() {}, receive: () => 'from-a' }, { id: 'greeter' });
  const found = await b.cluster.waitFor('greeter', 15_000);
  assert.strictEqual(found.nodeId, 'node-a');
  assert.strictEqual(await b.resolve('greeter').ask('hi'), 'from-a');

  // 3) 所有权是**本地确定性算**的：两边算出同一个 owner
  const r = ring.createRing(['node-a', 'node-b']);
  const shard = ring.shardOf('greeter', SHARDS);
  assert.strictEqual(a.cluster.ownerOfActor('greeter'), b.cluster.ownerOfActor('greeter'));
  assert.strictEqual(a.cluster.ownerOfActor('greeter'), ring.ownerOfShard(r, shard));

  // 4) 降级与拒绝**可见**（软升级：对端不支持 fencing 时放行，但计数 +1）
  const metrics = a.cluster.metrics();
  assert.deepStrictEqual(Object.keys(metrics.fencing).sort(), [
    'conflicts', 'handedOver', 'promoted', 'rejected', 'skipped',
  ]);

  // 5) 多数派：两个都在 → 多数派
  assert.deepStrictEqual(a.cluster.quorum(), { live: 2, highWater: 2, ok: true });

  // 6) 优雅离场：交出自己拥有的 shard，并**告诉对端该找谁**（重定向，不是静默丢弃）
  await a.spawn({ preStart() {}, receive: () => 'still-a' }, { id: 'mover' });
  const summary = await a.cluster.drain({ timeoutMs: 2000 });
  assert.strictEqual(summary.nodeId, 'node-a');
  assert.strictEqual(summary.timedOut, false, '排空没有超时');
  assert.ok(summary.shards.length > 0, '交出了它拥有的 shard');
  for (const moved of summary.shards) assert.ok(['node-b', null].includes(moved.to));
  assert.strictEqual(a.cluster.fencing().handedOver, true);
} finally {
  await b.stop();
  await a.stop();
}
console.log('ok');
```

## 用户要记住的四条

| 事项 | 说明 |
|---|---|
| **`shardCount` 是运维常量** | 改它 = 全量重分布。所有节点必须一致：不一致会**直接拒绝连接**（算错 shard 比拒连接危险得多） |
| **存储要共享** | 优雅交接靠"新 owner 用同一份存储恢复"（快照 + 事件）。节点本地存储上的 Actor 交接不了，必须声明 `transferable: false` |
| **不可迁移的 Actor 要声明** | `spawn(def, { transferable: false })`：持有 socket/文件句柄的 Actor 在离场时**明确失败**（列进 `drain()` 的 `untransferable`），客户端重连——不假装能迁 socket |
| **单例是"尽力而为"** | `cluster.spawnSingleton(def, { id })`：每个节点都登记，只有 owner 真的运行。接管有延迟，**它不是分布式锁** |

## 诚实边界（来自实测，不是设计口号）

- **fencing 收窄窗口，不消灭窗口**：所有节点都用同一份成员视图时，环 + epoch 能挡住旧 owner；
  但**双方视图都还没更新**时本地无法识别旧的（有测试专门把这条"放行"断言下来）。
  要更强保证得引入共识——本项目明确不做（见 [M4 设计 §3.3](../../design/m4-cluster-governance.md)）。
- **声明不做签名**：`observe` 不校验声明者身份（否则接管会被挡住）。身份边界由 TLS 与成员准入负责，
  gossip 是**信任域内**协议。
- **故障路径没有交接**：崩溃的节点不会交接（内存里的在途消息就是丢了），只能靠状态恢复 + 业务幂等。
  优雅离场（`drain()`）与崩溃是**两档质量**，别混为一谈。

下一步：[怎么测](./06-testing.md)。
