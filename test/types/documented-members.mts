/**
 * 编译期验证（`npm run typecheck` 的一部分）：**文档里用到的公开成员**在 `index.d.ts` 里真的存在、类型也说得通。
 *
 * 为什么单独一份：公开面门禁（`test/unit-kernel-surface.test.js`）只能做文本级的"名字在不在"，
 * 而这里让 TypeScript 真正去编译这些用法 —— 审计发现 `ctx.sleep` / `spawn(def, { rateLimit })` /
 * `cluster.drain()` 这些成员过去**完全不在**声明里，使用者照文档写就直接报类型错误。
 *
 * 本文件只做类型检查，不执行（tsconfig.types.json 专门把包名映射到 index.d.ts）。
 */
import { Actor, createSystem, plugins } from 'nodejs-actor-framework';
import type { ActorContext, ActorRef, ActorSystem, ClusterService, SystemOptions } from 'nodejs-actor-framework';

// --- ActorContext：可注入时钟与 sleep（M5 时钟接缝）-----------------------------
class Ticking extends Actor<{ at: number }> {
  override preStart(): void {
    this.state = { at: 0 };
  }
  override async receive(_msg: unknown, ctx: ActorContext<{ at: number }>): Promise<number> {
    // 文档里用到的两个成员（审计发现它们过去完全不在声明面里）
    const now: number = ctx.clock.now();
    await ctx.sleep(10);
    return now;
  }
}

// --- ActorOptions：限流 / 不可迁移 ---------------------------------------------
const options = {
  id: 'limited',
  rateLimit: { capacity: 10, rate: 5 },
  transferable: false,
  mailbox: { maxSize: 100, overflow: 'drop-oldest' as const },
  supervision: { strategy: 'one_for_one' as const, maxRestarts: 3, withinSeconds: 5 },
};

// --- SystemOptions：时钟 / spanSink / maxPeers ----------------------------------
const systemOptions: SystemOptions = { name: 'typed', maxPeers: 64 };
const system: ActorSystem = createSystem(systemOptions);

// --- 文档里出现的 system 成员 ---------------------------------------------------
const capabilities = system.persistenceCapabilities();
const conditional: string | false = capabilities.conditionalAppend;
const ownership = system.ownership;
const ownerOfShard: string | null = ownership === null ? null : ownership.ownerOf(0);
const peerLimit: number = system.maxPeers;
const stopping: Promise<void> = system.stop({ timeoutMs: 1000 });

// --- 文档里出现的集群治理成员（M4）---------------------------------------------
const cluster: ClusterService | null = system.cluster;
if (cluster !== null) {
  const drainResult: Promise<Record<string, unknown>> = cluster.drain({ timeoutMs: 500, stopActors: false });
  cluster.assertWritable();
  const fencing: unknown = cluster.fencing();
  const metrics: unknown = cluster.metrics();
  const quorum: unknown = cluster.quorum();
  const singletons: Array<{ id: string; owner: string | null; local: boolean }> = cluster.singletons();
  const owner: string | null = cluster.ownerOfActor('player_1');
  const one: Promise<{ id: string; local: boolean; owner: string | null }> = cluster.spawnSingleton(Ticking, { id: 'singleton' });
  const ref: ActorRef | null = cluster.ownership.ownerOf(1) === null ? null : system.resolve('singleton');
  void [drainResult, fencing, metrics, quorum, singletons, owner, one, ref];
}

// --- 集群插件选项（文档里的 shardCount / 策略开关）-----------------------------
const clusterPlugin = plugins.cluster({
  nodeId: 'node-a',
  host: '127.0.0.1',
  port: 0,
  shardCount: 8,
  requireFencing: true,
  enforceQuorum: false,
  recreate: (path: string) => (path === 'x' ? { definition: Ticking, options: { id: 'x' } } : null),
});

void [options, conditional, ownerOfShard, peerLimit, stopping, clusterPlugin];
