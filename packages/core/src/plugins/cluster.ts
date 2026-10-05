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
      const fencingStats = { skipped: 0, rejected: 0 };

      /**
       * 环 = 成员视图的纯函数，缓存只是优化。所以**按需刷新**（而不是只靠事件）：
       * 事件可能漏掉"新节点加入"，而所有权判断容不得用旧视图（那正是"未收敛窗口"）。
       * 用成员集合的签名避免无谓重建。
       */
      let membersKey = null;
      const refreshRing = (force = false) => {
        const members = gossip.info().nodes;
        if (members.length === 0) return;
        const key = [...members].sort().join(',');
        if (!force && key === membersKey) return;
        membersKey = key;
        guard.updateRing(members);
      };

      system.ownership = {
        shardCount,
        requireFencing: options.requireFencing === true,
        guard,
        /** 出站：只有本节点**确实是**这个 shard 的 owner 时才给出 epoch（否则不带字段）。 */
        epochFor(path) {
          refreshRing();
          const claim = guard.claimFor(ringUtil.shardOf(String(path), shardCount));
          return claim === null ? null : claim.epoch;
        },
        /** 入站判定：见 docs/design/m4-cluster-governance.md §3.4.5 的三条规则。 */
        verifyIncoming({ targetActorId, shardEpoch, peerNodeId }) {
          if (!targetActorId) return { ok: true };
          refreshRing();
          const shard = ringUtil.shardOf(String(targetActorId), shardCount);
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
        }),
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
