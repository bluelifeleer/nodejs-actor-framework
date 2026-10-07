/**
 * **日志与脱敏**：不发明新的日志框架 —— 全仓库的接缝是 `(event: string, meta?) => void`，
 * 这里只是给它加上"请求级子日志"与"**默认脱敏**"。
 *
 * 脱敏名单默认覆盖最常见的泄密面（authorization / cookie / set-cookie / password / token / secret…），
 * 并且是**按 key 名判定**（大小写不敏感、子串匹配），所以 `x-api-key`、`refresh_token`、`accessToken`
 * 都会被挡住。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSink = (event: string, meta?: Record<string, unknown>) => void;

export interface RequestLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** 加字段（例如 userId）后的子日志。 */
  child(fields: Record<string, unknown>): RequestLogger;
}

/** 默认脱敏的 key 关键词（子串匹配，大小写不敏感）。 */
export const REDACT_KEYWORDS: readonly string[] = [
  'authorization',
  'cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'api-key',
  'apikey',
  'private-key',
  'credential',
  'session',
];

export const REDACTED = '[redacted]';

export function shouldRedact(key: string, keywords: readonly string[] = REDACT_KEYWORDS): boolean {
  const lower = key.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

/** 递归脱敏（深度封顶，避免环形/超深对象把日志搞爆）。 */
export function redactValue(value: unknown, options: { keywords?: readonly string[]; depth?: number } = {}): unknown {
  const depth = options.depth ?? 0;
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, { ...options, depth: depth + 1 }));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = shouldRedact(key, options.keywords) ? REDACTED : redactValue(item, { ...options, depth: depth + 1 });
  }
  return out;
}

/** 脱敏一组请求头（只留安全的那些值）。 */
export function redactHeaders(headers: Record<string, unknown>, options: { keywords?: readonly string[] } = {}): Record<string, unknown> {
  return redactValue(headers, options) as Record<string, unknown>;
}

/**
 * 造一个请求级 logger：每条日志都带 `requestId`（业务日志与访问日志能对上），
 * 并且 **meta 默认脱敏**。
 */
export function createRequestLogger(base: LogSink | undefined, fields: Record<string, unknown> = {}): RequestLogger {
  const sink: LogSink = base ?? (() => undefined);
  const make = (bound: Record<string, unknown>): RequestLogger => {
    const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
      sink(message, redactValue({ level, ...bound, ...(meta ?? {}) }) as Record<string, unknown>);
    };
    return {
      debug: (message, meta) => emit('debug', message, meta),
      info: (message, meta) => emit('info', message, meta),
      warn: (message, meta) => emit('warn', message, meta),
      error: (message, meta) => emit('error', message, meta),
      child: (extra) => make({ ...bound, ...extra }),
    };
  };
  return make(fields);
}

/** 结构化的访问日志条目（`requestLogPlugin` 的输入）。 */
export interface StructuredRequestEntry {
  method: string;
  path: string;
  status: number;
  ms: number;
  requestId: string;
  bytesIn?: number;
  bytesOut?: number;
  userId?: string;
  /** 请求头（**已脱敏**；默认不收集）。 */
  headers?: Record<string, unknown>;
}

/** 把访问日志条目规范成结构化 JSON（`requestLogPlugin({ format: 'json' })` 用）。 */
export function toStructuredLog(entry: StructuredRequestEntry, options: { slowMs?: number } = {}): Record<string, unknown> {
  const slow = options.slowMs !== undefined && entry.ms >= options.slowMs;
  return redactValue({
    kind: 'http_request',
    method: entry.method,
    path: entry.path,
    status: entry.status,
    durationMs: entry.ms,
    requestId: entry.requestId,
    ...(entry.bytesIn === undefined ? {} : { bytesIn: entry.bytesIn }),
    ...(entry.bytesOut === undefined ? {} : { bytesOut: entry.bytesOut }),
    ...(entry.userId === undefined ? {} : { userId: entry.userId }),
    ...(slow ? { slow: true } : {}),
    ...(entry.headers === undefined ? {} : { headers: entry.headers }),
  }) as Record<string, unknown>;
}
