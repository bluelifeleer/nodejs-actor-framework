import { plugins as kernelPlugins } from 'nodejs-actor-framework';

import type { Application, PluginSpec } from './assembly.ts';

/**
 * 内置能力的应用层包装（M1 步骤 4）。
 *
 * 刻意**不做自动挂载**：用户在 `defineApp({ plugins: [...] })` 里显式启用哪一项，
 * 内核才装上哪一项——这既让能力边界清晰，也让内核的加载面可控（不再一次性挂上全部能力）。
 *
 * 这些包装只做两件事：起个稳定的应用层名字、把内核插件交出去（内核类型不出现在签名里）。
 *
 * **一个例外**：`clusterPlugin` 不能只做包装——装上它之后本节点必须有一个可被对端连接的网关，
 * 所以它还会在 `onReady` 自动启动网关，并暴露几个查询方法。理由见下面的详细注释。
 */

type KernelPluginFactory = ((options?: Record<string, unknown>) => unknown) | unknown;

function wrap(name: string, kernelPlugin: KernelPluginFactory) {
  return (options: Record<string, unknown> = {}): PluginSpec => ({
    name,
    kernelPlugins: [typeof kernelPlugin === 'function' ? kernelPlugin(options) : kernelPlugin],
  });
}

/** 指标采集与导出（Prometheus 文本 / 自定义导出器）。 */
export const metricsPlugin = wrap('metrics', kernelPlugins.metrics);
/** 分布式追踪。 */
export const tracingPlugin = wrap('tracing', kernelPlugins.tracing);
/** 死信队列（失败消息不丢，可查询/重放）。 */
export const deadLettersPlugin = wrap('deadLetters', kernelPlugins.deadLetters);
/** 按 Actor 限流（令牌桶）。 */
export const rateLimitPlugin = wrap('rateLimit', kernelPlugins.rateLimit);
/** 发布/订阅。 */
export const pubsubPlugin = wrap('pubsub', kernelPlugins.pubsub);

// --- 集群：唯一需要"入口自理"的插件 -----------------------------------------

/** gossip 名册里一条远端 Actor 记录（应用层只暴露这几个字段，不含内核类型）。 */
export interface ClusterActorMeta {
  /** Actor 路径。 */
  actorId: string;
  /** 它在哪个节点上。 */
  nodeId: string;
  /** 该节点的网关地址（跨节点 ask/tell 的目标）。 */
  host: string;
  gatewayPort: number;
}

/** 一个已知对端（心跳时间用于判断"活着"而不只是"听说过"）。 */
export interface ClusterPeer {
  host: string;
  port: number;
  lastSeen: number;
  failures: number;
}

export type ClusterPluginOptions = Record<string, unknown> & {
  /** 网关绑定地址；省略时取 `plugins.cluster.gatewayHost`（默认回环）。 */
  gatewayHost?: string;
  /** 网关端口；省略时取 `plugins.cluster.gatewayPort`（默认 `0` = 由系统分配）。 */
  gatewayPort?: number;
  /**
   * `false` = 不在 `onReady` 自动启动网关（默认 `true`）。
   * 只有当你打算自己管网关（`app.kernel.listen(...)`）时才需要关掉。
   */
  autoListen?: boolean;
};

export interface ClusterPlugin extends PluginSpec {
  /** 本节点网关地址（`start()` 之后可用；未启用自动监听且尚未手动 listen 时为 `null`）。 */
  address(): { host: string; port: number } | null;
  /** 本节点 gossip 地址（给别的节点当种子用）。 */
  gossipAddress(): { host: string; port: number } | null;
  /** 等某个 Actor 被 gossip 发现；超时抛错（发现是**最终一致**的）。 */
  waitFor(actorPath: string, timeoutMs?: number): Promise<ClusterActorMeta>;
  /** 已发现的**远端** Actor 路径（本节点自己的不算）。 */
  remoteActors(): string[];
  /** 已知对端。 */
  peers(): ClusterPeer[];
}

/** 内核 system 上本插件用到的那一小部分（结构类型，不 import 内核类型）。 */
interface ClusterKernelView {
  port: number;
  gossip: { nodeId: string; advertiseHost: string; boundPort: number | null; port: number };
  peers(): ClusterPeer[];
  remoteActors(): string[];
  waitFor(actorPath: string, timeoutMs?: number): Promise<ClusterActorMeta>;
}

interface ClusterKernelSystem {
  listen(options: { host?: string; port?: number }): Promise<number>;
  server?: { host: string; boundPort: number } | null;
  cluster?: ClusterKernelView | null;
}

