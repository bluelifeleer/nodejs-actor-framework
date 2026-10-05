// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
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

/** A remote actor found through gossip; connects on first use. */
class DiscoveredRef {
  system: any;
  _path: string;
  host: any;
  gatewayPort: any;
  nodeId: any;
  _peer: any;

  constructor(system: any, path: any, meta: any) {
    this.system = system;
    this._path = String(path);
    this.host = meta.host;
    this.gatewayPort = meta.gatewayPort;
    this.nodeId = meta.nodeId || null;
    this._peer = null;
  }

  get id() {
    const parts = this._path.split('/');
    return parts[parts.length - 1];
  }

  get path() {
    return this._path;
  }

  get isLocal() {
    return false;
  }

  async _resolvePeer() {
    if (this._peer) return this._peer;
    this._peer = await this.system.connect({ host: this.host, port: this.gatewayPort });
    return this._peer;
  }

  tell(msg, sender, trace) {
    this._resolvePeer()
      .then((peer) => peer.ref(this._path).tell(msg, sender, trace))
      .catch((err) => {
        // Fire-and-forget failures have no caller to reject, so make them
        // observable through both the log and an event.
        this.system._log('cluster_tell_failed', { path: this._path, err: err.message });
        this.system.emit('remote_tell_failed', this._path, err);
      });
    return true; // handed to the (lazy) transport
  }

  async ask(msg, timeoutMs, sender, trace) {
    const peer = await this._resolvePeer();
    return peer.ref(this._path).ask(msg, timeoutMs, sender, trace);
  }

  async stop() {
    const peer = await this._resolvePeer();
    return peer.ref(this._path).stop();
  }

  inspect() {
    throw new ActorStoppedError(
      `inspect() is local-only; "${this._path}" was discovered on ${this.nodeId || `${this.host}:${this.gatewayPort}`}`,
    );
  }

  state() {
    return Promise.reject(new ActorStoppedError('state() is local-only for a discovered actor'));
  }

  toString() {
    return `DiscoveredRef(${this._path}@${this.nodeId || `${this.host}:${this.gatewayPort}`})`;
  }
}

