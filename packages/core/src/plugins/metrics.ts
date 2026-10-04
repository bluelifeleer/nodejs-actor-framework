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
function metrics(options = {}) {
  const state = { metrics: null, exporter: null, timer: null, last: new Map() };

  return {
    name: 'metrics',

    async setup(system) {
      const instance = options.metrics || new Metrics({ logDir: options.logDir });
      state.metrics = instance;

      const collect = () => {
        for (const cell of system.cells.values()) {
          const previous = state.last.get(cell.path) || {};
          const delta = {};
          for (const [field, value] of Object.entries(cell.counters)) {
            const grew = value - (previous[field] || 0);
            if (grew > 0) delta[field] = grew;
          }
          if (Object.keys(delta).length > 0) instance.observe(cell.path, delta);
          state.last.set(cell.path, { ...cell.counters });
        }
        // Forget actors that no longer exist so the state map cannot grow forever.
        for (const path of [...state.last.keys()]) {
          if (!system.cells.has(path)) state.last.delete(path);
        }
      };

      system.metrics = instance;
      system.collectMetrics = collect;
      collect();

      if (options.intervalMs !== 0) {
        state.timer = setInterval(collect, options.intervalMs || 500);
        if (typeof state.timer.unref === 'function') state.timer.unref();
      }

      if (options.exporter) {
        const exporter = new MetricsExporter({
          ...options.exporter,
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
          const where = `${options.exporter.host || '127.0.0.1'}:${
            options.exporter.port === undefined ? '' : options.exporter.port}`;
          const wrapped = new Error(`metrics exporter could not listen on ${where}: ${err.message}`);
          wrapped.cause = err;
          throw wrapped;
        }
        state.exporter = exporter;
        system.metricsExporter = exporter;
      }
    },

    async teardown(system) {
      if (state.timer) clearInterval(state.timer);
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
