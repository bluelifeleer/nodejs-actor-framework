/**
 * **错误出口**（P1）：把"框架/内核里发生的事"显式送到应用层。
 *
 * 为什么需要它：内核自己有一整套后台日志事件（`actor_crash`、`actor_restart`、`actor_stop_timeout`、
 * `dead_letter`、`dead_letter_persist_failed`、`system_failure`、`scheduler_error`、`snapshot_auto_failed`、
 * `cluster_*` …，40+ 个），但**应用层默认什么都不转发** ——
 * 于是"Actor 崩了 / 消息进了死信 / 快照写失败"对只写 `@actor/app` 的用户等于不存在
 * （要么懂内核细节去 `createApp(..., { kernel: { logger } })`，要么走 `app.kernel` 逃生通道）。
 *
 * 这一层的纪律（与"库代码不自己写 stdout"一致）：
 *   - **不注册钩子 = 不转发**（默认静默，行为与从前一致）；
 *   - 钩子抛错**绝不能影响内核**（内核的 `emit` 有兜底，这里再兜一层）；
 *   - 只做"转发 + 强类型视图"，**不干预监督**（重启策略仍归内核，见 `onCrash` 的注释）。
 */

/**
 * 死信条目（**统一后的形状**）。
 *
 * 为什么需要"统一"：内核有**两套**死信形状 ——
 *   - 内存环（`system.deadLetters`）：`{ ts, path, payload, retryCount, error }`；
 *   - 落盘队列（`deadLetters` 插件，`store/dead-letter-queue`）：`{ ts, actorId, msg, retryCount, reason }`。
 * `app.deadLetters()` 装了插件就读后者。早先直接把两套透出去，于是**同一个 API 会给你两种形状**
 * （`entry.path` 有时是 undefined）—— 实测踩到。这里统一成内存环那套（字段名与内核文档一致）。
 */
export interface DeadLetterLike {
  ts: number;
  /** Actor 路径（落盘那份叫 `actorId`）。 */
  path: string;
  /** 原始消息（落盘那份叫 `msg`）。 */
  payload: unknown;
  retryCount: number;
  /** 失败原因（落盘那份叫 `reason`）。 */
  error?: string;
}

/** 把内核两种死信形状统一成 {@link DeadLetterLike}（字段缺失就用另一套的名字补）。 */
export function normalizeDeadLetter(entry: unknown): DeadLetterLike {
  const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
  const error = record['error'] ?? record['reason'];
  return {
    ts: typeof record['ts'] === 'number' ? record['ts'] : 0,
    path: String(record['path'] ?? record['actorId'] ?? ''),
    payload: record['payload'] ?? record['msg'],
    retryCount: typeof record['retryCount'] === 'number' ? record['retryCount'] : 0,
    ...(error === undefined ? {} : { error: typeof error === 'string' ? error : String(error) }),
  };
}

/** 内核后台事件（`system.on('log')` 的那一类）的转发载荷。 */
export interface KernelLogInfo {
  /** 内核事件名，例如 `actor_crash` / `snapshot_auto_failed` / `cluster_tell_failed`。 */
  event: string;
  /** 事件附带的诊断信息（原样透传）。 */
  meta: Record<string, unknown> | undefined;
}

/** 一次 Actor 崩溃的强类型视图（由 `actor_crash` 事件推导）。 */
export interface ActorCrashInfo {
  /** Actor 路径（`ctx.actor(...)` 用的名字）。 */
  path: string;
  /** 该路径对应的声明名（`actors: { Counter: … }` 里的 `Counter`）；推不出来就是路径本身。 */
  name: string;
  /** 崩溃原因（内核只给字符串，原样透传）。 */
  error: string;
  /** 原始 meta（要看 `err`/`restarts` 之类的额外字段就用它）。 */
  meta: Record<string, unknown> | undefined;
}

/** Actor 级崩溃回执（`actors: { X: { onCrash } }`）。 */
export type ActorCrashHook = (info: ActorCrashInfo) => void;

/** 应用层的错误/日志出口。全部可选；都不给就是"保持默认静默"。 */
export interface ErrorHooks {
  /**
   * 内核日志事件（40+ 个，原样透传）。
   *
   * 想按类别过滤就在这一层做（事件名有前缀：`actor_*` / `cluster_*` / `remote_*` /
   * `persistence_*` / `snapshot_*` / `plugin_*` / `scheduler_*`）。
   */
  onKernelLog?: (info: KernelLogInfo) => void;
  /** Actor 崩溃（`actor_crash`）的强类型视图；比 onKernelLog 窄、好接。 */
  onActorCrash?: ActorCrashHook;
  /** 消息进了死信（内核内存环 + 可选落盘）。 */
  onDeadLetter?: (entry: DeadLetterLike) => void;
  /** 顶层 Actor（或其子树）耗尽重启强度：内核正在停下来并如实上报。 */
  onSystemFailure?: (info: { error: unknown; path?: string }) => void;
  /** Web 层的 5xx（与 `app.on('http:error')` 是同一份数据，收进同一个出口好接线）。 */
  onHttpError?: (info: {
    requestId: string;
    status: number;
    path: string | null;
    method: string | null;
    error: unknown;
  }) => void;
}

