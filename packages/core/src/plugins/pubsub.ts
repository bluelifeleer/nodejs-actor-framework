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
/** 插件配置（当前只有 nodeId，保留给将来的本地命名空间隔离）。 */
interface PubSubOptions {
  nodeId?: string;
}

/** 一条订阅者（ref 或路径都能收）。 */
interface SubscribableTarget {
  readonly path?: string;
}

/** publish 的逐订阅者结果：`tell` 只报告**是否被接收**，不是处理结果。 */
interface PublishResult {
  path: string;
  ok: boolean;
  err?: string;
}

/** 结构型 system 视图：只声明本插件真正碰到的字段（内核是 CJS，不能 import type）。 */
interface PubSubSystem {
  cluster?: { gossip: PubSubGossip } | null;
  pubsub: PubSubApi | null;
  resolve(path: string): { tell(msg: unknown): boolean | undefined } | null | undefined;
  emit(event: string, ...args: unknown[]): void;
}

interface PubSubGossip {
  nodeId: string;
  setLocal(key: string, value: unknown): void;
  on(event: string, handler: (...args: never[]) => void): void;
}

interface PubSubApi {
  subscribe(topic: string, target: string | SubscribableTarget): boolean;
  unsubscribe(topic: string, target: string | SubscribableTarget): boolean;
  topics(): string[];
  subscribers(topic: string): string[];
  localSubscriptions(): Record<string, string[]>;
  publish(topic: string, msg: Record<string, unknown>): Promise<PublishResult[]>;
}

function pubsub(options: PubSubOptions = {}) {
  void options;
  const topics = new Map<string, Set<string>>(); // topic -> Set<path>
  /**
   * 审计 F14：setup 时挂在 gossip 上的 3 个监听器必须在 teardown 摘掉。
   * 监听器的闭包在 setup 里，所以这里存一个"注销函数"给 teardown 用。
   */
  let detachGossipListeners: () => void = () => {};
  const remoteSubs = new Map<string, Record<string, string[]>>(); // nodeId -> { topic: [paths] }

  const exportSubscriptions = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [topic, set] of topics) out[topic] = [...set];
    return out;
  };

  return {
    name: 'pubsub',

    async setup(system: PubSubSystem) {
      const gossip = system.cluster ? system.cluster.gossip : null;

      const broadcast = () => {
        if (gossip) gossip.setLocal(`subs:${gossip.nodeId}`, exportSubscriptions());
      };

      const onUpdate = (key: string, value: unknown) => {
        if (!key.startsWith('subs:')) return;
        // registry 值来自对端：形状不可信。坏值必须丢弃，而不是让 subscribers()/publish() 抛错。
        const sanitized: Record<string, string[]> = {};
        if (value !== null && typeof value === 'object') {
          for (const [topic, paths] of Object.entries(value as Record<string, unknown>)) {
            if (Array.isArray(paths)) sanitized[topic] = paths.filter((path): path is string => typeof path === 'string');
          }
        }
        remoteSubs.set(key.slice('subs:'.length), sanitized);
      };
      const onDelete = (key: string) => {
        if (key.startsWith('subs:')) remoteSubs.delete(key.slice('subs:'.length));
      };
      const onNodeTimeout = (nodeId: string) => remoteSubs.delete(nodeId);

      if (gossip) {
        gossip.on('registry_update', onUpdate);
        gossip.on('registry_delete', onDelete);
        gossip.on('node_timeout', onNodeTimeout);
        detachGossipListeners = () => {
          const target = gossip as { off?: (...args: unknown[]) => void };
          if (typeof target.off !== 'function') return;
          target.off('registry_update', onUpdate);
          target.off('registry_delete', onDelete);
          target.off('node_timeout', onNodeTimeout);
        };
      } else {
        detachGossipListeners = () => {};
      }

      const pathOf = (target: string | SubscribableTarget): string => {
        if (!target) throw new ActorNotFoundError('subscribe(topic, target): target is required');
        if (typeof target === 'string') return target;
        if (typeof target.path === 'string') return target.path;
        throw new ActorNotFoundError('subscribe(topic, target): target must be a ref or a path');
      };

      system.pubsub = {
        subscribe(topic: string, target: string | SubscribableTarget): boolean {
          if (!topic) throw new TypeError('subscribe(topic, target): topic is required');
          const path = pathOf(target);
          if (!topics.has(topic)) topics.set(topic, new Set<string>());
          topics.get(topic)?.add(path);
          broadcast();
          system.emit('subscribe', topic, path);
          return true;
        },

        unsubscribe(topic: string, target: string | SubscribableTarget): boolean {
          const set = topics.get(topic);
          if (!set) return false;
          const removed = set.delete(pathOf(target));
          if (set.size === 0) topics.delete(topic);
          if (removed) broadcast();
          return removed;
        },

        /** Topics known locally or through gossip. */
        topics(): string[] {
          const all = new Set(topics.keys());
          for (const subs of remoteSubs.values()) for (const topic of Object.keys(subs)) all.add(topic);
          return [...all].sort();
        },

        /** Subscriber paths for a topic: local plus gossiped. */
        subscribers(topic: string): string[] {
          const all = new Set(topics.get(topic) || []);
          for (const subs of remoteSubs.values()) for (const path of subs[topic] || []) all.add(path);
          return [...all].sort();
        },

        localSubscriptions: exportSubscriptions,

        /**
         * Broadcast to every subscriber.
         * @returns {Promise<Array<{path:string, ok:boolean, err?:string}>>}
         */
        async publish(topic: string, msg: Record<string, unknown>): Promise<PublishResult[]> {
          const subscribers = system.pubsub === null ? [] : system.pubsub.subscribers(topic);
          const results: PublishResult[] = [];
          for (const path of subscribers) {
            let ref: { tell(msg: unknown): boolean | undefined } | null | undefined;
            try {
              ref = system.resolve(path);
            } catch (err) {
              results.push({ path, ok: false, err: (err as Error).message });
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
              results.push({ path, ok: false, err: (err as Error).message });
            }
          }
          system.emit('publish', topic, results);
          return results;
        },
      };

      broadcast();
    },

    teardown(system: PubSubSystem | null) {
      detachGossipListeners(); // 审计 F14
      detachGossipListeners = () => {};
      topics.clear();
      remoteSubs.clear();
      if (system) system.pubsub = null;
    },
  };
}

module.exports = pubsub;
module.exports.pubsub = pubsub;
