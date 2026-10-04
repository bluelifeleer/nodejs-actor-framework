'use strict';

const config = require('../config');
const Gossip = require('../cluster/gossip');
const { ActorStoppedError } = require('../actor/errors');

/**
 * Cluster plugin: gossip-based discovery so an actor can be reached by **name**
 * instead of a hard-coded host:port.
 *
 * When installed, `system.resolve('some/actor')` falls back to the cluster
 * index and returns a ref that connects lazily. So this works unchanged:
 *
 *   await a.spawn(Player, { id: 'player_001' });        // node A
 *   await b.ask('player_001', { type: 'hurt' });        // node B, no host:port
 *   await ctx.ask('player_001', msg);                    // from inside an actor
 *
 * Discovery is eventually consistent: a brand new actor becomes resolvable once
 * a gossip round has carried it to the peer.
 */

/** A remote actor found through gossip; connects on first use. */
class DiscoveredRef {
  constructor(system, path, meta) {
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
      };
      const onUpdate = (key, value) => {
        if (key.startsWith('subs:')) return;
        if (!value || value.type !== 'actor') return;
        index.set(key, value);
      };
      const onDelete = (key) => {
        if (key.startsWith('subs:')) return;
        index.delete(key);
      };
      const onNodeTimeout = (nodeId) => {
        for (const [key, value] of [...index]) if (value.nodeId === nodeId) index.delete(key);
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