/** 内核"事件订阅"的最小形状（避免把内核类型漏进应用层）。 */
interface KernelEmitter {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
  readDeadLetters?(): Promise<unknown[]>;
  clearDeadLetters?(): Promise<number>;
}

const KERNEL_EVENTS = ['log', 'dead_letter', 'system_failure'] as const;

/** 把任意抛错都吞掉并留一句 console（**不能因为"报错的钩子"把应用搞崩**）。 */
function safe(what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    // 这里刻意用 console：它发生在"用户的错误钩子自己坏了"的路径上，
    // 调用用户自己的 logger 可能正是抛错源（递归风险），而静默会让问题消失。
    // console-ok: 用户的错误钩子自己坏了，这条必须留痕；走用户 logger 有递归风险
    console.error(`[errors] ${what} 钩子抛错（已忽略，不影响应用）：`, error);
  }
}

/**
 * 把内核事件桥接到应用层的钩子集合。
 *
 * 返回一个 `dispose()`：停机时摘掉监听（内核的 `off` 存在才摘；不存在就靠"实例一起销毁"）。
 */
export function bridgeKernelEvents(
  system: KernelEmitter,
  hooks: ErrorHooks,
  lookup: { nameOf(path: string): string | undefined; onCrash(path: string): ActorCrashHook | undefined },
  options: {
    /**
     * 是否把内核日志也交给 `hooks.onKernelLog`。
     *
     * 给了 `logging.logger` 时**必须传 false**：那种情况下日志已经通过
     * `createSystem({ logger })` 直达用户出口，这里再转发一次会让每条内核日志出现两次。
     */
    includeKernelLog?: boolean;
  } = {},
): () => void {
  const includeKernelLog = options.includeKernelLog ?? true;
  const disposers: Array<() => void> = [];

  const subscribe = (event: string, listener: (...args: never[]) => void): void => {
    try {
      system.on(event, listener);
    } catch {
      return; // 事件名不被支持就当没注册（不因为"上游版本不同"把启动搞崩）
    }
    if (typeof system.off === 'function') disposers.push(() => system.off?.(event, listener));
  };

  if ((includeKernelLog && hooks.onKernelLog !== undefined) || hooks.onActorCrash !== undefined) {
    const onLog = ((event: string, meta?: Record<string, unknown>) => {
      if (includeKernelLog && hooks.onKernelLog !== undefined) {
        safe('onKernelLog', () => hooks.onKernelLog?.({ event: String(event), meta }));
      }
      if (String(event) !== 'actor_crash') return;
      const path = typeof meta?.['path'] === 'string' ? meta['path'] : '';
      if (path === '') return;
      const info: ActorCrashInfo = {
        path,
        name: lookup.nameOf(path) ?? path,
        error: typeof meta?.['err'] === 'string' ? meta['err'] : 'unknown',
        meta,
      };
      if (hooks.onActorCrash !== undefined) safe('onActorCrash', () => hooks.onActorCrash?.(info));
      const perActor = lookup.onCrash(path);
      if (perActor !== undefined) safe(`onCrash(${path})`, () => perActor(info));
    }) as (...args: never[]) => void;
    subscribe('log', onLog);
  }

  if (hooks.onDeadLetter !== undefined) {
    const onDeadLetter = ((entry: DeadLetterLike) => {
      safe('onDeadLetter', () => hooks.onDeadLetter?.(entry));
    }) as (...args: never[]) => void;
    subscribe('dead_letter', onDeadLetter);
  }

  if (hooks.onSystemFailure !== undefined) {
    const onSystemFailure = ((error: unknown, ref?: { path?: string }) => {
      safe('onSystemFailure', () =>
        hooks.onSystemFailure?.({ error, ...(typeof ref?.path === 'string' ? { path: ref.path } : {}) }),
      );
    }) as (...args: never[]) => void;
    subscribe('system_failure', onSystemFailure);
  }

  void KERNEL_EVENTS;
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 摘不掉也不影响停机 */
      }
    }
  };
}
