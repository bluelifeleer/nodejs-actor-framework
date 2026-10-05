// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const { ActorNotFoundError } = require('../actor/errors.ts');

/**
 * Pub/sub plugin.
 *
 * Subscriptions are local and, when the cluster plugin is installed, replicated
 * through gossip under `subs:<nodeId>` — so a publisher on one node reaches
 * subscribers on another without knowing where they live.
 *
 * Delivery is `tell` (fire and forget), which is the actor-native choice: a
 * topic broadcast has no meaningful reply. `publish()` therefore reports
 * *acceptance* per subscriber, not the handler result.
 */
function pubsub(options = {}) {
  const topics = new Map(); // topic -> Set<path>
  const remoteSubs = new Map(); // nodeId -> { topic: [paths] }

  const exportSubscriptions = () => {
    const out = {};
    for (const [topic, set] of topics) out[topic] = [...set];
    return out;
  };

  return {
    name: 'pubsub',

    async setup(system) {
      const gossip = system.cluster ? system.cluster.gossip : null;

      const broadcast = () => {
        if (gossip) gossip.setLocal(`subs:${gossip.nodeId}`, exportSubscriptions());
      };

      const onUpdate = (key, value) => {
        if (!key.startsWith('subs:')) return;
        remoteSubs.set(key.slice('subs:'.length), value && typeof value === 'object' ? value : {});
      };
      const onDelete = (key) => {
        if (key.startsWith('subs:')) remoteSubs.delete(key.slice('subs:'.length));
      };
      const onNodeTimeout = (nodeId) => remoteSubs.delete(nodeId);

      if (gossip) {
        gossip.on('registry_update', onUpdate);
        gossip.on('registry_delete', onDelete);
        gossip.on('node_timeout', onNodeTimeout);
      }

      const pathOf = (target) => {
        if (!target) throw new ActorNotFoundError('subscribe(topic, target): target is required');
        if (typeof target === 'string') return target;
        if (typeof target.path === 'string') return target.path;
        throw new ActorNotFoundError('subscribe(topic, target): target must be a ref or a path');
      };

      system.pubsub = {
        subscribe(topic, target) {
          if (!topic) throw new TypeError('subscribe(topic, target): topic is required');
          const path = pathOf(target);
          if (!topics.has(topic)) topics.set(topic, new Set());
          topics.get(topic).add(path);
          broadcast();
          system.emit('subscribe', topic, path);
          return true;
        },

        unsubscribe(topic, target) {
          const set = topics.get(topic);
          if (!set) return false;
          const removed = set.delete(pathOf(target));
          if (set.size === 0) topics.delete(topic);
          if (removed) broadcast();
          return removed;
        },

        /** Topics known locally or through gossip. */
        topics() {
          const all = new Set(topics.keys());
          for (const subs of remoteSubs.values()) for (const topic of Object.keys(subs)) all.add(topic);
          return [...all].sort();
        },

        /** Subscriber paths for a topic: local plus gossiped. */
        subscribers(topic) {
          const all = new Set(topics.get(topic) || []);
          for (const subs of remoteSubs.values()) for (const path of subs[topic] || []) all.add(path);
          return [...all].sort();
        },

        localSubscriptions: exportSubscriptions,

        /**
         * Broadcast to every subscriber.
         * @returns {Promise<Array<{path:string, ok:boolean, err?:string}>>}
         */
        async publish(topic, msg) {
          const subscribers = system.pubsub.subscribers(topic);
          const results = [];
          for (const path of subscribers) {
            let ref;
            try {
              ref = system.resolve(path);
            } catch (err) {
              results.push({ path, ok: false, err: err.message });
              continue;
            }
            if (!ref) {
              results.push({ path, ok: false, err: `actor "${path}" is not resolvable` });
              continue;
            }
            try {
              const accepted = ref.tell({ ...msg, topic });
              results.push({ path, ok: accepted !== false });
            } catch (err) {
              results.push({ path, ok: false, err: err.message });
            }
          }
          system.emit('publish', topic, results);
          return results;
        },
      };

      broadcast();
    },

    teardown(system) {
      topics.clear();
      remoteSubs.clear();
      if (system) system.pubsub = null;
    },
  };
}

module.exports = pubsub;
module.exports.pubsub = pubsub;
