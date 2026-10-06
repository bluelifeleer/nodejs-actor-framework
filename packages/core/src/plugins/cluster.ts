// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const config = require('../config.ts');
const Gossip = require('../cluster/gossip.ts');
const ringUtil = require('../cluster/ring.ts');
const { createOwnershipGuard } = require('../cluster/ownership.ts');
const { ActorStoppedError } = require('../actor/errors.ts');

/**
 * Cluster plugin: gossip-based discovery so an actor can be reached by **name**
 * instead of a hard-coded host:port.
 *
 * When installed, `system.resolve('some/actor')` falls back to the cluster
 * index and returns a ref that connects lazily. So this works unchanged:
 *
 *   await a.spawn(Player, { id: 'player_001' });              // node A
 *   await b.resolve('player_001').ask({ type: 'hurt' });       // node B, no host:port
 *   await ctx.ask('player_001', msg);                          // from inside an actor
 *   //（注意：系统级没有 `b.ask(path, msg)`——那句话曾经写在本注释里，是错的。）
 *
 * Discovery is eventually consistent: a brand new actor becomes resolvable once
 * a gossip round has carried it to the peer.
 */

/** gossip 里记下的一条 actor 位置。 */
interface ActorMeta {
  host: string;
  gatewayPort: number;
  nodeId?: string | null;
  /** M4 第 5 步：这条 actor 记录是否声明"可迁移"（交接用）。 */
  transferable?: boolean;
  [key: string]: unknown;
}

/** 连接到一个 peer 后的能力（system.connect 的返回值）。 */
interface PeerLike {
  ref(path: string): {
    tell(msg: unknown, sender?: unknown, trace?: unknown): boolean;
    ask(msg: unknown, timeoutMs?: number, sender?: unknown, trace?: unknown): Promise<unknown>;
    stop(): Promise<void>;
  };
}

