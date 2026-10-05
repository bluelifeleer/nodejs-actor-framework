import { plugins as kernelPlugins } from 'nodejs-actor-framework';

import type { PluginSpec } from './assembly.ts';

/**
 * 内置能力的应用层包装（M1 步骤 4）。
 *
 * 刻意**不做自动挂载**：用户在 `defineApp({ plugins: [...] })` 里显式启用哪一项，
 * 内核才装上哪一项——这既让能力边界清晰，也让内核的加载面可控（不再一次性挂上全部能力）。
 *
 * 这些包装只做两件事：起个稳定的应用层名字、把内核插件交出去（内核类型不出现在签名里）。
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
/** 集群（gossip 发现 + 跨节点寻址）。 */
export const clusterPlugin = wrap('cluster', kernelPlugins.cluster);
