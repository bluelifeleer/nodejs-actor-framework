// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const net = require('net');
const crypto = require('crypto');
const config = require('../config.ts');
const { resolveActorModule } = require('../worker/worker-delegate.ts');

// A path is one or more segments; "." and ".." are rejected below so a console
// user cannot sneak a traversal-looking string past validation.
const ACTOR_PATH_RE = /^[A-Za-z0-9._:-]+(\/[A-Za-z0-9._:-]+)*$/;
const ACTOR_ID_RE = ACTOR_PATH_RE;

function isSafePath(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  if (!ACTOR_PATH_RE.test(value)) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}
const BANNER = [
  '=== Actor Framework Console (framework model) ===',
  'actors | inspect [path] | state [path] | system',
  'tell [path] json | ask [path] json | hurt [path] [damage] | getState [path]',
  'spawn [path] [modulePath] [inline|worker] | kill [path] | crash [path]',
  'sup info | dlq list|size|clear | metrics dump',
  'pub sub|unsub [topic] [path] | pub pub [topic] json | pub topics | pub subs [topic]',
  'cluster info | cluster lookup [path] | peer ping [host] [port] | exit',
].join('\n');

function tokenEquals(a: unknown, b: unknown): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 按日志器的**实际形状**调用：函数直接调，对象走 `logSystem`（保留 `this`）。 */
function logEvent(logger: ConsoleLogger | undefined, event: string, meta?: Record<string, unknown>): void {
  if (logger === undefined || logger === null) return;
  if (typeof logger === 'function') {
    logger(event, meta);
    return;
  }
  if (typeof logger.logSystem === 'function') logger.logSystem(event, meta);
}

function parseJson(raw: string | undefined, what: string): unknown {
  if (raw === undefined || raw === '') throw new Error(`${what} must be JSON`);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${what} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Telnet debug console for a framework node.
 *
 * It only ever talks to the framework's public API (`system.resolve`,
 * `ActorRef.tell/ask/stop`, `system.stats()`, `system.readDeadLetters()`, the
 * cluster/pubsub services), which is why no runtime internals leak in here.
 *
 * Kept from the previous implementation: line buffering, optional token auth
 * (required on non-loopback binds), input validation, bounded line length and
 * connection count, and an empty line re-prompting instead of closing.
 */
/** 控制台依赖的系统视图（只列它用到的，框架的公开面）。 */
interface ConsoleSystem {
  resolve(target: string): {
    readonly path?: string;
    tell(msg: unknown): boolean;
    ask(msg: unknown, timeoutMs?: number): Promise<unknown>;
    stop(): Promise<void>;
    state?(): unknown;
    inspect?(): Record<string, unknown>;
  } | null;
  spawn(definition: unknown, options?: Record<string, unknown>): Promise<{ path?: string; id?: string }>;
  stats(): Record<string, unknown>;
  readDeadLetters(): Promise<unknown[]>;
  clearDeadLetters(): Promise<number>;
  listActors(): string[];
  inspect(target: string): Record<string, unknown>;
  stop(target?: unknown): Promise<void>;
  cluster?: {
    readonly port?: number;
    gossip?: { nodeId: string };
    nodes?(): string[];
    peers?(): { host: string; port: number; lastSeen: number; failures: number }[];
    remoteActors?(): string[];
    info?(): unknown;
    lookup?(path: string): unknown;
    waitFor?(path: string, timeoutMs?: number): Promise<unknown>;
    [key: string]: unknown;
  } | null;
  connect(options: { host: string; port: number; timeoutMs?: number }): Promise<{ ping?(): Promise<boolean> }>;
  pubsub?: {
    topics(): string[];
    subscribers(topic: string): string[];
    subscribe(topic: string, target: string): boolean;
    unsubscribe(topic: string, target: string): boolean;
    publish(topic: string, msg: Record<string, unknown>): Promise<unknown>;
  } | null;
  metrics?: { dump(options?: Record<string, unknown>): unknown } | null;
  [key: string]: unknown;
}

