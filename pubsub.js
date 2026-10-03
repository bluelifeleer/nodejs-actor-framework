'use strict';

const EventEmitter = require('events');
const Trace = require('./trace');
const config = require('./config');

/**
 * Topic-based publish/subscribe.
 *
 * - Dependencies are injected (no more `global.actorManager`).
 * - Fan-out is parallel, and delivery goes through ActorManager, so a message
 *   reaches subscribers on other nodes over the gateway when it can.
 * - Each delivery carries the topic name and its own child span, so a publish
 *   is a real parent span with N children (the previous code passed one flat
 *   context to everyone and overwrote the payload's own trace).
 * - Subscription metadata is replicated over gossip under `subs:<nodeId>`, so
 *   `pub sub` on one node is visible to publishers on another.
 */
class PubSub extends EventEmitter {
  /**
   * @param {{actorManager?:object, gossip?:object, nodeId?:string, traceSampleRate?:number}} options
   */
  constructor(options = {}) {
    super();
    this.actorManager = options.actorManager || null;
    this.gossip = options.gossip || null;
    this.nodeId = options.nodeId || config.nodeId;
    this.traceSampleRate = options.traceSampleRate ?? 1;

    /** @type {Map<string, Set<string>>} topic -> local subscriber actorIds */
    this.topics = new Map();
    /** @type {Map<string, Map<string, string[]>>} nodeId -> topic -> actorIds */
    this.remoteSubs = new Map();

    if (this.gossip) {
      gossipBridge(this, this.gossip);
    }
  }

  setActorManager(actorManager) {
    this.actorManager = actorManager;
    return this;
  }

  subscribe(topic, actorId) {
    if (!topic || !actorId) throw new TypeError('subscribe(topic, actorId): both are required');
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic).add(String(actorId));
    this._broadcastSubscriptions();
    this.emit('subscribe', topic, actorId);
    return true;
  }

  unsubscribe(topic, actorId) {
    const set = this.topics.get(topic);
    if (!set) return false;
    const removed = set.delete(String(actorId));
    if (set.size === 0) this.topics.delete(topic);
    if (removed) this._broadcastSubscriptions();
    this.emit('unsubscribe', topic, actorId);
    return removed;
  }

  /** Local subscriptions as a plain object (for gossip). */
  exportSubscriptions() {
    const out = {};
    for (const [topic, set] of this.topics) out[topic] = [...set];
    return out;
  }

  _broadcastSubscriptions() {
    if (!this.gossip) return;
    this.gossip.setLocal(`subs:${this.nodeId}`, this.exportSubscriptions());
  }

  _applyRemoteSubscriptions(nodeId, subs) {
    if (nodeId === this.nodeId) return;
    this.remoteSubs.set(nodeId, subs && typeof subs === 'object' ? subs : {});
    this.emit('remote_subscriptions', nodeId, subs);
  }

  _dropRemoteSubscriptions(nodeId) {
    if (this.remoteSubs.delete(nodeId)) this.emit('remote_subscriptions', nodeId, {});
  }

  /** Union of local and gossiped subscribers for a topic. */
  subscribers(topic) {
    const ids = new Set(this.topics.get(topic) || []);
    for (const subs of this.remoteSubs.values()) {
      for (const id of subs[topic] || []) ids.add(String(id));
    }
    return [...ids];
  }

  listTopics() {
    const topics = new Set(this.topics.keys());
    for (const subs of this.remoteSubs.values()) {
      for (const topic of Object.keys(subs)) topics.add(topic);
    }
    return [...topics];
  }

  /**
   * Publish to every subscriber of a topic.
   * @returns {Promise<Array<{actorId:string, ok:boolean, ret?:any, err?:string}>>}
   */
  async publish(topic, msg, parentTraceCtx = null, options = {}) {
    if (!this.actorManager) throw new Error('PubSub has no ActorManager attached');
    const subscribers = this.subscribers(topic);
    if (subscribers.length === 0) return [];

    const rootTrace = Trace.buildContext(parentTraceCtx, { sampleRate: this.traceSampleRate });
    const timeoutMs = options.timeoutMs ?? config.actor.requestTimeoutMs;
    const priority = options.priority ?? 1;

    const results = await Promise.all(
      subscribers.map(async (actorId) => {
        const childTrace = Trace.child(rootTrace, { sampleRate: this.traceSampleRate });
        try {
          const ret = await this.actorManager.send(
            actorId,
            { ...msg, topic, trace: childTrace },
            timeoutMs,
            priority,
            childTrace,
          );
          return { actorId, ok: true, ret };
        } catch (err) {
          return { actorId, ok: false, err: err.message };
        }
      }),
    );

    this.emit('publish', topic, results);
    return results;
  }
}

/** Wires PubSub to gossip both ways without creating a circular dependency. */
function gossipBridge(pubsub, gossip) {
  const prefix = 'subs:';
  gossip.on('registry_update', (key, value) => {
    if (!key.startsWith(prefix)) return;
    pubsub._applyRemoteSubscriptions(key.slice(prefix.length), value);
  });
  gossip.on('registry_delete', (key) => {
    if (!key.startsWith(prefix)) return;
    pubsub._dropRemoteSubscriptions(key.slice(prefix.length));
  });
  gossip.on('node_timeout', (nodeId) => pubsub._dropRemoteSubscriptions(nodeId));
  // Seed our own view immediately.
  pubsub._broadcastSubscriptions();
}

module.exports = PubSub;
module.exports.PubSub = PubSub;
