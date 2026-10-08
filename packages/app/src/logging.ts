/**
 * **统一日志入口**（P2）。
 *
 * 现状（P2 之前）是**多个接缝各管一摊**：内核 `createSystem({ logger })`、HTTP 的访问日志
 * `requestLogPlugin`、请求级子日志 `ctx.log`、诊断路由 —— 每一项都要单独配，而且应用层
 * 没有任何一处能说清"这个应用的日志往哪走"。
 *
 * 这一层做的是**路由器**，不是新的日志框架：
 *   - 接缝仍然是 `(event, meta) => void`（零依赖、零约定）；
 *   - 把三类事件汇到一个出口：`app:*`（框架自己的启动/停止）、`kernel:*`（内核 40+ 事件）、
 *     `http:request` / `http:error`（Web 层）；
 *   - 提供**级别、事件过滤、脱敏关键词、上下文字段**四项统一策略；
 *   - 用户给 pino/winston 这类**对象日志器**也行（内部走内核的 `createLogAdapter`）。
 *
 * 纪律：**库代码不自己决定输出**（默认仍是 console 兜底，给 `logger` 才走你的出口）。
 */

import { createLogAdapter } from 'nodejs-actor-framework';

/** 事件族：`app`（框架装配/生命周期）/ `kernel`（内核）/ `http`（Web 层）/ `plugin`（插件）。 */
export type LogFamily = 'app' | 'kernel' | 'http' | 'plugin';

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

/** 对象日志器（pino / winston / console 都满足）。 */
export interface LogTargetLike {
  debug?: (line: string) => void;
  info?: (line: string) => void;
  warn?: (line: string) => void;
  error?: (line: string) => void;
}

/** 函数式出口（与内核 `logger` 同一形状）。 */
export type LogSinkFn = (event: string, meta?: Record<string, unknown>) => void;

export interface LoggingConfig {
  /**
   * 日志出口：**函数式**（`(event, meta) => void`）或**对象式**（pino/winston/console）。
   * 不给就走 console 兜底（与 P2 之前的行为一致）。
   */
  logger?: LogSinkFn | LogTargetLike;
  /** 最低级别（默认 `debug`：默认规则已经决定级别，这里只做二次过滤）。 */
  level?: LogLevelName;
  /** 只保留匹配的事件（支持 `*`，例如 `['kernel:*', 'http:*']`）；给了 `exclude` 仍生效。 */
  filter?: readonly string[];
  /** 排除匹配的事件（优先级高于 `filter`）。 */
  exclude?: readonly string[];
  /**
   * 覆盖默认级别判定（例如把某个噪声事件降成 debug）。
   * 返回 `undefined` 表示"这一条用默认规则"。
   */
  levelOf?: (info: { family: LogFamily; event: string; meta?: Record<string, unknown> }) => LogLevelName | undefined;
  /** 追加/覆盖**脱敏关键词**（按 key 子串匹配，大小写不敏感）。 */
  redactKeywords?: readonly string[];
  /**
   * 给每条日志补上下文字段（例如统一带 `service` / `env` / `version`）。
   * 返回值会与事件 meta 合并（事件 meta 优先）。
   */
  context?: (info: { family: LogFamily; event: string }) => Record<string, unknown> | undefined;
  /** 框架自己的启动/监听日志（`app:*` / `plugin:*`）是否也走 logger；默认 `true`。 */
  framework?: boolean;
}

/** 规范化后的事件（交给 logger 之前）。 */
export interface RoutedLogEvent {
  family: LogFamily;
  /** 事件名（`app:listening` / `kernel:actor_crash` / `http:request`）。 */
  event: string;
  level: LogLevelName;
  meta: Record<string, unknown> | undefined;
}

/** 默认级别规则（可被 `logging.levelOf` 覆盖）。 */
export function defaultLevelOf(event: string): LogLevelName {
  if (/(^|[_:-])(debug)($|[_:-])/i.test(event)) return 'debug';
  return /(^|[_:-])(error|failed|failure|conflict|rejected|refused|unsupported|timeout|crash|escalat)($|[_:-])/i.test(event)
    ? 'warn'
    : 'info';
}

const LEVEL_RANK: Record<LogLevelName, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 把 `*` 通配符编译成"整串匹配"的正则（`kernel:*` 匹配 `kernel:` 开头的任意后缀）。 */
export function matchesPattern(pattern: string, event: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(event);
}