/**
 * 控制台可用的日志器：**两种形状都支持** —— 内核的 `(event, meta)` 函数，
 * 或 `obs/logger.ts` 的 Logger 实例（对象，带 `logSystem`）。
 *
 * 两种必须分别调用：把对象当函数调用会丢掉 `this`（Logger 内部要用 `this._write`），
 * 于是认证失败本该写的那条日志直接抛错，连给客户端的 `ERR:` 都发不出去（被测试抓到过）。
 */
type ConsoleLogger =
  | ((event: string, meta?: Record<string, unknown>) => void)
  | { logSystem?(event: string, meta?: Record<string, unknown>): void };

/** 嵌入方可以替换的服务与配置（缺省从 system 上取）。 */
interface ConsoleContext {
  system?: ConsoleSystem;
  logger?: ConsoleLogger;
  cluster?: ConsoleSystem['cluster'];
  pubsub?: ConsoleSystem['pubsub'];
  metrics?: ConsoleSystem['metrics'];
  config?: typeof config;
  /** `spawn` 命令没给模块路径时用的默认 Actor 定义。 */
  defaultActorDefinition?: unknown;
}

interface TelnetConsoleOptions {
  host?: string;
  port?: number;
  token?: string | null;
  maxLineBytes?: number;
  maxConnections?: number;
  context?: ConsoleContext;
  logger?: ConsoleLogger;
}

/** 一条连接的会话状态。 */
interface ConsoleSession {
  authed: boolean;
  buffer: string;
}

class TelnetConsole {
  readonly host: string;
  port: number;
  readonly token: string | null;
  readonly maxLineBytes: number;
  readonly maxConnections: number;
  readonly ctx: ConsoleContext;
  readonly logger: ConsoleLogger | undefined;
  server: import('node:net').Server | null;
  /** 实际监听端口（`port: 0` 时由系统分配）。 */
  boundPort: number | null;
  readonly sockets: Set<import('node:net').Socket>;

  constructor(options: TelnetConsoleOptions = {}) {
    this.host = options.host ?? (config.telnet.host as string);
    this.port = options.port === undefined ? (config.telnet.port as number) : options.port;
    this.token = options.token ?? (config.telnet.token as string | null);
    this.maxLineBytes = options.maxLineBytes ?? (config.telnet.maxLineBytes as number);
    this.maxConnections = options.maxConnections ?? (config.telnet.maxConnections as number);
    this.ctx = options.context ?? {};
    this.logger = options.logger ?? this.ctx.logger;
    this.server = null;
    this.boundPort = null;
    this.sockets = new Set();
  }

  get requiresAuth(): boolean {
    return Boolean(this.token);
  }

  get system(): ConsoleSystem {
    if (!this.ctx.system) throw new Error('console has no actor system attached');
    return this.ctx.system;
  }

  /** 非回环地址必须配 token（控制台能 spawn/stop Actor）。 */
  assertSafeBinding(): void {
    const isLoopback = this.host === '127.0.0.1' || this.host === '::1' || this.host === 'localhost';
    if (!isLoopback && !this.token) {
      throw new Error(
        `refusing to expose the console on ${this.host} without ACTOR_TELNET_TOKEN ` +
          '(the console can spawn and stop actors)',
      );
    }
  }

