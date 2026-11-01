import { execFile } from 'node:child_process';
import { statfs, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';

const execFileAsync = promisify(execFile);
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

async function readNetworkBytes(pid: number): Promise<{ rx?: number; tx?: number }> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('nettop', ['-P', '-L', '1', '-J', 'bytes_in,bytes_out'], { timeout: 2500 });
      for (const line of stdout.split('\n')) {
        const fields = line.trim().split(',');
        if (fields.length < 3) continue;
        if (!fields[0]?.endsWith(`.${String(pid)}`)) continue;
        return { rx: Number(fields[1]), tx: Number(fields[2]) };
      }
    } else if (process.platform === 'linux') {
      const text = await readFile(`/proc/${String(pid)}/net/dev`, 'utf8');
      let rx = 0; let tx = 0;
      for (const line of text.split('\n').slice(2)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10) continue;
        rx += Number(fields[1]); tx += Number(fields[9]);
      }
      return { rx, tx };
    }
  } catch { /* unavailable */ }
  return {};
}

function readInterfaces(): Array<{ name: string; address: string; family: string; mac: string; internal: boolean }> {
  const result: Array<{ name: string; address: string; family: string; mac: string; internal: boolean }> = [];
  try {
    for (const [name, list] of Object.entries(networkInterfaces())) for (const item of list ?? []) result.push({ name, address: item.address, family: String(item.family), mac: item.mac, internal: item.internal });
  } catch { /* ignore */ }
  return result;
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
  #replayTimer: NodeJS.Timeout | undefined;
  #controlTimer: NodeJS.Timeout | undefined;
  #cpu = process.cpuUsage();
  #cpuAt = Date.now();
  #originalSink: unknown;
  #wrapped = false;
  #helloAt = 0;

  constructor(options: OpsAgentOptions) {
    this.#options = options;
    this.#intervalMs = Math.max(1000, options.intervalMs ?? 5000);
  }

  start(): void {
    this.#histogram.enable();
    this.#attachLogs();
    void this.#hello();
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref?.();
    this.#replayTimer = setInterval(() => void this.#pollReplays(), 2000);
    this.#replayTimer.unref?.();
    this.#controlTimer = setInterval(() => void this.#pollControl(), 2000);
    this.#controlTimer.unref?.();
    void this.tick();
    void this.#pollReplays();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#replayTimer !== undefined) clearInterval(this.#replayTimer);
    this.#replayTimer = undefined;
    if (this.#controlTimer !== undefined) clearInterval(this.#controlTimer);
    this.#controlTimer = undefined;
    this.#histogram.disable();
    this.#detachLogs();
  }

  log(entry: LogEntry): void {
    this.#logs.push(entry);
    if (this.#logs.length > 500) this.#logs.splice(0, this.#logs.length - 500);
  }

  async tick(): Promise<void> {
    if (Date.now() - this.#helloAt > 30_000) await this.#hello();
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
    const network = await readNetworkBytes(process.pid);
    await this.#send([
      { type: 'heartbeat', id: this.#options.id, ts, status: 'online' },
      {
        type: 'snapshot', id: this.#options.id, ts, status: 'online',
        metrics: {
          ts, cpuPct, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external, eventLoopP99Ms: this.#histogram.percentile(99) / 1e6,
          uptimeSec: process.uptime(),
          ...(network.rx === undefined ? {} : { netRxBytes: network.rx }),
          ...(network.tx === undefined ? {} : { netTxBytes: network.tx }),
          ...(diskFree === undefined ? {} : { diskFreeBytes: diskFree }),
          ...(diskTotal === undefined ? {} : { diskTotalBytes: diskTotal }),
        },
        connections,
        actors: summarizeActors(framework.actors),
        ...(framework.deadLetters === undefined ? {} : { deadLetters: framework.deadLetters }),
        ...(framework.deadLetterEntries === undefined ? {} : { deadLetterEntries: framework.deadLetterEntries }),
        ...(framework.peers === undefined ? {} : { cluster: { node: this.#options.id, peers: framework.peers } }),
      },
    ]);
    const logs = this.#logs.splice(0, 100);
    if (logs.length > 0) await this.#send([{ type: 'logs', id: this.#options.id, entries: logs }]);
  }

  async #hello(): Promise<void> {
    this.#helloAt = Date.now();
    await this.#send([{
      type: 'hello', protocol: 1, role: 'agent', id: this.#options.id,
      ...(this.#options.app === undefined ? {} : { app: this.#options.app }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(this.#options.version === undefined ? {} : { version: this.#options.version }),
      pid: process.pid,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      network: { interfaces: readInterfaces() },
      capabilities: { metrics: true, logs: true, actors: true, connections: true },
    }]);
  }

  async #pollControl(): Promise<void> {
    try {
      const response = await fetch(`${this.#options.platformUrl}/v1/agent-commands?agentId=${encodeURIComponent(this.#options.id)}`, {
        headers: { authorization: `Bearer ${this.#options.token}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { commands?: Array<{ id: string; type: string; args: Record<string, unknown> }> };
      for (const command of body.commands ?? []) {
        let ok = true;
        let result: unknown;
        let error: string | undefined;
        try {
          const system = this.#options.system;
          if (!isRecord(system)) throw new Error('actor system is not available');
          if (command.type === 'cluster_disconnect') {
            if (typeof system['disconnectPeer'] !== 'function') throw new Error('cluster control is not available');
            const nodeId = String(command.args['nodeId'] ?? '');
            if (nodeId === '') throw new Error('nodeId is required');
            result = { disconnected: await (system['disconnectPeer'] as (target: string) => Promise<boolean>).call(system, nodeId) };
          } else if (command.type === 'cluster_connect') {
            if (typeof system['connect'] !== 'function') throw new Error('cluster connect is not available');
            const host = String(command.args['host'] ?? '');
            const port = Number(command.args['port'] ?? 0);
            if (host === '' || !Number.isFinite(port) || port <= 0) throw new Error('host/port are required');
            await (system['connect'] as (options: Record<string, unknown>) => Promise<unknown>).call(system, {
              host, port, ...(String(command.args['nodeId'] ?? '') === '' ? {} : { nodeId: String(command.args['nodeId']) }),
            });
            result = { connected: true };
          } else { ok = false; error = `unsupported control command: ${command.type}`; }
        } catch (err) { ok = false; error = err instanceof Error ? err.message : String(err); }
        try {
          await fetch(`${this.#options.platformUrl}/v1/agent-command-result`, {
            method: 'POST', headers: { authorization: `Bearer ${this.#options.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ id: command.id, agentId: this.#options.id, ok, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }),
            signal: AbortSignal.timeout(5000),
          });
        } catch { /* remain running */ }
      }
    } catch { /* platform offline */ }
  }

  async #pollReplays(): Promise<void> {
    try {
      const response = await fetch(`${this.#options.platformUrl}/v1/agent-replays?agentId=${encodeURIComponent(this.#options.id)}`, {
        headers: { authorization: `Bearer ${this.#options.token}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const body = (await response.json()) as { replays?: Array<{ id: string; actorId: string; payload: unknown }> };
      for (const replay of body.replays ?? []) {
        let ok = true;
        let error: string | undefined;
        try {
          const system = this.#options.system;
          if (!isRecord(system) || typeof system['ref'] !== 'function') throw new Error('actor system is not available');
          const ref = (system['ref'] as (path: string) => unknown).call(system, replay.actorId);
          if (!isRecord(ref) || typeof ref['tell'] !== 'function') throw new Error(`actor ${replay.actorId} not found`);
          const accepted = (ref['tell'] as (payload: unknown) => boolean).call(ref, replay.payload);
          if (accepted === false) throw new Error('actor rejected the replayed message');
        } catch (err) { ok = false; error = err instanceof Error ? err.message : String(err); }
        try {
          await fetch(`${this.#options.platformUrl}/v1/agent-replay-result`, {
            method: 'POST', headers: { authorization: `Bearer ${this.#options.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ id: replay.id, agentId: this.#options.id, ok, ...(error === undefined ? {} : { error }) }),
            signal: AbortSignal.timeout(5000),
          });
        } catch { /* retry history remains running; operator can inspect */ }
      }
    } catch { /* platform offline */ }
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