function cluster(options = {}) {
  const index = new Map(); // actor path -> { host, gatewayPort, nodeId }

  return {
    name: 'cluster',

    async setup(system) {
      const gossip = new Gossip(options.nodeId || system.name, options.port === undefined ? 0 : options.port, {
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
      const shardCount = Number.isInteger(options.shardCount) ? options.shardCount : 256;
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
      const rememberClaim = (shard, epoch) => {
        if (publishedClaims.get(shard) === epoch) return;
        publishedClaims.set(shard, epoch);
        claimsDirty = true;
      };

      /**
       * 环 = 成员视图的纯函数，缓存只是优化。所以**按需刷新**（而不是只靠事件）：
       * 事件可能漏掉"新节点加入"，而所有权判断容不得用旧视图（那正是"未收敛窗口"）。
       * 用成员集合的签名避免无谓重建。
       */
      let membersKey = null;
      let previousRing = null;
      /** 已宣布离场的节点（含本节点在 drain() 时宣布的）：环要立刻排除它们。 */
      const leaving = new Set();
      const leavingKey = 'leaving:';
      const takeover = { promoted: 0, shards: [] };
      /** 一旦开始离场就永久冻结：这是"不再双主"的关键——旧 owner 主动停止服务。 */
      let handingOver = false;

      /**
       * 环 = 成员视图（**排除离场者**）的纯函数。离场用一条注册表标记表达，
       * 于是"节点要走了"这件事在**所有节点上确定性可见**，不必等心跳超时。
       */
      const refreshRing = (force = false) => {
        // 离场者（**包括本节点自己在 drain 时**）一律排除：否则离场节点算出的新 owner 还是它自己。
        // 成员可能变成空集（单节点集群离场）——那也是有效状态：此时 owner 为 null（没人接管）。
        const members = gossip.info().nodes.filter((node) => !leaving.has(node));
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
                options.onShardsPromoted(shard, previousRing ? ringUtil.ownerOfShard(previousRing, shard) : null);
              } catch (err) {
                system._log('cluster_on_shards_promoted_failed', { shard, err: err && err.message });
              }
            }
          }
          if (claimsDirty) publishClaims();
        }
        previousRing = next;
        return next;
      };

      system.ownership = {
        shardCount,
        requireFencing: options.requireFencing === true,
        guard,
        /** 出站：只有本节点**确实是**这个 shard 的 owner 时才给出 epoch（否则不带字段）。 */
        epochFor(path) {
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
        verifyIncoming({ targetActorId, shardEpoch, peerNodeId }) {
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
            // 没有 token：转发者本来就没有 token 可带（合法）；但**本节点认为它是 owner**
            // 却不带 token 就说明它拿的是旧视图 —— 拒绝，让它去重新同步。
            if (guard.ownerOf(shard) === peerNodeId && guard.isMember(peerNodeId)) {
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

      const announce = (ref) => {
        gossip.setLocal(ref.path, {
          type: 'actor',
          nodeId: gossip.nodeId,
          actorId: ref.path,
          host: gossip.advertiseHost,
          gatewayPort: gatewayPort(),
        });
      };

      const onRegistered = (ref) => announce(ref);
      const onStopped = (path) => gossip.delLocal(String(path));
      const onListening = () => {
        // The gateway port is only known after listen(): re-announce so peers
        // get a reachable address.
        for (const cell of system.cells.values()) if (!cell.stopped) announce(cell.ref);
        refreshRing();
        // 降级与拒绝必须**可见**（软升级策略的前提）：计数从网关事件来
        if (system.server && typeof system.server.on === 'function' && !system.server.__fencingWired) {
          system.server.__fencingWired = true;
          system.server.on('fencing_skipped', () => {
            fencingStats.skipped += 1;
          });
          system.server.on('ownership_rejected', () => {
            fencingStats.rejected += 1;
          });
        }
      };
      const onUpdate = (key, value) => {
        if (key.startsWith('subs:')) return;
        refreshRing(); // 成员视图可能变了（谁在环上决定所有权）
        if (key.startsWith(leavingKey)) {
          // 有人宣布离场：立刻把它从环里去掉（确定性），并重算（会触发新 owner 加代）
          if (value === true || (value && value.type === 'leaving')) {
            leaving.add(key.slice(leavingKey.length));
            if (key !== `${leavingKey}${gossip.nodeId}`) refreshRing();
          }
          return;
        }
        if (key.startsWith(CLAIM_PREFIX)) {
          // 对端的声明：epoch 更高 = 所有权换代；同 epoch 换人 = **双主声明**，必须报出来
          if (value && value.type === 'shard-claims' && value.claims) {
            for (const [shardText, epoch] of Object.entries(value.claims)) {
              const result = guard.observe({
                shard: Number(shardText),
                ownerNodeId: value.nodeId || key.slice(CLAIM_PREFIX.length),
                epoch: Number(epoch),
                at: value.ts || Date.now(),
              });
              if (!result.accepted && String(result.reason).includes('双主声明')) {
                fencingStats.conflicts += 1;
                system._log('cluster_shard_claim_conflict', { shard: Number(shardText), reason: result.reason });
              }
            }
          }
          return;
        }
        if (!value || value.type !== 'actor') return;
        index.set(key, value);
      };
      const onDelete = (key) => {
        if (key.startsWith('subs:')) return;
        index.delete(key);
      };
      const onNodeTimeout = (nodeId) => {
        for (const [key, value] of [...index]) if (value.nodeId === nodeId) index.delete(key);
        refreshRing(); // 成员掉线 → 环变了 → 它原来的 shard 归别人
      };

      system.on('actor_registered', onRegistered);
      system.on('actor_stopped', onStopped);
      system.on('listening', onListening);
      gossip.on('registry_update', onUpdate);
      gossip.on('registry_delete', onDelete);
      gossip.on('node_timeout', onNodeTimeout);
      gossip.on('auth_error', (reason) => system._log('cluster_auth_error', { reason }));

      await gossip.start();
      onListening(); // announce whatever already exists

      system.cluster = {
        gossip,
        get port() {
          return gossip.boundPort;
        },
        peers: () => gossip.info().peers,
        nodes: () => gossip.info().nodes,
        lookup: (path) => index.get(String(path)) || null,
        /** Every actor discovered on other nodes. */
        remoteActors: () => [...index.keys()].sort(),
        /** Sync: returns a lazily-connecting ref, or null when unknown. */
        /** 所有权守卫本体（诊断/测试用）。 */
        ownership: guard,
        /** 分段所有权与 fencing 的可见状态：supported 之后才有保护。 */
        fencing: () => ({
          supported: true,
          shardCount,
          requireFencing: system.ownership.requireFencing,
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
        async drain(drainOptions = {}) {
          const timeoutMs = Number.isFinite(drainOptions.timeoutMs) ? drainOptions.timeoutMs : 5000;
          const stopActors = drainOptions.stopActors !== false;
          const ownedBefore = [];
          for (let shard = 0; shard < shardCount; shard += 1) if (guard.ownsShard(shard)) ownedBefore.push(shard);

          // 1) 宣布离场（自己也算离场者，环里不再有自己）
          leaving.add(gossip.nodeId);
          gossip.setLocal(`${leavingKey}${gossip.nodeId}`, true);
          refreshRing(true);

          const moved = new Map();
          for (const shard of ownedBefore) moved.set(shard, { from: gossip.nodeId, to: guard.ownerOf(shard) });

          // 2) 冻结由 verifyIncoming 里的 handingOver 判定负责（见下）
          handingOver = true;

          // 3) 排空在途请求
          const pending = () => (system.server && typeof system.server.inflight === 'function' ? system.server.inflight() : 0);
          const deadline = Date.now() + timeoutMs;
          while (pending() > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const remaining = pending();

          // 4/5) 落盘 + 释放：只动"这些 shard 上"的本地 Actor
          const localActors = [];
          for (const cell of system.cells.values()) {
            if (cell.stopped) continue;
            const path = cell.ref && cell.ref.path ? cell.ref.path : cell.id;
            if (!path) continue;
            if (moved.has(ringUtil.shardOf(String(path), shardCount))) localActors.push(cell);
          }
          const persisted = [];
          for (const cell of localActors) {
            try {
              await cell.saveSnapshot();
              persisted.push(cell.ref.path);
            } catch (err) {
              system._log('cluster_drain_snapshot_failed', { path: cell.ref.path, err: err && err.message });
            }
          }
          if (stopActors) {
            // 注意：是 `ref.stop()`（停这一个 Actor）。`system.stop()` **不接受参数**、会停掉整个系统
            // （连插件一起 teardown）——这个 API 误用曾经把 drain 变成"把自己也关了"。
            for (const cell of localActors) await cell.ref.stop().catch(() => undefined);
          }
          return {
            nodeId: gossip.nodeId,
            shards: [...moved.entries()].map(([shard, info]) => ({ shard, ...info })),
            promoted: takeover.promoted,
            actors: persisted,
            drainedMs: timeoutMs - Math.max(0, deadline - Date.now()),
            inflight: remaining,
            timedOut: remaining > 0,
          };
        },
        /** 某个 actor 在本地环上归谁（诊断用）。 */
        ownerOfActor: (path) => {
          refreshRing();
          return guard.ownerOf(ringUtil.shardOf(String(path), shardCount));
        },
        resolveRemote: (path) => {
          const meta = index.get(String(path));
          if (!meta || !meta.host || !meta.gatewayPort) return null;
          // Never hand out a ref that points back at this node.
          if (meta.nodeId === gossip.nodeId) return null;
          return new DiscoveredRef(system, path, meta);
        },
        /** Wait until a path is discoverable (useful in tests and startup). */
        async waitFor(path, timeoutMs = 10000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const meta = index.get(String(path));
            if (meta && meta.host && meta.gatewayPort && meta.nodeId !== gossip.nodeId) return meta;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error(`cluster: "${path}" was not discovered within ${timeoutMs}ms`);
        },
        _teardownListeners() {
          system.off('actor_registered', onRegistered);
          system.off('actor_stopped', onStopped);
          system.off('listening', onListening);
        },
      };
    },

    async teardown(system) {
      if (system && system.cluster) {
        system.cluster._teardownListeners();
        await system.cluster.gossip.stop().catch(() => {});
        system.cluster = null;
      }
      index.clear();
    },
  };
}

module.exports = cluster;
module.exports.cluster = cluster;
module.exports.DiscoveredRef = DiscoveredRef;
