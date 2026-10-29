// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
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

/** Prometheus 文本格式里的标签值（转义反斜杠/引号/换行）。 */
type Labels = Record<string, string | number>;

/** 一条样本（值 + 标签）。 */
interface Sample {
  labels: Labels;
  value: number;
}

/** 一个指标族（Prometheus 的 HELP/TYPE + 样本）。 */
interface Family {
  name: string;
  type: 'counter' | 'gauge';
  help: string;
  samples: Sample[];
}

/** 族提供者：可以在一次抓取前刷新计数器（插件用）。 */
type Collector = (exporter: MetricsExporter) => void;

/** 指标实例的最小视图（obs/metrics.ts 的 Metrics）。 */
interface MetricsLike {
  snapshot(): Record<string, Record<string, number>>;
}

/** 框架（ActorSystem）的最小视图：只列导出用到的成员。 */
interface FrameworkStats {
  actors: number;
  peers: number;
  mailboxDepth: number;
  deadLetters: number;
  deadLettered: number;
  scheduled: number;
  rootSupervisor: { id: string; restartsInWindow: number; escalations: number };
  [key: string]: unknown;
}

interface FrameworkLike {
  stats(): FrameworkStats;
  cells: Map<string, { isolation?: string; path: string; counters: Record<string, number>; mailbox: { size: number } }>;
  pubsub?: { topics(): string[] } | null;
  cluster?: {
    remoteActors?(): unknown[];
    peers?(): unknown[];
    claims?(): unknown[];
    metrics?(): Record<string, unknown>;
    quorum?: { size?: number; healthy?: number; total?: number };
  } | null;
  memory?: { [key: string]: unknown };
  persistence?: unknown;
}

interface MetricsExporterOptions {
  host?: string;
  port?: number;
  path?: string;
  metrics: MetricsLike;
  framework?: FrameworkLike | null;
  storeBackend?: string;
  collectors?: Collector[];
  maxPerActorSeries?: number;
  /** 非回环 + 无 TLS/鉴权时仍要监听的显式许可（默认拒绝）。 */
  allowInsecureBinding?: boolean;
}

function escapeLabelValue(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatValue(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLabels(labels: Labels | null | undefined): string {
  const keys = Object.keys(labels || {});
  if (keys.length === 0) return '';
  const source = labels as Labels;
  const parts = keys.sort().map((key) => `${key}="${escapeLabelValue(source[key])}"`);
  return `{${parts.join(',')}}`;
}

/** Render families into the Prometheus text format deterministically. */
function renderFamilies(families: Family[]): string {
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
  readonly host: string;
  port: number;
  readonly path: string;
  readonly metrics: MetricsLike;
  readonly storeBackend: string | undefined;
  /** 传了框架就额外导出集群/进程相关的 gauge。 */
  readonly framework: FrameworkLike | null;
  /** 额外的族提供者（插件用）。 */
  readonly collectors: Collector[];
  /** 每 actor 序列的基数上限（防止 Prometheus 基数爆炸）。 */
  readonly maxPerActorSeries: number;
  readonly allowInsecureBinding: boolean;
  server: import('node:http').Server | null;
  /** 实际监听端口（`port: 0` 时由系统分配）。 */
  boundPort: number | null;
  /** 已服务的抓取次数。 */
  requests: number;

  constructor(options: MetricsExporterOptions) {
    this.host = options.host ?? (config.metrics.exporter.host as string);
    this.port = options.port === undefined ? (config.metrics.exporter.port as number) : options.port;
    this.path = options.path ?? (config.metrics.exporter.path as string);
    this.metrics = options.metrics;
    this.storeBackend = options.storeBackend;
    this.framework = options.framework ?? null;
    this.collectors = options.collectors ?? [];
    this.maxPerActorSeries = options.maxPerActorSeries ?? 500;
    this.allowInsecureBinding = options.allowInsecureBinding === true;
    this.server = null;
    this.boundPort = null;
    this.requests = 0;
  }

  // --- metric families ------------------------------------------------------

  _actorFamilies(): Family[] {
    const snapshot = this.metrics.snapshot();
    const families: { name: string; type: 'counter' | 'gauge'; help: string; field: string; fallback?: string; scale?: number }[] = [
      { name: 'actor_messages_received_total', type: 'counter', help: 'Messages accepted into an actor mailbox.', field: 'received' },
      { name: 'actor_messages_handled_total', type: 'counter', help: 'Messages handled successfully.', field: 'handled' },
      { name: 'actor_messages_failed_total', type: 'counter', help: 'Messages that exhausted their retries.', field: 'failed' },
      { name: 'actor_message_retries_total', type: 'counter', help: 'Message delivery retries.', field: 'retries' },
      { name: 'actor_messages_dead_lettered_total', type: 'counter', help: 'Messages moved to the dead-letter queue.', field: 'deadLettered', fallback: 'dlq' },
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
        value: (values[family.field] ?? (family.fallback === undefined ? 0 : values[family.fallback]) ?? 0) * (family.scale ?? 1),
      })),
    }));
  }

  /** Store + process metrics, shared by the queue-shaped and framework-shaped views. */
  _commonFamilies(): Family[] {
    const families: Family[] = [];
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
  _frameworkFamilies(): Family[] {
    const system = this.framework;
    if (system === null) return [];
    const families: Family[] = [];
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
    const perActor: Sample[] = [];
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
  snapshot(): Family[] {
    // Collectors run first: a scraper must see the counters as of this scrape,
    // not as of the last sampling interval.
    for (const collector of this.collectors) collector(this);

    const families = this._actorFamilies();
    if (this.framework) families.push(...this._frameworkFamilies());
    families.push(...this._commonFamilies());
    return families;
  }

  render(): string {
    return renderFamilies(this.snapshot());
  }

  // --- HTTP ----------------------------------------------------------------

  _handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    const url = (req.url ?? '').split('?')[0];
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
    let body: string;
    try {
      body = this.render();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`metrics rendering failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /**
   * 指标端点默认只绑回环。非回环地址意味着把 actor 路径、死信数、集群规模
   * 暴露给整个网络；与 Gateway/WS/Console 同一套默认拒绝语义。
   */
  assertSafeBinding(): void {
    const loopback = this.host === '127.0.0.1' || this.host === '::1' || this.host === 'localhost' || this.host.startsWith('127.');
    if (!loopback && !this.allowInsecureBinding) {
      throw new Error(
        `refusing to bind the metrics endpoint on ${this.host} without an explicit allowInsecureBinding: ` +
          'it would expose actor metadata to the network',
      );
    }
  }

  /** 开始监听；返回实际端口（`port: 0` 时由系统分配）。 */
  listen(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      try {
        this.assertSafeBinding();
      } catch (err) {
        reject(err);
        return;
      }
      const server = http.createServer((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => this._handle(req, res));
      this.server = server;
      server.on('error', (err: Error) => reject(err));
      server.listen(this.port, this.host, () => {
        const address = server.address();
        const port = address !== null && typeof address === 'object' ? address.port : this.port;
        this.boundPort = port;
        this.port = port;
        resolve(port);
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }
}

module.exports = MetricsExporter;
module.exports.MetricsExporter = MetricsExporter;
module.exports.renderFamilies = renderFamilies;
module.exports.escapeLabelValue = escapeLabelValue;
module.exports.formatValue = formatValue;
