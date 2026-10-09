// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

const path = require('path');
const fs = require('node:fs');
const { Worker } = require('worker_threads');
const config = require('../config.ts');
const { ActorDefinition } = require('../actor/actor.ts');
const { DefinitionError, ActorStoppedError } = require('../actor/errors.ts');

/**
 * Main-thread side of worker isolation.
 *
 * `isolation: 'worker'` runs the actor's code in its own thread, so a CPU-heavy
 * or native-crashing actor cannot block or corrupt the rest of the node. The
 * price is that:
 *
 *  - the definition must be a **module path** (code cannot be shipped to a
 *    worker without an eval, which this framework deliberately keeps opt-in);
 *  - messages, replies and state must be structured-cloneable;
 *  - persistence is limited to 'none' and 'snapshot' (state transfer).
 *
 * Everything else — mailbox, backpressure, supervision, restart, dead letters —
 * stays on the owning ActorCell, so the two isolation modes share one model.
 */

/**
 * Worker 宿主的入口路径。
 *
 * **优先编译产物**：包发布出去后（或被 `npm run build` 编译进 dist）运行时会在 `dist/worker/` 下，
 * 那里只有 `worker-host.js`；只有在仓库内直跑源码时才是 `worker-host.ts`。
 * 早先硬编码 `.ts`，一旦走编译/发布路线，Worker 会找不到入口 —— 这类"资产没跟着构建走"
 * 的问题只在真起 worker 时才暴露，所以门禁里有一条真的 spawn worker actor 的用例。
 */
const HOST_PATH = path.join(
  __dirname,
  fs.existsSync(path.join(__dirname, 'worker-host.js')) ? 'worker-host.js' : 'worker-host.ts',
);

/** Resolve an actor module path, refusing anything outside the project root. */
function resolveActorModule(requested: string): string {
  const root = config.root;
  const resolved = path.resolve(root, requested);
  /**
   * 审计 S15：
   *   1. 光比 `path.relative` **挡不住符号链接** —— root 里一个指向 root 外的软链就能绕过，
   *      所以对**已存在**的路径再解一次 realpath 比包含关系（不存在的路径交给后面的 require 报错）；
   *   2. `relative.startsWith('..')` 会把 root 内以 `..` 开头的**合法名字**（`..foo/x.js`）误拒，
   *      正确的边界是"等于 `..`"或"以 `..` + 分隔符开头"。
   */
  const insideRoot = (candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!insideRoot(resolved)) {
    throw new DefinitionError(`actor module must live inside ${root} (got "${requested}")`);
  }
  if (!fs.existsSync(resolved)) return resolved;
  /**
   * **两边都要解 realpath**：root 自己也可能是个软链（macOS 上 `/var` → `/private/var`，
   * 临时目录全在这条链下），只解目标那一侧会把 root 内的合法路径判成"在外面"。
   */
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const real = fs.realpathSync(resolved);
  const relativeToRealRoot = path.relative(realRoot, real);
  const insideRealRoot =
    relativeToRealRoot !== '..' &&
    !relativeToRealRoot.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeToRealRoot);
  if (!insideRealRoot) {
    throw new DefinitionError(`actor module resolves outside ${root} via a symlink (got "${requested}")`);
  }
  // realpath 只用于**检查**；返回调用方给的那条路径（root 自己可能是软链，返回 realpath 会让
  // 调用方拿到的路径与传入的形式不一致，测试与日志都会困惑）
  return resolved;
}

/** Build a Definition for an actor that will run in a worker thread. */
function defineWorkerActor(modulePath: unknown, options: { exportName?: string; actorOptions?: Record<string, unknown> } = {}): InstanceType<typeof ActorDefinition> {
  if (typeof modulePath !== 'string' || modulePath.trim() === '') {
    throw new DefinitionError(
      "isolation: 'worker' requires the actor definition to be a module path string, " +
        "e.g. spawn('./actors/player.js', { isolation: 'worker' })",
    );
  }
  const resolved = resolveActorModule(modulePath);
  const exportName = options.exportName ?? 'default';
  const name = path.basename(resolved).replace(/\.(js|cjs|mjs)$/, '');
  return new ActorDefinition({
    name,
    kind: 'worker',
    create() {
      throw new DefinitionError(`worker-isolated actor "${name}" runs in its own thread`);
    },
    options: options.actorOptions ?? {},
    modulePath: resolved,
    exportName,
  });
}

