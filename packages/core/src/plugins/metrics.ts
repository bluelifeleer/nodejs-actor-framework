// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const { Metrics } = require('../obs/metrics.ts');
const MetricsExporter = require('../obs/metrics-exporter.ts');

/**
 * Metrics plugin: folds actor counters into the existing metrics store, and
 * optionally serves them on the existing Prometheus endpoint.
 *
 * Counters live on the ActorCell (in the main thread), so the plugin samples
 * them on an interval and forwards the *delta* — the same contract the queue
 * runtime's workers used, which is why `metrics.js` and `metrics-exporter.js`
 * are reused unchanged.
 *
 *   createSystem({
 *     plugins: [metrics({ intervalMs: 500, exporter: { enabled: true, port: 9464 } })],
 *   })
 */
/** 指标实例（内核的 obs/metrics.ts）。 */
interface MetricsLike {
  observe(path: string, delta: Record<string, number>): void;
}

interface MetricsExporterLike {
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface MetricsExporterOptions {
  host?: string;
  port?: number;
  [key: string]: unknown;
}

/** 插件配置。`intervalMs: 0` 表示不周期采集（只在 scrape 时刷新）。 */
interface MetricsPluginOptions {
  metrics?: MetricsLike;
  logDir?: string;
  intervalMs?: number;
  exporter?: MetricsExporterOptions;
  storeBackend?: string;
}

/** 结构型 system 视图（内核是 CJS，不能 import type）。 */
interface MetricsSystem {
  cells: Map<string, { path: string; counters: Record<string, number> }>;
  clock: { setInterval(cb: () => void, ms: number, options?: { unref?: boolean }): { id: number }; clearInterval(handle: { id: number } | null): void };
  metrics: MetricsLike | null;
  metricsExporter: MetricsExporterLike | null;
  collectMetrics: (() => void) | null;
}

function metrics(options: MetricsPluginOptions = {}) {
  const state: {
    metrics: MetricsLike | null;
    exporter: MetricsExporterLike | null;
    timer: { id: number } | null;
    last: Map<string, Record<string, number>>;
  } = { metrics: null, exporter: null, timer: null, last: new Map() };

  return {
    name: 'metrics',

    async setup(system: MetricsSystem) {
      const instance = options.metrics || new Metrics({ logDir: options.logDir });
      state.metrics = instance;

      const collect = (): void => {
        for (const cell of system.cells.values()) {
          const previous = state.last.get(cell.path) ?? {};
          const delta: Record<string, number> = {};
          for (const [field, value] of Object.entries(cell.counters)) {
            const grew = Number(value) - (previous[field] ?? 0);
            if (grew > 0) delta[field] = grew;
          }
          if (Object.keys(delta).length > 0) instance.observe(cell.path, delta);
          state.last.set(cell.path, { ...cell.counters });
        }
        // Forget actors that no longer exist so the state map cannot grow forever.
        for (const path of [...state.last.keys()]) {
          if (!system.cells.has(path)) state.last.delete(path);
        }
        /**
         * 审计 F8：上面只清了 `state.last`，**指标本体**（`Metrics.data`，按 actor 路径建键）从来不清 ——
         * actor id 动态时（`session-<n>`、用户 id）它会随 churn 无界增长，Prometheus 输出里也一直有已死 actor。
         * `Metrics.reset()` 早就存在，只是没有任何调用方。
         */
        const metricsData = (instance as { data?: Map<string, unknown> }).data;
        if (metricsData instanceof Map) {
          for (const path of [...metricsData.keys()]) {
            if (!system.cells.has(path)) instance.reset(path);
          }
        }
      };

      system.metrics = instance;
      system.collectMetrics = collect;
      collect();

      if (options.intervalMs !== 0) {
        // 走系统时钟：注入虚拟时钟后，指标采集也可以被 advance() 瞬时推进
        state.timer = system.clock.setInterval(collect, options.intervalMs ?? 500, { unref: true });
      }

      if (options.exporter) {
        const exporter = new MetricsExporter({
          ...(options.exporter ?? {}),
          metrics: instance,
          framework: system,
          storeBackend: options.storeBackend || 'file',
          // Refresh the counters at scrape time so a scrape is never stale.
          collectors: [() => {
            collect();
            return [];
          }],
        });
        try {
          await exporter.listen();
        } catch (err) {
          // Name the subsystem and address: a bare "plugin setup failed" hides
          // which port is actually taken.
          const exporterOptions = options.exporter ?? {};
          const where = `${exporterOptions.host ?? '127.0.0.1'}:${exporterOptions.port === undefined ? '' : exporterOptions.port}`;
          const wrapped = new Error(`metrics exporter could not listen on ${where}: ${(err as Error).message}`);
          wrapped.cause = err;
          throw wrapped;
        }
        state.exporter = exporter;
        system.metricsExporter = exporter;
      }
    },

    async teardown(system: MetricsSystem | null) {
      if (state.timer !== null && system !== null) system.clock.clearInterval(state.timer);
      state.timer = null;
      if (state.exporter) await state.exporter.close().catch(() => {});
      state.exporter = null;
      state.last.clear();
      if (system) {
        system.metrics = null;
        system.metricsExporter = null;
        system.collectMetrics = null;
      }
    },
  };
}

module.exports = metrics;
module.exports.metrics = metrics;
