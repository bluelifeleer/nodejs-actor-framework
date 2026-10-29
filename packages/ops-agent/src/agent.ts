import { statfs } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { collectFrameworkSnapshot, summarizeActors } from './framework.ts';
import type { ActorStatus, IngestMessage, LogEntry, LogLevel } from './protocol.ts';

export interface OpsAgentOptions {
  readonly id: string;
  readonly platformUrl: string;
  readonly token: string;
  readonly app?: string;
  readonly env?: string;
  readonly version?: string;
  readonly intervalMs?: number;
  readonly dataDir?: string;
  /** Pass the framework system (application.kernel) to collect Actor state. */
  readonly system?: unknown;
  /** Pass the Application to capture logSink and HTTP/WS connection counts. */
  readonly application?: unknown;
  readonly supervisorId?: string;
  readonly unit?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OpsAgent {
  readonly #options: OpsAgentOptions;
  readonly #intervalMs: number;
  readonly #histogram = monitorEventLoopDelay({ resolution: 20 });
  readonly #logs: LogEntry[] = [];
  #timer: NodeJS.Timeout | undefined;
  #cpu = process.cpuUsage();
  #cpuAt = Date.now();
  #originalSink: unknown;
  #wrapped = false;

  constructor(options: OpsAgentOptions) {
    this.#options = options;
    this.#intervalMs = Math.max(1000, options.intervalMs ?? 5000);
  }

  start(): void {
    this.#histogram.enable();
    this.#attachLogs();
    void this.#send([{
      type: 'hello', protocol: 1, role: 'agent', id: this.#options.id,
      ...(this.#options.app === undefined ? {} : { app: this.#options.app }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(this.#options.version === undefined ? {} : { version: this.#options.version }),
      pid: process.pid,
      capabilities: { metrics: true, logs: true, actors: true, connections: true },
    }]);
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#histogram.disable();
    this.#detachLogs();
  }

  log(entry: LogEntry): void {
    this.#logs.push(entry);
    if (this.#logs.length > 500) this.#logs.splice(0, this.#logs.length - 500);
  }

  async tick(): Promise<void> {
    const ts = Date.now();
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const elapsed = Math.max(1, Date.now() - this.#cpuAt);
    const cpuPct = Math.max(0, (((cpu.user - this.#cpu.user) + (cpu.system - this.#cpu.system)) / 1000 / elapsed) * 100);
    this.#cpu = cpu;
    this.#cpuAt = Date.now();
    let diskFree: number | undefined;
    let diskTotal: number | undefined;
    if (this.#options.dataDir !== undefined) {
      try {
        const info = await statfs(this.#options.dataDir);
        diskFree = Number(info.bavail) * Number(info.bsize);
        diskTotal = Number(info.blocks) * Number(info.bsize);
      } catch { /* data dir may not exist yet */ }
    }
    const framework = collectFrameworkSnapshot(this.#options.system);
    const connections = await this.#connections();
    await this.#send([
      { type: 'heartbeat', id: this.#options.id, ts, status: 'online' },
      {
        type: 'snapshot', id: this.#options.id, ts, status: 'online',
        metrics: {
          ts, cpuPct, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external, eventLoopP99Ms: this.#histogram.percentile(99) / 1e6,
          uptimeSec: process.uptime(),
          ...(diskFree === undefined ? {} : { diskFreeBytes: diskFree }),
          ...(diskTotal === undefined ? {} : { diskTotalBytes: diskTotal }),
        },
        connections,
        actors: summarizeActors(framework.actors),
        ...(framework.deadLetters === undefined ? {} : { deadLetters: framework.deadLetters }),
      },
    ]);
    const logs = this.#logs.splice(0, 100);
    if (logs.length > 0) await this.#send([{ type: 'logs', id: this.#options.id, entries: logs }]);
  }

  async #connections(): Promise<{ httpActive?: number; wsActive?: number }> {
    const app = this.#options.application;
    if (!isRecord(app) || typeof app['get'] !== 'function') return {};
    const get = app['get'] as (name: string) => unknown;
    const result: { httpActive?: number; wsActive?: number } = {};
    try {
      const ws = get('wsConnections');
      if (isRecord(ws) && typeof ws['ids'] === 'function') {
        const ids = (ws['ids'] as () => unknown).call(ws);
        if (Array.isArray(ids)) result.wsActive = ids.length;
      }
    } catch { /* no ws plugin */ }
    try {
      const server = get('httpServer');
      if (isRecord(server) && typeof server['getConnections'] === 'function') {
        result.httpActive = await new Promise<number>((resolve) => {
          (server['getConnections'] as (cb: (error: Error | null, count: number) => void) => void).call(server, (error, count) => resolve(error === null ? count : 0));
        });
      }
    } catch { /* no http plugin */ }
    return result;
  }

  async #send(messages: readonly IngestMessage[]): Promise<void> {
    try {
      await fetch(`${this.#options.platformUrl}/v1/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* platform unavailable must not affect the app */ }
  }

  #attachLogs(): void {
    const app = this.#options.application;
    if (!isRecord(app) || this.#wrapped || typeof app['logSink'] !== 'function') return;
    this.#originalSink = app['logSink'];
    this.#wrapped = true;
    app['logSink'] = (scope: string, event: string, meta?: Record<string, unknown>): void => {
      const level: LogLevel = event.includes('error') || event.includes('failed') ? 'error' : 'info';
      this.log({
        ts: Date.now(), level, source: 'app', event,
        ...(typeof meta?.['message'] === 'string' ? { message: meta['message'] } : {}),
        detail: { scope, ...(meta ?? {}) },
      });
      (this.#originalSink as (scope: string, event: string, meta?: Record<string, unknown>) => void)(scope, event, meta);
    };
  }

  #detachLogs(): void {
    const app = this.#options.application;
    if (isRecord(app) && this.#wrapped) {
      try { app['logSink'] = this.#originalSink; } catch { /* ignore */ }
    }
    this.#wrapped = false;
  }
}