/** 一个待回复的调用（invoke 或控制类）。 */
interface PendingCall {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

/** 控制类调用（带超时定时器）。 */
interface PendingControl extends PendingCall {
  timer: NodeJS.Timeout;
}

/** 就绪门闩上的等待者。 */
interface ReadyWaiter {
  resolve(): void;
  reject(err: Error): void;
}

/** worker 发回来的消息。 */
interface WorkerReply {
  kind: string;
  seq?: number;
  callId?: number;
  pid?: number;
  error?: string;
  ok?: boolean;
  data?: unknown;
  state?: unknown;
  event?: string;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** delegate 背后的 cell（只列它真正用到的成员）。 */
interface DelegateCell {
  readonly path: string;
  readonly id: string;
  readonly ref: unknown;
  readonly system: {
    _log(event: string, meta?: Record<string, unknown>): void;
    resolve(target: string): { tell(msg: unknown, sender?: unknown, trace?: unknown): boolean; ask(msg: unknown, timeoutMs?: number, sender?: unknown, trace?: unknown): Promise<unknown>; stop(): Promise<void> } | null;
    readonly shutdownTimeoutMs: number;
  };
  spawnChild(definition: unknown, options?: Record<string, unknown>): Promise<{ id: string; path: string }>;
  saveSnapshot(): Promise<void>;
  stop(): Promise<void>;
  [key: string]: unknown;
}

/** worker 侧请求的 `ctx.*` 调用参数。 */
interface CtxCallArgs {
  definition?: unknown;
  options?: Record<string, unknown>;
  target?: unknown;
  msg?: unknown;
  trace?: unknown;
  timeoutMs?: number;
}

class WorkerDelegate {
  readonly cell: DelegateCell;
  readonly modulePath: string;
  readonly exportName: string;
  worker: (import('node:worker_threads').Worker & { __dead?: boolean }) | null;
  /** worker 侧的调用（invoke）等待表。 */
  readonly invokePending: Map<number, PendingCall>;
  /** 控制类调用（snapshot/stop/ctx_*）等待表：键是 `seq:<n>` 或 `ctx:<n>`。 */
  readonly controlPending: Map<string, PendingControl>;
  seq: number;
  stopped: boolean;
  pid: number | null;
  /**
   * 就绪门闩：`start()` 返回前 worker 仍在加载 actor 模块（此时 worker 里的
   * `instance` 还是 null）。这段时间内如果外部调用 `getState()`（例如
   * `ref.state()` 或崩溃重启后的 `saveSnapshot()`），worker 会回一个空状态，
   * 调用方拿到 `undefined` —— 静默丢状态。所以控制类调用必须先等门闩打开。
   */
  ready: boolean;
  /** 门闩上的等待者（超时/worker 丢失时都要唤醒，避免永久挂起）。 */
  readonly _readyWaiters: ReadyWaiter[];

  constructor({ cell, modulePath, exportName }: { cell: DelegateCell; modulePath: string; exportName: string }) {
    this.cell = cell;
    this.modulePath = modulePath;
    this.exportName = exportName;
    this.worker = null;
    this.invokePending = new Map();
    this.controlPending = new Map();
    this.seq = 0;
    this.stopped = false;
    this.pid = null;
    this.ready = false;
    this._readyWaiters = [];
  }

  _markReady(): void {
    this.ready = true;
    const waiters = this._readyWaiters.splice(0);
    for (const w of waiters) w.resolve();
  }