function isSinkFn(value: unknown): value is LogSinkFn {
  return typeof value === 'function';
}

function isTarget(value: unknown): value is LogTargetLike {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as LogTargetLike;
  return typeof record.info === 'function' || typeof record.debug === 'function' || typeof record.warn === 'function' || typeof record.error === 'function';
}

/** 应用的日志路由器（`Application` 内部持有；插件通过 `app.logSink` 取用）。 */
export interface AppLogger {
  /** 发布一条事件（family + event 由调用方给）。 */
  publish(family: LogFamily, event: string, meta?: Record<string, unknown>): void;
  /** 内核事件是否要交给 `createSystem({ logger })`（给了 logger 就交给内核，避免重复转发）。 */
  readonly handlesKernel: boolean;
  /** 脱敏关键词（`ctx.log` / 访问日志用；没覆盖就是 undefined = 用默认名单）。 */
  readonly redactKeywords: readonly string[] | undefined;
  /** 级别判定（给 `ctx.log` 用；与统一策略一致）。 */
  levelFor(family: LogFamily, event: string): LogLevelName;
}

/**
 * 建一个日志路由器。
 *
 * 为什么 `handlesKernel` 是个开关：内核自己有 `logger` 接缝，若我们既把 sink 交给内核、
 * 又在事件桥上再转发一次，每条内核日志会出现两次。所以**二选一**：
 * 给了 logger → 交给内核（内核的 `_log` 已经覆盖全部事件）；没给 → 走事件桥 + console 兜底。
 */
export function createAppLogger(config: LoggingConfig = {}): AppLogger {
  const minRank = LEVEL_RANK[config.level ?? 'debug'];
  const filter = config.filter;
  const exclude = config.exclude ?? [];
  const context = config.context;
  const levelOf = config.levelOf;

  const target: LogSinkFn | null = isSinkFn(config.logger)
    ? config.logger
    : isTarget(config.logger)
      ? createLogAdapter(config.logger, { level: (event) => defaultLevelOf(event) })
      : null;

  const levelFor = (family: LogFamily, event: string): LogLevelName => {
    const full = event.includes(':') ? event : `${family}:${event}`;
    if (levelOf !== undefined) return levelOf({ family, event: full }) ?? defaultLevelOf(full);
    return defaultLevelOf(full);
  };

  const wanted = (full: string): boolean => {
    if (exclude.some((pattern) => matchesPattern(pattern, full))) return false;
    if (filter === undefined || filter.length === 0) return true;
    return filter.some((pattern) => matchesPattern(pattern, full));
  };

  const write = (level: LogLevelName, full: string, meta: Record<string, unknown> | undefined): void => {
    const extra = context?.({ family: full.split(':', 1)[0] as LogFamily, event: full });
    const merged = extra === undefined ? meta : { ...extra, ...(meta ?? {}) };
    if (target !== null) target(full, merged);
    else fallbackWrite(level, full, merged);
  };

  return {
    publish(family, event, meta) {
      const full = event.includes(':') ? event : `${family}:${event}`;
      if (!wanted(full)) return;
      if ((family === 'app' || family === 'plugin') && config.framework === false) return;
      // 级别只算一次（`levelOf` 可能是任意函数，不该每条事件调两遍），并如实带进 meta
      const level = levelFor(family, full);
      if (LEVEL_RANK[level] < minRank) return;
      write(level, full, { ...(meta ?? {}), level });
    },
    handlesKernel: target !== null,
    redactKeywords: config.redactKeywords,
    levelFor,
  };
}

/** 没给 logger 时的兜底：一行结构化文本到 stderr/stdout（与 P2 之前的行为接近）。 */
function fallbackWrite(level: LogLevelName, event: string, meta: Record<string, unknown> | undefined): void {
  const line = meta === undefined || Object.keys(meta).length === 0 ? event : `${event} ${safeJson(meta)}`;
  // console-ok: 这就是 console 兜底本身（应用没配 logger 时的默认出口）
  if (level === 'error' || level === 'warn') console.error(line);
  // console-ok: 同上
  else console.log(line);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 把级别映射到 **log-adapter 的级别名**（对象日志器只认这四种）。 */
export function levelToAdapter(level: LogLevelName): LogLevelName {
  return level;
}
