/**
 * 访问日志插件（真正的插件形态）：订阅应用层事件总线，而不是内置在 httpPlugin 里。
 *
 * 用事件总线而不是中间件：中间件看得到 ctx、看不到最终状态码（状态码在 dispatch 里才成型）；
 * 而"每次请求结束"的事件天然带全部字段。
 */

import type { Application, PluginSpec } from '@actor/app';

import { redactValue, shouldRedact, toStructuredLog, type StructuredRequestEntry } from './logging.ts';

/** 访问日志条目（与 http 层事件同形；`bytesIn/bytesOut/userId` 有就给）。 */
export interface RequestLogEntry extends StructuredRequestEntry {}

export interface RequestLogPluginOptions {
  /** 是否启用（默认 true，也可由 plugins.requestLog.enabled 配置/环境变量覆盖）。 */
  enabled?: boolean;
  /** 超过该耗时（毫秒）标记 SLOW（默认 500）。 */
  slowMs?: number;
  /** 自定义输出（默认打印一行）；测试里可用它收集条目。 */
  onRequest?: (entry: RequestLogEntry) => void;
  /** 采样率 0..1（默认 1 = 全记）；慢请求**不受采样影响**（永远记）。 */
  sampleRate?: number;
  /** 输出形态：`line`（默认，一行文本）或 `json`（结构化，字段全 + 已脱敏）。 */
  format?: 'line' | 'json';
  /** 收集请求头（**默认关**；开了也会自动脱敏）。 */
  includeHeaders?: boolean;
}

export function requestLogPlugin(options: RequestLogPluginOptions = {}): PluginSpec {
  /** 审计 F14：http:request 的退订句柄（原来订阅函数的返回值被直接丢弃）。 */
  let detach: () => void = () => {};
  return {
    name: 'requestLog',
    config: {
      enabled: { type: 'boolean' as const, default: true },
      slowMs: { type: 'number' as const, default: 500, min: 0 },
      sampleRate: { type: 'number' as const, default: 1, min: 0 },
    },
    onReady(app: Application) {
      const enabled = options.enabled ?? app.config.get<boolean>('plugins.requestLog.enabled');
      const slowMs = options.slowMs ?? app.config.get<number>('plugins.requestLog.slowMs');
      const sampleRate = options.sampleRate ?? app.config.get<number>('plugins.requestLog.sampleRate');
      const format = options.format ?? 'line';
      const sink =
        options.onRequest ??
        ((entry: RequestLogEntry) => {
          const slow = entry.ms >= slowMs ? ' SLOW' : '';
          if (format === 'json') {
            // 结构化：字段齐全（bytesIn/bytesOut/userId），并且**过一遍脱敏**
            console.log(JSON.stringify(toStructuredLog(entry, { slowMs })));
            return;
          }
          console.log(
            `[http] ${entry.method} ${entry.path} ${String(entry.status)} ${String(entry.ms)}ms ` +
              `rid=${entry.requestId}${slow}` +
              (entry.userId === undefined ? '' : ` user=${entry.userId}`),
          );
        });
      const onRequest = (entry: never): void => {
        if (!enabled) return;
        const record = entry as unknown as RequestLogEntry;
        const slow = record.ms >= slowMs;
        // 采样：慢请求永远记（排障时最需要的恰恰是它）
        if (!slow && sampleRate < 1 && Math.random() >= sampleRate) return;
        const sanitized: RequestLogEntry = {
          ...record,
          ...(options.includeHeaders === true && (record as { headers?: Record<string, unknown> }).headers !== undefined
            ? { headers: redactValue((record as { headers?: Record<string, unknown> }).headers) as Record<string, unknown> }
            : {}),
        };
        delete (sanitized as { headers?: unknown }).headers;
        if (options.includeHeaders === true) {
          const raw = (record as { headers?: Record<string, unknown> }).headers ?? {};
          const safe: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(raw)) safe[key] = shouldRedact(key) ? '[redacted]' : value;
          (sanitized as { headers?: Record<string, unknown> }).headers = safe;
        }
        sink(sanitized);
      };
      app.on('http:request', onRequest);
      // 审计 F14：把退订句柄存下来，teardown 时摘掉（原来直接丢弃）
      detach = () => {
        (app as { off?: (event: string, fn: (entry: never) => void) => void }).off?.('http:request', onRequest);
      };
    },

    teardown() {
      detach();
      detach = () => {};
    },
  };
}