/**
 * 集群（gossip 发现 + 跨节点寻址）。
 *
 * **为什么这个插件不像其它内置插件那样只是一层包装**：装上集群插件后，本节点必须有一个
 * 可被对端连接的**网关**（actor 传输），否则 gossip 广播出去的地址无人应答——那样
 * `ctx.actor('远端名')` 只会失败。内核把"起网关"留给了调用方（`system.listen`），
 * 而应用层签名不暴露内核概念；如果把这步留给用户，就等于让每个用户都去写
 * `app.kernel.listen(...)` 逃生通道。
 *
 * 所以这里由插件在 `onReady`（Actor 已 spawn、模块 onStart 已完成）自动启动网关：
 *
 * ```ts
 * const cluster = clusterPlugin({ seeds: ['10.0.0.1:7200'] });
 * const app = createApp(defineApp({ modules: [...], plugins: [cluster] }));
 * await app.start();
 * cluster.address();                 // { host: '127.0.0.1', port: 52341 }
 * await cluster.waitFor('Room_A');   // 等 gossip 发现（最终一致）
 * ```
 *
 * 端口默认 `0`（由系统分配）：gossip 会广播**实际**端口，所以不需要预先约定；这同时避免
 * 与 `httpPlugin` 的默认端口（9000）撞车。需要固定端口时用 `gatewayPort` 或
 * `APP_PLUGINS__CLUSTER__GATEWAY_PORT`。绑定地址默认回环，与框架的"安全默认"一致。
 */
export function clusterPlugin(options: ClusterPluginOptions = {}): ClusterPlugin {
  let app: Application | null = null;
  let gateway: { host: string; port: number } | null = null;

  const kernelSystem = (): ClusterKernelSystem | null => {
    const system = app?.kernel as ClusterKernelSystem | null | undefined;
    return system ?? null;
  };

  const requireCluster = (): ClusterKernelView => {
    if (!app) {
      throw new Error('clusterPlugin: 请先 await app.start()，再使用集群视图（waitFor/remoteActors/peers）');
    }
    const cluster = kernelSystem()?.cluster ?? null;
    if (!cluster) {
      throw new Error(
        'clusterPlugin: 集群尚未就绪——本插件用 autoListen:false 关掉了自动监听时，' +
          '需要你先把网关起起来（app.kernel.listen({ host, port })）',
      );
    }
    return cluster;
  };

  return {
    name: 'cluster',
    config: {
      gatewayHost: { type: 'string', default: '127.0.0.1' },
      // 0 = 由系统分配（gossip 广播实际端口），也就不会与 httpPlugin 的默认端口冲突
      gatewayPort: { type: 'number', default: 0, min: 0 },
      autoListen: { type: 'boolean', default: true },
    },
    kernelPlugins: [kernelPlugins.cluster(options)],

    async onReady(application: Application): Promise<void> {
      app = application;
      const config = application.config;
      const autoListen = options.autoListen ?? config.get<boolean>('plugins.cluster.autoListen');
      if (!autoListen) return;

      const host = options.gatewayHost ?? config.get<string>('plugins.cluster.gatewayHost');
      const port = options.gatewayPort ?? config.get<number>('plugins.cluster.gatewayPort');
      const system = application.kernel as ClusterKernelSystem;
      await system.listen({ host, port });
      // 读**实际**绑定地址：端口传 0 时请求值与结果不同，端口被占用时内核会抛错而不是静默改口
      const server = system.server;
      gateway = server ? { host: server.host, port: server.boundPort } : { host, port };
      // 默认端口是 0（随机的），所以要把它打出来——否则运维没法配防火墙规则。
      // 与 httpPlugin 的启动日志同一约定。
      // console-ok: 内核插件没有 app 引用（拿不到统一出口）；这一条是内核插件自带的可观测性
      console.log(`[@actor/app] cluster gateway listening on ${gateway.host}:${String(gateway.port)}`);
    },

    address: () => (gateway ? { ...gateway } : null),

    gossipAddress() {
      const gossip = kernelSystem()?.cluster?.gossip;
      if (!gossip) return null;
      return { host: gossip.advertiseHost, port: gossip.boundPort ?? gossip.port };
    },

    waitFor: (actorPath: string, timeoutMs?: number) =>
      requireCluster().waitFor(actorPath, timeoutMs),

    remoteActors: () => requireCluster().remoteActors(),

    peers: () => requireCluster().peers(),
  };
}