  listen(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.assertSafeBinding();
      const server = net.createServer((socket: import('node:net').Socket) => this._onConnection(socket));
      this.server = server;
      server.on('error', (err: Error) => reject(err));
      server.maxConnections = this.maxConnections;
      server.listen(this.port, this.host, () => {
        const address = server.address();
        const port = address !== null && typeof address === 'object' ? address.port : this.port;
        this.boundPort = port;
        this.port = port;
        resolve(port);
      });
    });
  }

  _onConnection(socket: import('node:net').Socket): void {
    this.sockets.add(socket);
    const session: ConsoleSession = { authed: !this.requiresAuth, buffer: '' };

    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));

    socket.write(`${BANNER}\n> `);

    socket.on('data', (chunk) => {
      session.buffer += chunk.toString('utf8');
      if (Buffer.byteLength(session.buffer, 'utf8') > this.maxLineBytes) {
        socket.write('ERR: line too long\n');
        session.buffer = '';
        return;
      }
      let idx;
      while ((idx = session.buffer.indexOf('\n')) >= 0) {
        const rawLine = session.buffer.slice(0, idx);
        session.buffer = session.buffer.slice(idx + 1);
        this._handleLine(rawLine.replace(/\r$/, ''), socket, session);
        if (socket.destroyed) return;
      }
    });
  }

  async _handleLine(line: string, socket: import('node:net').Socket, session: ConsoleSession): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '') {
      socket.write('> ');
      return;
    }
    if (trimmed === 'exit' || trimmed === 'quit') {
      socket.end('bye\n');
      return;
    }

    if (!session.authed) {
      const [cmd, ...rest] = trimmed.split(/\s+/);
      if (cmd !== 'auth' || !tokenEquals(rest.join(' ').trim(), this.token)) {
        logEvent(this.logger, 'telnet_auth_failed');
        socket.end('ERR: authentication required (auth <token>)\n');
        return;
      }
      session.authed = true;
      socket.write('authenticated\n> ');
      return;
    }

    let out;
    try {
      out = await this._dispatch(trimmed);
    } catch (err) {
      out = `ERR:${err instanceof Error ? err.message : String(err)}`;
    }
    if (out === undefined || out === null) out = 'ok';
    socket.write(`${out}\n> `);
  }

  // --- command dispatch ----------------------------------------------------

  async _dispatch(line: string): Promise<unknown> {
    const parts = line.split(/\s+/);
    const cmd = parts[0];
    const system = this.system;
    // Services live on the system (attached by their plugins); the context is
    // only a fallback so an embedder can substitute them.
    const cluster = this.ctx.cluster || system.cluster || null;
    const pubsub = this.ctx.pubsub || system.pubsub || null;
    const metrics = this.ctx.metrics || system.metrics || null;
    const timeoutMs = this.ctx.config?.actor?.requestTimeoutMs ?? config.actor.requestTimeoutMs;

    switch (cmd) {
      case 'help':
        return BANNER;

      case 'actors':
        return `actors:${JSON.stringify(system.listActors())}`;

      case 'system':
        return `system:${JSON.stringify(system.stats())}`;

      case 'inspect': {
        const path = this._path(parts[1]);
        return `inspect:${JSON.stringify(system.inspect(path))}`;
      }

      case 'state': {
        const ref = this._ref(parts[1]);
        if (typeof ref.state !== 'function') throw new Error('state() is local-only');
        return `state:${JSON.stringify(await ref.state())}`;
      }

      case 'tell': {
        const target = parts[1] ?? '';
        const ref = this._ref(target);
        const payload = parseJson(line.slice(line.indexOf(target) + target.length).trim(), 'payload');
        const accepted = ref.tell(payload);
        return `tell ${ref.path} -> ${accepted ? 'accepted' : 'rejected (mailbox full or stopped)'}`;
      }

      case 'ask':
      case 'send': {
        const target = parts[1] ?? '';
        const ref = this._ref(target);
        const payload = parseJson(line.slice(line.indexOf(target) + target.length).trim(), 'payload');
        return `reply:${JSON.stringify(await ref.ask(payload, timeoutMs))}`;
      }

      case 'hurt': {
        const ref = this._ref(parts[1]);
        const damage = Number(parts[2]);
        if (!Number.isFinite(damage)) throw new Error(`damage must be a finite number, got "${parts[2]}"`);
        if (parts[3] !== undefined) {
          throw new Error(
            'priority was removed: the actor model is a single FIFO per actor ' +
              '(see README "不做优先级邮箱")',
          );
        }
        const hp = await ref.ask({ type: 'hurt', damage }, timeoutMs);
        return `OK hp=${hp}`;
      }

      case 'getState': {
        const ref = this._ref(parts[1]);
        return `state:${JSON.stringify(await ref.ask({ type: 'debug:getState' }, timeoutMs))}`;
      }

      case 'spawn': {
        const path = this._path(parts[1]);
        if (system.resolve(path)) throw new Error(`actor ${path} already exists`);
        const modulePath = parts[2];
        const isolation = parts[3] || 'inline';
        if (!['inline', 'worker'].includes(isolation)) {
          throw new Error(`isolation must be inline or worker, got "${isolation}"`);
        }

        let definition;
        if (modulePath) {
          // Same containment rule the framework applies to worker modules.
          const resolved = resolveActorModule(modulePath);
          if (isolation === 'worker') {
            // A worker needs the path itself: code is loaded inside the thread.
            definition = modulePath;
          } else {
            const mod = require(resolved);
            definition = mod && mod.default !== undefined ? mod.default : mod;
          }
        } else {
          if (isolation === 'worker') {
            throw new Error("isolation 'worker' requires a module path (the code is loaded in the thread)");
          }
          // 默认定义由使用方注入（内核不得反向依赖某个应用）
          const fallback = this.ctx.defaultActorDefinition;
          if (!fallback) {
            throw new Error(
              'spawn without a module path needs a default actor definition: ' +
                'pass { context: { defaultActorDefinition } } to TelnetConsole',
            );
          }
          definition = fallback;
        }

        const ref = await system.spawn(definition, { id: path, isolation });
        return `spawn ${ref.path} ok (isolation=${isolation})`;
      }

      case 'kill': {
        const ref = this._ref(parts[1]);
        await ref.stop();
        return `kill ${ref.path} ok (intentional stop, will NOT be restarted)`;
      }

      case 'crash': {
        const ref = this._ref(parts[1]);
        try {
          await ref.ask({ type: 'debug:crash' }, timeoutMs);
          return `crash ${ref.path}: the actor returned instead of crashing`;
        } catch (err) {
          return `crash ${ref.path} -> ${err instanceof Error ? err.message : String(err)} (the supervisor will restart it)`;
        }
      }

      case 'sup': {
        if (parts[1] !== 'info') throw new Error('usage: sup info');
        const stats = system.stats();
        const actors = system.listActors().map((path) => {
          const info = system.inspect(path);
          const supervision = (info.supervision ?? {}) as {
            strategy?: unknown;
            restartsInWindow?: unknown;
            escalations?: unknown;
          };
          return {
            path,
            restarts: info.restarts,
            children: info.children,
            strategy: supervision.strategy,
            restartsInWindow: supervision.restartsInWindow,
            escalations: supervision.escalations,
          };
        });
        return `sup:${JSON.stringify({ root: stats.rootSupervisor, actors })}`;
      }

      case 'dlq': {
        if (parts[1] === 'list') return `DLQ:${JSON.stringify((await system.readDeadLetters()).slice(-50))}`;
        if (parts[1] === 'size') return `DLQ size:${(await system.readDeadLetters()).length}`;
        if (parts[1] === 'clear') {
          await system.clearDeadLetters();
          return 'DLQ cleared';
        }
        throw new Error('usage: dlq list|size|clear');
      }

      case 'metrics': {
        if (parts[1] === 'dump') {
          if (!metrics) throw new Error('metrics plugin is not installed (set ACTOR_METRICS_ENABLED=1)');
          if (typeof system.collectMetrics === 'function') system.collectMetrics();
          return `metrics:${JSON.stringify(metrics.dump({ persist: false }))}`;
        }
        if (parts[1] === 'collect') {
          if (typeof system.collectMetrics !== 'function') throw new Error('metrics plugin is not installed');
          system.collectMetrics();
          return 'metrics collected';
        }
        throw new Error('usage: metrics dump|collect');
      }

      case 'pub': {
        if (!pubsub) throw new Error('pubsub plugin is not installed');
        if (parts[1] === 'sub') {
          pubsub.subscribe(parts[2] ?? '', this._path(parts[3]));
          return `subscribe ${parts[2]} -> ${parts[3]}`;
        }
        if (parts[1] === 'unsub') {
          pubsub.unsubscribe(parts[2] ?? '', this._path(parts[3]));
          return `unsub ${parts[2]} -> ${parts[3]}`;
        }
        if (parts[1] === 'topics') return `topics:${JSON.stringify(pubsub.topics())}`;
        if (parts[1] === 'subs') return `subscribers:${JSON.stringify(pubsub.subscribers(parts[2] ?? ''))}`;
        if (parts[1] === 'pub') {
          const topic = parts[2];
          if (!topic) throw new Error('usage: pub pub [topic] json');
          const payload = parseJson(line.slice(line.indexOf(topic) + topic.length).trim(), 'payload');
          return `publish result:${JSON.stringify(await pubsub.publish(topic, payload as Record<string, unknown>))}`;
        }
        throw new Error('usage: pub sub|unsub|pub|topics|subs');
      }

      case 'cluster': {
        if (!cluster) throw new Error('cluster plugin is not installed (set ACTOR_GOSSIP_ENABLED=1)');
        if (parts[1] === 'info') {
          return `cluster:${JSON.stringify({
            nodeId: cluster.gossip?.nodeId,
            port: cluster.port,
            nodes: cluster.nodes?.() ?? [],
            peers: (cluster.peers?.() ?? []).map((peer) => ({
              address: `${peer.host}:${peer.port}`,
              live: peer.lastSeen > 0,
              failures: peer.failures,
            })),
            remoteActors: cluster.remoteActors?.() ?? [],
          })}`;
        }
        if (parts[1] === 'lookup') {
          const remote = typeof cluster.lookup === 'function' ? cluster.lookup(this._path(parts[2])) : null;
          return `lookup:${JSON.stringify(remote || null)}`;
        }
        if (parts[1] === 'wait') {
          if (typeof cluster.waitFor !== 'function') throw new Error('cluster.waitFor is unavailable');
          const meta = await cluster.waitFor(this._path(parts[2]), timeoutMs * 3);
          return `discovered:${JSON.stringify(meta)}`;
        }
        throw new Error('usage: cluster info|lookup [path]|wait [path]');
      }

      case 'peer': {
        if (parts[1] !== 'ping') throw new Error('usage: peer ping [host] [port]');
        const host = parts[2] || this.ctx.config?.gateway?.host || config.gateway.host;
        const port = Number(parts[3] || this.ctx.config?.gateway?.port || config.gateway.port);
        if (!Number.isFinite(port)) throw new Error(`port must be a number, got "${parts[3]}"`);
        const peer = await system.connect({ host, port, timeoutMs });
        const ok = typeof peer.ping === 'function' ? await peer.ping() : false;
        return `${host}:${port} -> ${ok ? 'pong' : 'no response'}`;
      }

      default:
        return `unknown command: ${cmd} (try "help")`;
    }
  }

  /** Validate an actor path (also used for ids inside a path). */
  /** 校验并规范化路径（非法就抛，而不是把可疑字符串送下去）。 */
  _path(value: unknown): string {
    if (value === undefined || value === null || value === '') throw new Error('actor path is required');
    if (!isSafePath(value)) throw new Error('actor path must match segment(/segment)* with [A-Za-z0-9._:-]');
    return value as string;
  }

  /** 把一个路径解析成 ref（解析不到就抛明确错误）。 */
  _ref(value: unknown): NonNullable<ReturnType<ConsoleSystem['resolve']>> {
    const path = this._path(value);
    const ref = this.system.resolve(path);
    if (!ref) throw new Error(`actor ${path} not found (local or discovered)`);
    return ref;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = null;
    }
  }
}

module.exports = TelnetConsole;
module.exports.TelnetConsole = TelnetConsole;
module.exports.ACTOR_ID_RE = ACTOR_ID_RE;
module.exports.isSafePath = isSafePath;
module.exports.BANNER = BANNER;