  /** 等待 worker 完成启动；超时则抛错（不静默返回空状态）。 */
  _whenReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._readyWaiters.indexOf(waiter);
        if (idx >= 0) this._readyWaiters.splice(idx, 1);
        reject(new Error(`worker for ${this.cell.path} was not ready within ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      };
      this._readyWaiters.push(waiter);
    });
  }

  /** worker 丢掉时唤醒所有等待者（避免永久挂起）。 */
  _rejectReadyWaiters(err: Error): void {
    const waiters = this._readyWaiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  async start({ snapshot }: { snapshot?: unknown } = {}): Promise<this> {
    const worker = new Worker(HOST_PATH, {});
    this.worker = worker;

    const failure = new Promise<WorkerReply>((resolve, reject) => {
      const onMessage = (msg: WorkerReply) => {
        if (msg && msg.kind === 'started') {
          this.pid = typeof msg.pid === 'number' ? msg.pid : null;
          worker.off('message', onMessage);
          resolve(msg);
        } else if (msg && msg.kind === 'start_failed') {
          worker.off('message', onMessage);
          reject(new Error(msg.error));
        }
      };
      worker.on('message', onMessage);
      worker.once('error', reject);
      worker.once('exit', (code: number) => reject(new Error(`actor worker exited with code ${code} before starting`)));
    });

    worker.on('message', (msg: WorkerReply) => this._onMessage(msg));
    worker.on('error', (err: Error) => this._onWorkerLost(err));
    worker.on('exit', (code: number) => this._onWorkerLost(new Error(`actor worker exited (code ${code})`)));

    worker.postMessage({
      kind: 'start',
      modulePath: this.modulePath,
      exportName: this.exportName,
      id: this.cell.id,
      path: this.cell.path,
      snapshot,
    });

    try {
      await failure;
      this._markReady();
    } catch (err) {
      // A failed start must not leak the thread: it would keep the process
      // alive forever and burn a slot per failed spawn.
      worker.__dead = true;
      this._onWorkerLost(err instanceof Error ? err : new Error(String(err)));
      await worker.terminate().catch(() => {});
      throw err;
    }
    return this;
  }

  _onMessage(msg: WorkerReply): void {
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'result') {
      const seq = msg.seq;
      if (seq === undefined) return;
      const entry = this.invokePending.get(seq);
      if (entry === undefined) return;
      this.invokePending.delete(seq);
      if (msg.ok === true) entry.resolve(msg.data);
      else entry.reject(new Error(msg.error ?? 'worker call failed'));
      return;
    }

    if (msg.kind === 'snapshot_data' || msg.kind === 'stopped' || msg.kind === 'ctx_result') {
      this._settleControl(msg);
      return;
    }

    if (msg.kind === 'log') {
      this.cell.system._log(msg.event ?? 'worker_log', msg.meta);
      return;
    }

    if (msg.kind === 'ctx_call') {
      this._handleCtxCall(msg);
    }
  }

  _settleControl(msg: WorkerReply): void {
    const key = msg.seq !== undefined ? `seq:${msg.seq}` : `ctx:${String(msg.callId)}`;
    const entry = this.controlPending.get(key);
    if (entry === undefined) return;
    this.controlPending.delete(key);
    clearTimeout(entry.timer);
    if (msg.error !== undefined) entry.reject(new Error(msg.error));
    else entry.resolve(msg);
  }

  /**
   * Run a `ctx.*` call that the worker cannot do itself (it lives on the main
   * thread: spawning children, reaching other actors, persisting).
   */
  async _handleCtxCall(msg: WorkerReply): Promise<void> {
    const callId = msg.callId;
    const op = msg.op;
    const args = (msg.args ?? {}) as CtxCallArgs;
    const reply = (ok: boolean, payload: Record<string, unknown>): void => {
      const worker = this.worker;
      if (worker !== null && (worker as { __dead?: boolean }).__dead !== true) {
        worker.postMessage({ kind: 'ctx_result', callId, ok, ...payload });
      }
    };

    try {
      switch (op) {
        case 'spawn': {
          const ref = await this.cell.spawnChild(args.definition, {
            ...(args.options ?? {}),
            isolation: 'worker',
          });
          return reply(true, { data: { id: ref.id, path: ref.path } });
        }
        case 'tell': {
          const target = this._resolve(args.target);
          return reply(true, { data: target.tell(args.msg, this.cell.ref, args.trace) });
        }
        case 'ask': {
          const target = this._resolve(args.target);
          const data = await target.ask(args.msg, args.timeoutMs, this.cell.ref, args.trace);
          return reply(true, { data });
        }
        case 'stop': {
          if (args.target === null) {
            setImmediate(() => this.cell.stop().catch(() => {}));
            return reply(true, { data: true });
          }
          return reply(true, { data: await this._resolve(args.target).stop() });
        }
        case 'saveSnapshot': {
          await this.cell.saveSnapshot();
          return reply(true, { data: true });
        }
        default:
          return reply(false, { error: `unsupported worker ctx operation: ${op}` });
      }
    } catch (err) {
      return reply(false, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  _resolve(target: unknown): { tell(msg: unknown, sender?: unknown, trace?: unknown): boolean; ask(msg: unknown, timeoutMs?: number, sender?: unknown, trace?: unknown): Promise<unknown>; stop(): Promise<void> } {
    if (!target) throw new ActorStoppedError('ctx: target actor is required');
    const ref = this.cell.system.resolve(String(target));
    if (ref === null) throw new ActorStoppedError(`no actor registered as "${String(target)}"`);
    return ref;
  }

  /** Everything that was in flight when the worker died. */
  _onWorkerLost(err: Error): void {
    if (this.worker) this.worker.__dead = true;
    this.ready = false;
    this._rejectReadyWaiters(err);
    for (const entry of this.invokePending.values()) entry.reject(err);
    this.invokePending.clear();
    for (const entry of this.controlPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.controlPending.clear();
  }

  /** Run one message inside the worker. */
  invoke(payload: unknown, senderPath: string | null, trace: unknown = null): Promise<unknown> {
    if (this.stopped || !this.worker || this.worker.__dead) {
      return Promise.reject(new ActorStoppedError(`worker for ${this.cell.path} is gone`));
    }
    const seq = (this.seq += 1);
    const send = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        this.invokePending.set(seq, { resolve, reject });
        const worker = this.worker;
        if (worker === null) {
          this.invokePending.delete(seq);
          reject(new ActorStoppedError(`worker for ${this.cell.path} is gone`));
          return;
        }
        try {
          worker.postMessage({ kind: 'invoke', seq, payload, senderPath: senderPath ?? null, trace });
        } catch (err) {
          this.invokePending.delete(seq);
          reject(new Error(`message cannot be cloned to the worker: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    // 就绪前投递会被 worker 忽略（它还没装好 instance），所以先等门闩。
    return this._whenReady(this.cell.system.shutdownTimeoutMs || 5000).then(send);
  }

  /** Ask the worker for its actor state (used by snapshots and introspection). */
  getState(timeoutMs = 5000): Promise<unknown> {
    if (!this.worker || this.worker.__dead) return Promise.resolve(undefined);
    // 就绪前不能问状态：worker 会回一个空状态，调用方以为"没有状态"。
    const seq = (this.seq += 1);
    return this._whenReady(timeoutMs)
      .then(() => this._control(`seq:${seq}`, { kind: 'snapshot', seq }, timeoutMs))
      .then((msg) => msg.state);
  }

  _control(key: string, message: Record<string, unknown>, timeoutMs: number): Promise<WorkerReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlPending.delete(key);
        reject(new Error(`worker control call "${message.kind}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.controlPending.set(key, { resolve, reject, timer });
      const worker = this.worker;
      if (worker === null) {
        this.controlPending.delete(key);
        clearTimeout(timer);
        reject(new ActorStoppedError(`worker for ${this.cell.path} is gone`));
        return;
      }
      try {
        worker.postMessage(message);
      } catch (err) {
        this.controlPending.delete(key);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Graceful stop: postStop runs inside the worker, then the thread exits. */
  async stop(timeoutMs = 5000): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    if (!worker) return;

    if (!worker.__dead) {
      const seq = (this.seq += 1);
      try {
        await this._control(`seq:${seq}`, { kind: 'stop', seq }, timeoutMs);
      } catch {
        /* the worker may already be gone; terminate below either way */
      }
    }
    this._onWorkerLost(new ActorStoppedError(`worker for ${this.cell.path} stopped`));
    worker.__dead = true;
    try {
      await worker.terminate();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { WorkerDelegate, defineWorkerActor, resolveActorModule, HOST_PATH };
