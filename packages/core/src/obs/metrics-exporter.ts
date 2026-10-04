'use strict';

const http = require('http');
const config = require('../config.ts');

/**
 * Prometheus metrics endpoint.
 *
 * Exposes the framework's counters and cluster gauges in the Prometheus text
 * exposition format, which the OpenTelemetry Collector can also scrape via its
 * `prometheus` receiver — so no SDK dependency is needed for either ecosystem.
 *
 * The endpoint is read-only, binds loopback by default and is opt-in
 * (ACTOR_METRICS_ENABLED=1).
 */

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLabels(labels) {
  const keys = Object.keys(labels || {});
  if (keys.length === 0) return '';
  const parts = keys.sort().map((key) => `${key}="${escapeLabelValue(labels[key])}"`);
  return `{${parts.join(',')}}`;
}

/** Render families into the Prometheus text format deterministically. */
function renderFamilies(families) {
  const lines = [];
  for (const family of families) {
    if (!family.samples || family.samples.length === 0) continue;
    lines.push(`# HELP ${family.name} ${family.help}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    const samples = [...family.samples].sort((a, b) => {
      const la = JSON.stringify(a.labels || {});
      const lb = JSON.stringify(b.labels || {});
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    for (const sample of samples) {
      lines.push(`${family.name}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

class MetricsExporter {
  /**
   * @param {{host?:string, port?:number, path?:string, metrics:object,
   *          framework?:ActorSystem, storeBackend?:string}} options
   */
  constructor(options = {}) {
    this.host = options.host || config.metrics.exporter.host;
    this.port = options.port === undefined ? config.metrics.exporter.port : options.port;
    this.path = options.path || config.metrics.exporter.path;
    this.metrics = options.metrics;
    this.storeBackend = options.storeBackend;
    /** An ActorSystem: switches the cluster gauges to framework shape. */
    this.framework = options.framework || null;
    /** Extra family providers, for plugins. */
    this.collectors = options.collectors || [];
    /** Cardinality guard for per-actor series. */
    this.maxPerActorSeries = options.maxPerActorSeries || 500;
    this.server = null;
    this.boundPort = null;
    this.requests = 0;
  }

  // --- metric families ------------------------------------------------------

  _actorFamilies() {
    const snapshot = this.metrics && typeof this.metrics.snapshot === 'function' ? this.metrics.snapshot() : {};
    const families = [
      { name: 'actor_messages_received_total', type: 'counter', help: 'Messages accepted into an actor mailbox.', field: 'received' },
      { name: 'actor_messages_handled_total', type: 'counter', help: 'Messages handled successfully.', field: 'handled' },
      { name: 'actor_messages_failed_total', type: 'counter', help: 'Messages that exhausted their retries.', field: 'failed' },
      { name: 'actor_message_retries_total', type: 'counter', help: 'Message delivery retries.', field: 'retries' },
      { name: 'actor_messages_dead_lettered_total', type: 'counter', help: 'Messages moved to the dead-letter queue.', field: 'dlq' },
      { name: 'actor_messages_dropped_total', type: 'counter', help: 'Messages refused because the mailbox was full.', field: 'dropped' },
      { name: 'actor_messages_throttled_total', type: 'counter', help: 'Times an actor waited on its token bucket.', field: 'throttled' },
      { name: 'actor_messages_recovered_total', type: 'counter', help: 'Messages replayed from persistence after a restart.', field: 'recovered' },
      { name: 'actor_message_batches_total', type: 'counter', help: 'Message batches processed.', field: 'batches' },
      { name: 'actor_message_latency_seconds_total', type: 'counter', help: 'Cumulative message handling latency.', field: 'totalLatencyMs', scale: 0.001 },
      { name: 'actor_message_latency_seconds_max', type: 'gauge', help: 'Maximum observed message handling latency.', field: 'maxLatencyMs', scale: 0.001 },
      { name: 'actor_message_latency_seconds_avg', type: 'gauge', help: 'Average message handling latency.', field: 'avgLatencyMs', scale: 0.001 },
    ];

    return families.map((family) => ({
      name: family.name,
      type: family.type,
      help: family.help,
      samples: Object.entries(snapshot).map(([actor, values]) => ({
        labels: { actor },
        value: (values[family.field] || 0) * (family.scale || 1),
      })),
    }));
  }

  /** Store + process metrics, shared by the queue-shaped and framework-shaped views. */
  _commonFamilies() {
    const families = [];
    if (this.storeBackend) {
      families.push({
        name: 'actor_store_info',
        type: 'gauge',
        help: 'Active persistence backend (always 1; see the backend label).',
        samples: [{ labels: { backend: this.storeBackend }, value: 1 }],
      });
    }

    const memory = process.memoryUsage();
    families.push({
      name: 'actor_process_resident_memory_bytes',
      type: 'gauge',
      help: 'Resident set size of the main process.',
      samples: [{ labels: {}, value: memory.rss }],
    });
    families.push({
      name: 'actor_process_heap_used_bytes',
      type: 'gauge',
      help: 'Heap used by the main process.',
      samples: [{ labels: {}, value: memory.heapUsed }],
    });
    families.push({
      name: 'actor_process_uptime_seconds',
      type: 'gauge',
      help: 'Process uptime.',
      samples: [{ labels: {}, value: process.uptime() }],
    });
    families.push({
      name: 'actor_metrics_scrapes_total',
      type: 'counter',
      help: 'Scrapes served by this endpoint.',
      samples: [{ labels: {}, value: this.requests }],
    });
    return families;
  }

  /**
   * Framework-shaped gauges, read from an ActorSystem instead of the queue
   * runtime's registry/supervisor. Per-actor series are capped so a system with
   * thousands of actors cannot blow up Prometheus cardinality.
   */
  _frameworkFamilies() {
    const system = this.framework;
    const families = [];
    const stats = system.stats();
    const remoteActors = system.cluster && typeof system.cluster.remoteActors === 'function'
      ? system.cluster.remoteActors().length
      : 0;

    families.push({
      name: 'actor_cluster_actors',
      type: 'gauge',
      help: 'Actors running on this node.',
      samples: [{ labels: {}, value: stats.actors }],
    });
    families.push({
      name: 'actor_cluster_remote_actors',
      type: 'gauge',
      help: 'Actors of other nodes known through gossip.',
      samples: [{ labels: {}, value: remoteActors }],
    });
    const gossipPeers = system.cluster && typeof system.cluster.peers === 'function'
      ? system.cluster.peers().length
      : stats.peers;
    families.push({
      name: 'actor_cluster_peers',
      type: 'gauge',
      help: 'Peer nodes known to this node (gossip when the cluster plugin is installed).',
      samples: [{ labels: {}, value: gossipPeers }],
    });
    families.push({
      name: 'actor_mailbox_depth_total',
      type: 'gauge',
      help: 'Messages queued across all actors.',
      samples: [{ labels: {}, value: stats.mailboxDepth }],
    });
    families.push({
      name: 'actor_dead_letters',
      type: 'gauge',
      help: 'Dead letters held in memory.',
      samples: [{ labels: {}, value: stats.deadLetters }],
    });
    families.push({
      name: 'actor_dead_lettered_total',
      type: 'counter',
      help: 'Messages dead-lettered by any actor.',
      samples: [{ labels: {}, value: stats.deadLettered }],
    });
    families.push({
      name: 'actor_scheduler_scheduled',
      type: 'gauge',
      help: 'Actors waiting for a turn.',
      samples: [{ labels: {}, value: stats.scheduled }],
    });

    const root = stats.rootSupervisor;
    families.push({
      name: 'actor_supervisor_restarts_in_window',
      type: 'gauge',
      help: 'Restarts recorded inside the restart-intensity window.',
      samples: [{ labels: { supervisor: root.id }, value: root.restartsInWindow }],
    });
    families.push({
      name: 'actor_supervisor_escalations_total',
      type: 'counter',
      help: 'Times a supervisor gave up and escalated.',
      samples: [{ labels: { supervisor: root.id }, value: root.escalations }],
    });

    let workers = 0;
    const perActor = [];
    for (const cell of system.cells.values()) {
      if (cell.isolation === 'worker') workers += 1;
      if (perActor.length < this.maxPerActorSeries) {
        perActor.push({ labels: { actor: cell.path }, value: cell.mailbox.size });
      }
    }
    families.push({
      name: 'actor_isolated_actors',
      type: 'gauge',
      help: 'Actors running in their own worker thread.',
      samples: [{ labels: {}, value: workers }],
    });
    if (perActor.length > 0) {
      families.push({
        name: 'actor_mailbox_depth',
        type: 'gauge',
        help: `Queued messages per actor (capped at ${this.maxPerActorSeries} series).`,
        samples: perActor,
      });
    }

    if (system.pubsub) {
      families.push({
        name: 'actor_pubsub_topics',
        type: 'gauge',
        help: 'Pub/sub topics with at least one subscriber.',
        samples: [{ labels: {}, value: system.pubsub.topics().length }],
      });
    }

    return families;
  }

  /** All families, in a stable order. */
  snapshot() {
    // Collectors run first: a scraper must see the counters as of this scrape,
    // not as of the last sampling interval.
    for (const collector of this.collectors) collector(this);

    const families = this._actorFamilies();
    if (this.framework) families.push(...this._frameworkFamilies());
    families.push(...this._commonFamilies());
    return families;
  }

  render() {
    return renderFamilies(this.snapshot());
  }

  // --- HTTP ----------------------------------------------------------------

  _handle(req, res) {
    const url = req.url.split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('method not allowed\n');
      return;
    }
    if (url !== this.path) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    this.requests += 1;
    let body;
    try {
      body = this.render();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`metrics rendering failed: ${err.message}\n`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      this.server = server;
      server.on('error', (err) => reject(err));
      server.listen(this.port, this.host, () => {
        this.boundPort = server.address().port;
        this.port = this.boundPort;
        resolve(this.boundPort);
      });
    });
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }
}

module.exports = MetricsExporter;
module.exports.MetricsExporter = MetricsExporter;
module.exports.renderFamilies = renderFamilies;
module.exports.escapeLabelValue = escapeLabelValue;
module.exports.formatValue = formatValue;