/** 结构型 system 视图（内核是 CJS，不能 import type）。 */
interface ClusterSystem {
  readonly name: string;
  /**
   * 应用层在启动后装上的所有权服务：集群插件会写入 shardCount/requireFencing/guard，
   * 并读取 `recreate`（"把某条 Actor 在原定义上重建"的钩子）。
   */
  ownership: {
    recreate?: (path: string) => { definition: unknown; options?: Record<string, unknown> } | null;
    shardCount?: number;
    requireFencing?: boolean;
    guard?: unknown;
    [key: string]: unknown;
  } | null;
  server: {
    boundPort: number;
    on?(event: string, handler: (...args: never[]) => void): void;
    /** 在途请求数（优雅离场时排空用）。 */
    inflight?(): number;
    /** 内部标记：fencing 事件只接一次。 */
    __fencingWired?: boolean;
  } | null;
  readonly cells: Map<
    string,
    {
      path: string;
      ref: { path?: string; id?: string; stop?(): Promise<void> };
      stopped?: boolean;
      transferable?: boolean;
      saveSnapshot?(): Promise<void>;
      _init?: () => Promise<void>;
    }
  >;
  cluster: unknown;
  connect(options: { host: string; port: number }): Promise<PeerLike>;
  spawn(definition: unknown, options?: Record<string, unknown>): Promise<{ path: string }>;
  resolve(target: string): unknown;
  stop(target?: unknown): Promise<void>;
  on(event: string, handler: (...args: never[]) => void): void;
  off(event: string, handler: (...args: never[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  _log(event: string, meta?: Record<string, unknown>): void;
}

/** gossip 的接口（cluster/gossip.ts 的 Gossip）。 */
interface GossipLike {
  readonly nodeId: string;
  readonly host: string;
  readonly advertiseHost: string;
  readonly port: number;
  boundPort: number;
  readonly intervalMs: number;
  readonly peerTimeoutMs: number;
  readonly codec: number;
  readonly seeds: unknown[];
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  setLocal(key: string, value: unknown): void;
  delLocal(key: string): void;
  on(event: string, handler: (...args: never[]) => void): void;
  info(): Record<string, unknown>;
  pruneStaleNodes(now?: number): string[];
}

/** registry 记录（LWW）。 */
interface RegistryEntry {
  key: string;
  value: unknown;
  ts: number;
  nodeId: string;
  deleted?: boolean;
}

/** 插件配置。 */
interface ClusterPluginOptions {
  /** 重建钩子（测试/嵌入式用；应用层也可以装到 `system.ownership.recreate`）。 */
  recreate?: (path: string) => { definition: unknown; options?: Record<string, unknown> } | null;
  onShardsPromoted?: (shard: number, previousOwner: string | null) => void;
  requireFencing?: boolean;
  nodeId?: string;
  port?: number;
  host?: string;
  advertiseHost?: string;
  seeds?: (string | { host: string; port: number })[];
  intervalMs?: number;
  peerTimeoutMs?: number;
  tls?: unknown;
  codec?: number | string;
  gatewayPort?: number | null;
  shardCount?: number;
  [key: string]: unknown;
}

/** A remote actor found through gossip; connects on first use. */
class DiscoveredRef {
  readonly system: ClusterSystem;
  readonly _path: string;
  readonly host: string;
  readonly gatewayPort: number;
  readonly nodeId: string | null;
  _peer: PeerLike | null;

  constructor(system: ClusterSystem, path: string, meta: ActorMeta) {
    this.system = system;
    this._path = String(path);
    this.host = meta.host;
    this.gatewayPort = meta.gatewayPort;
    this.nodeId = meta.nodeId || null;
    this._peer = null;
  }

  get id(): string | undefined {
    const parts = this._path.split('/');
    return parts[parts.length - 1];
  }

  get path(): string {
    return this._path;
  }

  get isLocal(): boolean {
    return false;
  }

  async _resolvePeer(): Promise<PeerLike> {
    if (this._peer !== null) return this._peer;
    this._peer = await this.system.connect({ host: this.host, port: this.gatewayPort });
    return this._peer;
  }

  tell(msg: unknown, sender?: unknown, trace?: unknown): boolean {
    this._resolvePeer()
      .then((peer) => peer.ref(this._path).tell(msg, sender, trace))
      .catch((err: unknown) => {
        // Fire-and-forget failures have no caller to reject, so make them
        // observable through both the log and an event.
        this.system._log('cluster_tell_failed', { path: this._path, err: err instanceof Error ? err.message : String(err) });
        this.system.emit('remote_tell_failed', this._path, err);
      });
    return true; // handed to the (lazy) transport
  }

  async ask(msg: unknown, timeoutMs?: number, sender?: unknown, trace?: unknown): Promise<unknown> {
    const peer = await this._resolvePeer();
    return peer.ref(this._path).ask(msg, timeoutMs, sender, trace);
  }

  async stop(): Promise<void> {
    const peer = await this._resolvePeer();
    return peer.ref(this._path).stop();
  }

  inspect(): never {
    throw new ActorStoppedError(
      `inspect() is local-only; "${this._path}" was discovered on ${this.nodeId || `${this.host}:${this.gatewayPort}`}`,
    );
  }

  state(): Promise<never> {
    return Promise.reject(new ActorStoppedError('state() is local-only for a discovered actor'));
  }

  toString(): string {
    return `DiscoveredRef(${this._path}@${this.nodeId || `${this.host}:${this.gatewayPort}`})`;
  }
}

function cluster(options: ClusterPluginOptions = {}) {
  const index = new Map<string, ActorMeta>(); // actor path -> 位置

  return {
    name: 'cluster',

    async setup(system: ClusterSystem) {
      const gossip: GossipLike = new Gossip(options.nodeId ?? system.name, options.port === undefined ? 0 : options.port, {
        host: options.host || config.gossip.host,
        advertiseHost: options.advertiseHost || config.gossip.advertiseHost,
        seeds: options.seeds || config.gossip.seeds,
        intervalMs: options.intervalMs || config.gossip.intervalMs,
        peerTimeoutMs: options.peerTimeoutMs || config.gossip.peerTimeoutMs,
        tls: options.tls || config.tls,
        codec: options.codec || config.gossip.codec,
      });

      const gatewayPort = () => (system.server ? system.server.boundPort : (options.gatewayPort ?? null));

      // ---- fencing / 分片所有权（M4 第 2b 步）--------------------------------
      // 谁拥有哪个 shard：用 gossip 的成员视图**本地确定性算**（D1，不共识）。
      // epoch：本节点只在自己确实是 owner 时给出声明（claimFor，不自封）。
      const shardCount: number = Number.isInteger(options.shardCount) ? (options.shardCount as number) : 256;
      const guard = createOwnershipGuard({ nodeId: gossip.nodeId, shardCount });
      const fencingStats = { skipped: 0, rejected: 0, conflicts: 0 };

      /**
       * 声明怎么走 gossip：**每个节点一条**注册表条目（`shard-claims:<nodeId>`）里放
       * `{ [shard]: epoch }` 的映射，而不是"一个 shard 一条"——后者会让 256 个 shard 变成
       * 256 条注册表记录，每一轮 gossip 都要把它们全带上（注册表是整体复制的）。
       *
       * 发布时机：**按需**（本节点真的要为某个 shard 声明所有权时才发布它）。这样声明数量被
       * "实际用到的 shard"自然限制住，而不是一上来就 256 条。
       */
      const CLAIM_PREFIX = 'shard-claims:';
      const publishedClaims = new Map();
      let claimsDirty = false;

      const publishClaims = () => {
        gossip.setLocal(`${CLAIM_PREFIX}${gossip.nodeId}`, {
          type: 'shard-claims',
          nodeId: gossip.nodeId,
          claims: Object.fromEntries(publishedClaims),
          ts: Date.now(),
        });
        claimsDirty = false;
      };

      /** 记住"我声明过这个 shard 的第几代"，有变化才重新发布。 */
      const rememberClaim = (shard: number, epoch: number): void => {
        if (publishedClaims.get(shard) === epoch) return;
        publishedClaims.set(shard, epoch);
        claimsDirty = true;
      };

      /**
       * 环 = 成员视图的纯函数，缓存只是优化。所以**按需刷新**（而不是只靠事件）：
       * 事件可能漏掉"新节点加入"，而所有权判断容不得用旧视图（那正是"未收敛窗口"）。
       * 用成员集合的签名避免无谓重建。
       */
      let membersKey: string | null = null;
      let previousRing: ReturnType<typeof ringUtil.createRing> | null = null;
      /** 已宣布离场的节点（含本节点在 drain() 时宣布的）：环要立刻排除它们。 */
      const leaving = new Set();
      const leavingKey = 'leaving:';
      const ADOPT_PREFIX = 'adopt:';
      const takeover: { promoted: number; shards: number[] } = { promoted: 0, shards: [] };
      let singletonsPromoted = false;
      let promotedThisPass = false;
      /** 接管统计（第 6 步的指标也从这里读）。 */
      const adoption = { adopted: 0, skipped: 0, failed: 0 };
      /**
       * 多数派判据（第 5 步，已确认的 D4）：`2 * live > highWater`。
       *
       * `highWater` = 本节点**见过的最多成员数**（高水位），这样"我们曾经是 3 个，现在只剩我 1 个"
       * 会被判成少数派；而一个刚启动、只见过自己的节点不会误判（1*2 > 1）。
       * 判据刻意简单：越简单越不容易在分区里出现"两边都以为自己是多数派"。
       */
      let highWater = 1;
      const quorumState = (): { live: number; highWater: number; ok: boolean } => {
        const nodes = (gossip.info().nodes ?? []) as string[];
        const live = Math.max(1, nodes.filter((node: string) => !leaving.has(node)).length);
        highWater = Math.max(highWater, live);
        return { live, highWater, ok: live * 2 > highWater };
      };

      /** 单例（第 4 步）：每个节点都登记定义，只有 owner 真的运行。 */
      const singletons = new Map<string, { definition: unknown; options?: Record<string, unknown> }>();
      /** 一条离开/超时事件带来的"待接管 Actor"（在注册表被清掉之前先记下来）。 */
      let pendingAdoptions: { path: string; shard: number; from: string }[] = [];

      /** 环变化前先记下"原主人交出来的、且落到我们头上的、可迁移的" Actor。 */
      const collectAdoptions = (departingNode: string): void => {
        for (const [path, value] of index) {
          if (!value || value.nodeId !== departingNode) continue;
          if (value.transferable === false) {
            adoption.skipped += 1;
            system._log('cluster_adoption_skipped', { path, reason: 'transferable: false' });
            continue;
          }
          const shard = ringUtil.shardOf(String(path), shardCount);
          pendingAdoptions.push({ path: String(path), shard, from: departingNode });
        }
      };

      /**
       * 单例（第 4 步）：**每个节点都调用** `spawnSingleton` 登记定义，只有单例 shard 的 owner
       * 真正运行它。它不是一个分布式锁——是"尽力而为的单例"（doc 05 §1.4）。
       */
      const SINGLETON_SHARD = 0;
      const adoptSingletons = async () => {
        for (const [id, spec] of singletons) {
          const runsHere = guard.ownerOf(SINGLETON_SHARD) === gossip.nodeId;
          const running = system.cells.has(id);
          if (runsHere && !running) {
            try {
              await system.spawn(spec.definition, { id, ...(spec.options || {}) });
              adoption.adopted += 1;
              system.emit('cluster_singleton_started', id);
            } catch (err) {
              adoption.failed += 1;
              system._log('cluster_singleton_start_failed', { id, err: err instanceof Error ? err.message : String(err) });
            }
          } else if (!runsHere && running) {
            // 不再是 owner：停掉本地实例（新 owner 会起来）
            const existing = system.cells.get(id);
            const ref = existing?.ref as { stop(): Promise<void> } | undefined;
            if (ref !== undefined) await ref.stop().catch(() => undefined);
            system.emit('cluster_singleton_stopped', id);
          }
        }
      };

      /** 环更新之后：把落到我们头上的 Actor 用**同一个定义**重建（状态从共享存储恢复）。 */
      const adoptPending = async (): Promise<void> => {
        if (pendingAdoptions.length === 0) return;
        const adoptions = pendingAdoptions;
        pendingAdoptions = [];
        const stillPending: { path: string; shard: number; from: string }[] = [];
        for (const item of adoptions) {
          if (guard.ownerOf(item.shard) !== gossip.nodeId) {
            stillPending.push(item); // 环还没更新到"归我"：留着等下一次提升，别丢
            continue;
          }
          if (system.cells.has(item.path)) continue; // 已经在了（比如是本地的）
          // 重建钩子可以来自插件配置（测试/嵌入式）或 system.ownership（应用层启动后装上）
          const recreate =
            typeof options.recreate === 'function'
              ? options.recreate
              : system.ownership && typeof system.ownership.recreate === 'function'
                ? system.ownership.recreate
                : null;
          const recreated = recreate === null ? null : (recreate as (path: string) => { definition: unknown; options?: Record<string, unknown> } | null)(item.path);
          if (!recreated || !recreated.definition) {
            adoption.failed += 1;
            system._log('cluster_adoption_no_definition', { path: item.path });
            continue;
          }
          try {
            await system.spawn(recreated.definition, { id: item.path, ...(recreated.options || {}) });
            adoption.adopted += 1;
            system.emit('cluster_actor_adopted', item.path, item.from);
          } catch (err) {
            adoption.failed += 1;
            system._log('cluster_adoption_failed', { path: item.path, err: err instanceof Error ? err.message : String(err) });
          }
        }
        if (stillPending.length > 0) pendingAdoptions.push(...stillPending);
      };
      /** 一旦开始离场就永久冻结：这是"不再双主"的关键——旧 owner 主动停止服务。 */
      let handingOver = false;

      /**
       * 环 = 成员视图（**排除离场者**）的纯函数。离场用一条注册表标记表达，
       * 于是"节点要走了"这件事在**所有节点上确定性可见**，不必等心跳超时。
       */
      const refreshRing = (force = false): ReturnType<typeof guard.updateRing> => {
        // 离场者（**包括本节点自己在 drain 时**）一律排除：否则离场节点算出的新 owner 还是它自己。
        // 成员可能变成空集（单节点集群离场）——那也是有效状态：此时 owner 为 null（没人接管）。
        const members = ((gossip.info().nodes ?? []) as string[]).filter((node: string) => !leaving.has(node));
        const key = [...members].sort().join(',');
        if (!force && key === membersKey) return;
        membersKey = key;
        const next = guard.updateRing(members);
        // 环变了 → 落到我们头上的 shard 要**自动加代**（epoch = 已知最大 + 1）并发布。
        // 这就是"故障/离场接管"的 epoch 归属：新 owner 自己加代，旧 owner 的消息随即失效。
        if (previousRing !== null) {
          for (const shard of ringUtil.changedShards(previousRing, next, shardCount)) {
            if (guard.ownerOf(shard) !== gossip.nodeId) continue;
            const known = guard.bestClaim(shard);
            const epoch = (known === null ? 0 : known.epoch) + 1;
            guard.observe({ shard, ownerNodeId: gossip.nodeId, epoch, at: Date.now() });
            rememberClaim(shard, epoch);
            takeover.promoted += 1;
            takeover.shards.push(shard);
            // 通知上层（应用层在这里把 Actor 在新的 owner 上重建）
            if (typeof options.onShardsPromoted === 'function') {
              try {
                options.onShardsPromoted?.(shard, previousRing !== null ? ringUtil.ownerOfShard(previousRing, shard) : null);
              } catch (err) {
                system._log('cluster_on_shards_promoted_failed', { shard, err: err instanceof Error ? err.message : String(err) });
              }
            }
            if (shard === SINGLETON_SHARD) singletonsPromoted = true;
            promotedThisPass = true;
          }
          if (claimsDirty) publishClaims();
        }
        previousRing = next;
        // 环把某个 shard 提升给我 → 这就是接管的权威信号（清单只是"有哪些 Actor 要接"的提示）
        if (promotedThisPass) {
          promotedThisPass = false;
          void adoptPending().catch((err: unknown) =>
          system._log('cluster_adoption_error', { err: err instanceof Error ? err.message : String(err) }),
        );
        }
        // 单例：本节点是否接管了单例 shard
        // 单例：环一变就要重新判断"我该不该跑它"——既有提升（成为 owner）也有**降级**（离场时
        // 失去 owner 身份必须停掉本地实例，否则会出现两个实例）。refreshRing 是同步的，所以异步做。
        if (singletons.size > 0) {
          void adoptSingletons().catch((err) =>
            system._log('cluster_singleton_adoption_error', { err: err && err.message }),
          );
        }
        // 普通 Actor 的接管（异步，不阻塞环刷新）
        void adoptPending().catch((err: unknown) =>
          system._log('cluster_adoption_error', { err: err instanceof Error ? err.message : String(err) }),
        );
        return next;
      };

      system.ownership = {
        shardCount,
        requireFencing: options.requireFencing === true,
        guard,
        ...(options.recreate === undefined ? {} : { recreate: options.recreate }),
        /** 出站：只有本节点**确实是**这个 shard 的 owner 时才给出 epoch（否则不带字段）。 */
        epochFor(path: string): number | null {
          if (handingOver) return null; // 离场中：不再为任何 shard 背书
          refreshRing();
          const shard = ringUtil.shardOf(String(path), shardCount);
          const claim = guard.claimFor(shard);
          if (claim === null) return null;
          rememberClaim(shard, claim.epoch);
          if (claimsDirty) publishClaims(); // 按需发布：只发我们真的用到的 shard
          return claim.epoch;
        },
        /** 入站判定：见 docs/design/m4-cluster-governance.md §3.4.5 的三条规则。 */
        verifyIncoming({
          targetActorId,
          shardEpoch,
          peerNodeId,
          peerSupportsFencing,
        }: {
          targetActorId?: string;
          shardEpoch?: number;
          peerNodeId?: string;
          peerSupportsFencing?: boolean;
        }): { ok: boolean; reason?: string } {
          if (!targetActorId) return { ok: true };
          refreshRing();
          const shard = ringUtil.shardOf(String(targetActorId), shardCount);
          // 服务时也把"我是这个 shard 的第几代"公之于众：否则一个只被调用、从不主动发送的节点
          // 永远不发布声明，接管方就不知道旧 epoch（那时它只能从 1 开始）。
          if (guard.ownerOf(shard) === gossip.nodeId && !handingOver) {
            const own = guard.claimFor(shard);
            if (own !== null) {
              rememberClaim(shard, own.epoch);
              if (claimsDirty) publishClaims();
            }
          }
          if (options.enforceQuorum === true) {
            const quorum = quorumState();
            if (!quorum.ok) {
              return {
                ok: false,
                reason:
                  `quorum：本节点处于少数派（live ${quorum.live} / highWater ${quorum.highWater}），` +
                  '拒绝写入（503 语义：请重试到多数派）',
              };
            }
          }
          if (handingOver) {
            // 冻结：本节点已经在离场，属于这些 shard 的请求一律拒绝，并告诉对端该找谁
            return {
              ok: false,
              reason:
                `fencing：${gossip.nodeId} 正在离场，shard ${shard} 现在归 ${guard.ownerOf(shard) ?? '(未知)'}` +
                '——请刷新成员视图后重试（这不是丢消息，是重定向）',
            };
          }
          if (shardEpoch === null) {
            // 没有 token 的三种情况：
            //   ① 转发者（不是这个 shard 的 owner）——合法，本来就没 token 可带；
            //   ② **声明支持 fencing 的成员**却不带 token —— 说明它拿的是旧视图，拒绝让它重新同步；
            //   ③ 不支持 fencing 的成员（老版本节点、控制台这类只连网关的工具）——放行，但网关会发
            //      `fencing_skipped`（降级必须可见）。**不能因为"它是成员"就一律要 token**，
            //      否则没跑所有权插件的成员会被一脚踢出集群（真踩过：控制台集成测试当场红）。
            if (peerSupportsFencing === true && guard.ownerOf(shard) === peerNodeId && guard.isMember(peerNodeId)) {
              return {
                ok: false,
                reason:
                  `fencing：${peerNodeId} 是本节点认为的 shard ${shard} owner，却没有带 shardEpoch` +
                  '（旧视图？请重新同步成员视图后重试）',
              };
            }
            return { ok: true };
          }
          const verdict = guard.verify({ shard, ownerNodeId: peerNodeId, epoch: shardEpoch });
          return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
        },
      };

      /** 把一条本地 Actor 的位置（含可迁移性）写进 gossip 注册表。 */
      const announce = (ref: { path: string; id: string }): void => {
        const cell = system.cells.get(ref.path) || system.cells.get(ref.id);
        gossip.setLocal(ref.path, {
          type: 'actor',
          nodeId: gossip.nodeId,
          actorId: ref.path,
          host: gossip.advertiseHost,
          gatewayPort: gatewayPort(),
          // 可迁移性随注册表一起传播：接管方据此决定"要不要接手这个 Actor"
          transferable: cell ? cell.transferable !== false : true,
        });
      };

      const onRegistered = (ref: { path: string; id: string }): void => announce(ref);
      const onStopped = (path: string): void => gossip.delLocal(String(path));
      const onListening = (): void => {
        // The gateway port is only known after listen(): re-announce so peers
        // get a reachable address.
        for (const cell of system.cells.values()) if (cell.stopped !== true) announce(cell.ref as { path: string; id: string });
        refreshRing();
        // 降级与拒绝必须**可见**（软升级策略的前提）：计数从网关事件来
        const server = system.server;
        if (server !== null && typeof server.on === 'function' && server.__fencingWired !== true) {
          server.__fencingWired = true;
          server.on('fencing_skipped', () => {
            fencingStats.skipped += 1;
          });
          server.on('ownership_rejected', () => {
            fencingStats.rejected += 1;
          });
        }
      };
      const onUpdate = (key: string, value: unknown): void => {
        if (key.startsWith('subs:')) return;
        refreshRing(); // 成员视图可能变了（谁在环上决定所有权）
        // registry 的值是异构 JSON（actor 位置 / 接管清单 / shard 声明 / 离场标记），
        // 这里按 `type` 判别；判别不上的**直接忽略**（别猜），与 gossip 的容错策略一致。
        const entry = (value ?? {}) as {
          type?: string;
          nodeId?: string;
          ts?: number;
          actors?: { path?: unknown; shard?: unknown; transferable?: unknown }[];
          claims?: Record<string, number>;
        };
        if (key.startsWith(ADOPT_PREFIX)) {
          // 离场方给出的接管清单：落到我们头上的（且可迁移的）Actor 由我们重建
          if (entry.type === 'adoption-manifest' && Array.isArray(entry.actors)) {
            for (const actor of entry.actors) {
              if (!actor || typeof actor.path !== 'string') continue;
              if (actor.transferable === false) {
                adoption.skipped += 1;
                system._log('cluster_adoption_skipped', { path: actor.path, reason: 'transferable: false' });
                continue;
              }
              pendingAdoptions.push({ path: actor.path, shard: Number(actor.shard), from: entry.nodeId ?? '' });
            }
            // **先刷新环再接管**：清单与离场标记常常同一轮到达，谁接手取决于环更新之后的结果；
            // 顺序反了会因为"这个 shard 还不归我"而把条目一直挂着（靠环提升时再兜住）。
            refreshRing();
            void adoptPending().catch((err: unknown) =>
          system._log('cluster_adoption_error', { err: err instanceof Error ? err.message : String(err) }),
        );
          }
          return;
        }
        if (key.startsWith(leavingKey)) {
          // 有人宣布离场：立刻把它从环里去掉（确定性），并重算（会触发新 owner 加代）
          if (value === true || entry.type === 'leaving') {
            const departing = key.slice(leavingKey.length);
            leaving.add(departing);
            if (departing !== gossip.nodeId) {
              collectAdoptions(departing); // 注册表被清掉之前先记下来
              refreshRing();
            }
          }
          return;
        }
        if (key.startsWith(CLAIM_PREFIX)) {
          // 对端的声明：epoch 更高 = 所有权换代；同 epoch 换人 = **双主声明**，必须报出来
          if (entry.type === 'shard-claims' && entry.claims !== undefined) {
            for (const [shardText, epoch] of Object.entries(entry.claims)) {
              const result = guard.observe({
                shard: Number(shardText),
                ownerNodeId: entry.nodeId ?? key.slice(CLAIM_PREFIX.length),
                epoch: Number(epoch),
                at: entry.ts ?? Date.now(),
              });
              if (!result.accepted && String(result.reason).includes('双主声明')) {
                fencingStats.conflicts += 1;
                system._log('cluster_shard_claim_conflict', { shard: Number(shardText), reason: result.reason });
              }
            }
          }
          return;
        }
        if (entry.type !== 'actor') return;
        index.set(key, entry as ActorMeta);
      };
      const onDelete = (key: string): void => {
        if (key.startsWith('subs:')) return;
        index.delete(key);
      };
      const onNodeTimeout = (nodeId: string): void => {
        collectAdoptions(nodeId); // 故障路径：没有优雅交接，靠状态恢复（doc 05 §1.3）
        for (const [key, value] of [...index]) if (value.nodeId === nodeId) index.delete(key);
        refreshRing(); // 成员掉线 → 环变了 → 它原来的 shard 归别人
      };

      system.on('actor_registered', onRegistered);
      system.on('actor_stopped', onStopped);
      system.on('listening', onListening);
      gossip.on('registry_update', onUpdate);
      gossip.on('registry_delete', onDelete);
      gossip.on('node_timeout', onNodeTimeout);
      gossip.on('auth_error', ((reason: unknown) => system._log('cluster_auth_error', { reason })) as (...args: never[]) => void);

      await gossip.start();
      onListening(); // announce whatever already exists

      /**
       * **定时重算环**：成员变化不一定伴随注册表更新（一个刚加入、还没有任何 Actor 的节点就是
       * 这种情况），只靠事件驱动的刷新会让所有权视图停在旧成员集合上——"成员视图是纯函数"这条
       * 前提需要它**跟着视图走**，而不是跟着事件走。
       */
      const ringTimer = setInterval(() => {
        try {
          refreshRing();
        } catch (err) {
          system._log('cluster_ring_refresh_failed', { err: err instanceof Error ? err.message : String(err) });
        }
      }, 200);
      if (typeof ringTimer.unref === 'function') ringTimer.unref();

      system.cluster = {
        gossip,
        get port() {
          return gossip.boundPort;
        },
        peers: () => gossip.info().peers,
        nodes: () => gossip.info().nodes,
        lookup: (path: string): ActorMeta | null => index.get(String(path)) ?? null,
        /** Every actor discovered on other nodes. */
        remoteActors: () => [...index.keys()].sort(),
        /** Sync: returns a lazily-connecting ref, or null when unknown. */
        /** 所有权守卫本体（诊断/测试用）。 */
        ownership: guard,
        /** 分段所有权与 fencing 的可见状态：supported 之后才有保护。 */
        fencing: () => ({
          supported: true,
          shardCount,
          requireFencing: system.ownership?.requireFencing === true,
          skipped: fencingStats.skipped,
          rejected: fencingStats.rejected,
          conflicts: fencingStats.conflicts,
          handedOver: handingOver,
          promoted: takeover.promoted,
        }),
        /**
         * **优雅离场**（M4 第 3 步）：
         *   1. 发布 `leaving:<self>`，所有节点（含自己）立刻把本节点从环里去掉；
         *   2. **冻结**：本节点不再服务这些 shard（入站帧被拒并给出"该找谁"的提示）；
         *   3. **排空**：等在途请求结束（有上限，超时就如实报告，不假装干净）；
         *   4. **落盘**：给这些 shard 上的本地 Actor 存快照（状态转移走持久化，D3）；
         *   5. **释放**：停掉这些 Actor（新 owner 会用同一份存储恢复）。
         * 返回摘要：交出了哪些 shard、各自归谁、排空了几个、有没有超时。
         */
        async drain(drainOptions: { timeoutMs?: number; stopActors?: boolean } = {}): Promise<Record<string, unknown>> {
          const timeoutMs = Number.isFinite(drainOptions.timeoutMs) ? (drainOptions.timeoutMs as number) : 5000;
          const stopActors = drainOptions.stopActors !== false;
          const ownedBefore: number[] = [];
          for (let shard = 0; shard < shardCount; shard += 1) if (guard.ownsShard(shard)) ownedBefore.push(shard);

          // 1) 宣布离场（自己也算离场者，环里不再有自己）
          leaving.add(gossip.nodeId);
          gossip.setLocal(`${leavingKey}${gossip.nodeId}`, true);
          refreshRing(true);

          const moved = new Map<number, { from: string; to: string | null }>();
          // 先算出"谁接手哪些 shard"，并把**接管清单**发布出去：接手方据此重建 Actor。
          // 不能指望接手方去读注册表——离场时 Actor 条目会变成 tombstone，跟清单抢同一轮 gossip。
          for (const shard of ownedBefore) moved.set(shard, { from: gossip.nodeId, to: guard.ownerOf(shard) });
          const manifest: { path: string; shard: number; to: string | null; transferable: boolean }[] = [];
          for (const cell of system.cells.values()) {
            if (cell.stopped) continue;
            const ref = cell.ref as { path?: string } | null;
            const cellPath = ref !== null && typeof ref.path === 'string' ? ref.path : cell.path;
            if (!cellPath) continue;
            const shard = ringUtil.shardOf(String(cellPath), shardCount);
            if (!moved.has(shard)) continue;
            manifest.push({
              path: String(cellPath),
              shard,
              to: moved.get(shard)?.to ?? null,
              transferable: cell.transferable !== false,
            });
          }
          gossip.setLocal(`${ADOPT_PREFIX}${gossip.nodeId}`, {
            type: 'adoption-manifest',
            nodeId: gossip.nodeId,
            actors: manifest,
            ts: Date.now(),
          });
          for (const shard of ownedBefore) moved.set(shard, { from: gossip.nodeId, to: guard.ownerOf(shard) });

          // 2) 冻结由 verifyIncoming 里的 handingOver 判定负责（见下）
          handingOver = true;

          // 3) 排空在途请求
          const pending = (): number => {
            const server = system.server as { inflight?(): number } | null;
            return server !== null && typeof server.inflight === 'function' ? server.inflight() : 0;
          };
          const deadline = Date.now() + timeoutMs;
          while (pending() > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const remaining = pending();

          // 4/5) 落盘 + 释放：只动"这些 shard 上"的本地 Actor
          const localActors: { ref: { path?: string; id?: string; stop?(): Promise<void> }; path: string; transferable?: boolean; saveSnapshot?(): Promise<void> }[] = [];
          for (const cell of system.cells.values()) {
            if (cell.stopped === true) continue;
            const path = typeof cell.ref.path === 'string' ? cell.ref.path : cell.path;
            if (!path) continue;
            if (moved.has(ringUtil.shardOf(String(path), shardCount))) localActors.push(cell);
          }
          const persisted: string[] = [];
          const untransferable: string[] = [];
          for (const cell of localActors) {
            if (cell.transferable === false) {
              // 明确失败，而不是假装能迁移：持有 socket/句柄的 Actor 只能让客户端重连
              const cellPath = typeof cell.ref.path === 'string' ? cell.ref.path : cell.path;
              untransferable.push(cellPath);
              system._log('cluster_drain_untransferable', {
                path: cellPath,
                hint: 'transferable: false —— 这个 Actor 的连接会断开，请让客户端重连（不要假装能迁 socket）',
              });
              continue;
            }
            try {
              if (typeof cell.saveSnapshot === 'function') await cell.saveSnapshot();
              persisted.push(typeof cell.ref.path === 'string' ? cell.ref.path : cell.path);
            } catch (err) {
              system._log('cluster_drain_snapshot_failed', {
                path: typeof cell.ref.path === 'string' ? cell.ref.path : cell.path,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (stopActors) {
            // 注意：是 `ref.stop()`（停这一个 Actor）。`system.stop()` **不接受参数**、会停掉整个系统
            // （连插件一起 teardown）——这个 API 误用曾经把 drain 变成"把自己也关了"。
            for (const cell of localActors) {
              const stop = cell.ref.stop;
              if (typeof stop === 'function') await stop.call(cell.ref).catch(() => undefined);
            }
          }
          return {
            nodeId: gossip.nodeId,
            shards: [...moved.entries()].map(([shard, info]) => ({ shard, ...info })),
            promoted: takeover.promoted,
            actors: persisted,
            untransferable,
            drainedMs: timeoutMs - Math.max(0, deadline - Date.now()),
            inflight: remaining,
            timedOut: remaining > 0,
          };
        },
        /**
         * 单例：**每个节点都调用**（通常在各节点的启动流程里），只有单例 shard 的 owner 真的运行。
         * 返回 `{ local }`：本节点是否真的起来了。它不是分布式锁，接管有延迟。
         */
        async spawnSingleton(
          definition: unknown,
          singletonOptions: { id?: string; [key: string]: unknown } = {},
        ): Promise<{ id: string; local: boolean; owner: string | null }> {
          const id = singletonOptions.id !== undefined ? String(singletonOptions.id) : 'singleton';
          singletons.set(id, { definition, options: { ...singletonOptions, id } });
          refreshRing();
          await adoptSingletons();
          return { id, local: system.cells.has(id), owner: guard.ownerOf(SINGLETON_SHARD) };
        },
        /** 当前单例归属（诊断用）。 */
        singletons: () => [...singletons.keys()].map((id) => ({
          id,
          owner: guard.ownerOf(SINGLETON_SHARD),
          local: system.cells.has(id),
        })),
        /** 多数派状态（第 5 步）：应用层据此返回 503。 */
        quorum: () => {
          refreshRing();
          return quorumState();
        },
        /** 应用层在写之前调用：少数派时抛错（比静默接受写更安全）。 */
        assertWritable() {
          const quorum = quorumState();
          if (!quorum.ok) {
            throw new Error(
              `quorum：本节点处于少数派（live ${quorum.live} / highWater ${quorum.highWater}），拒绝写入`,
            );
          }
          return quorum;
        },
        /** 第 6 步：一处拿到所有集群治理指标（读之前先对齐成员视图）。 */
        metrics: () => {
          refreshRing();
          return {
            ownership: { shards: shardCount, owned: guard.stats().owned, claims: guard.stats().claims },
            fencing: {
              skipped: fencingStats.skipped,
              rejected: fencingStats.rejected,
              conflicts: fencingStats.conflicts,
              promoted: takeover.promoted,
              handedOver: handingOver,
            },
            adoption: { ...adoption },
            singletons: [...singletons.keys()].length,
            quorum: quorumState(),
          };
        },
        /** 某个 actor 在本地环上归谁（诊断用）。 */
        ownerOfActor: (path: string): string | null => {
          refreshRing();
          return guard.ownerOf(ringUtil.shardOf(String(path), shardCount));
        },
        resolveRemote: (path: string): DiscoveredRef | null => {
          const meta = index.get(String(path));
          if (!meta || !meta.host || !meta.gatewayPort) return null;
          // Never hand out a ref that points back at this node.
          if (meta.nodeId === gossip.nodeId) return null;
          return new DiscoveredRef(system, path, meta);
        },
        /** Wait until a path is discoverable (useful in tests and startup). */
        async waitFor(path: string, timeoutMs = 10000): Promise<ActorMeta | null> {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const meta = index.get(String(path));
            if (meta && meta.host && meta.gatewayPort && meta.nodeId !== gossip.nodeId) return meta;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error(`cluster: "${path}" was not discovered within ${timeoutMs}ms`);
        },
        _teardownListeners() {
          clearInterval(ringTimer);
          system.off('actor_registered', onRegistered);
          system.off('actor_stopped', onStopped);
          system.off('listening', onListening);
        },
      };
    },

    async teardown(system: ClusterSystem | null): Promise<void> {
      const clusterService = system?.cluster as { _teardownListeners?(): void; gossip?: { stop(): Promise<void> } } | null | undefined;
      if (clusterService !== null && clusterService !== undefined) {
        clusterService._teardownListeners?.();
        await clusterService.gossip?.stop().catch(() => undefined);
      }
      if (system !== null && system !== undefined) system.cluster = null;
      index.clear();
    },
  };
}

module.exports = cluster;
module.exports.cluster = cluster;
module.exports.DiscoveredRef = DiscoveredRef;
