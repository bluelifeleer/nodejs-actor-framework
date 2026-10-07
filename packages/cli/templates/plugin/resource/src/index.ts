import { defineResourceAdapter, type AdapterConnectInput } from '@actor/resource';

/**
 * __PLUGIN_NAME__：一个受管资源适配器。
 *
 * 只实现"怎么连、怎么探活、怎么关"，**生命周期**（状态机/事件/drain/幂等关闭）交给框架的
 * `supervise()`（`resourceAdapter()` 装载时会自动接上）。契约套件在 `test/contract.test.ts`。
 */
export const __PLUGIN_CAMEL__ = defineResourceAdapter({
  kind: '__PLUGIN_NAME__',
  driverPackage: '(内置)',
  connectionKind: 'url',

  async connect({ connection }: AdapterConnectInput) {
    // 换成你的驱动。注意：连不上就**抛错**（框架会 fail-fast，不静默降级）
    return {
      client: { ping: () => 'pong' },
      healthCheck: async () => {},
      keepAlive: async () => {},
      close: async () => {},
      stats: () => ({ kind: '__PLUGIN_NAME__', url: connection.url ?? null }),
    };
  },
});

export default __PLUGIN_CAMEL__;
