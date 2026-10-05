/**
 * 访问日志插件（真正的插件形态）：订阅应用层事件总线，而不是内置在 httpPlugin 里。
 *
 * 用事件总线而不是中间件：中间件看得到 ctx、看不到最终状态码（状态码在 dispatch 里才成型）；
 * 而"每次请求结束"的事件天然带全部字段。
 */

import type { Application, PluginSpec } from '@actor/app';

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  ms: number;
  requestId: string;
}

export interface RequestLogPluginOptions {
  /** 是否启用（默认 true，也可由 plugins.requestLog.enabled 配置/环境变量覆盖）。 */
  enabled?: boolean;
  /** 超过该耗时（毫秒）标记 SLOW（默认 500）。 */
  slowMs?: number;
  /** 自定义输出（默认打印一行）；测试里可用它收集条目。 */
  onRequest?: (entry: RequestLogEntry) => void;
}

export function requestLogPlugin(options: RequestLogPluginOptions = {}): PluginSpec {
  return {
    name: 'requestLog',
    config: {
      enabled: { type: 'boolean' as const, default: true },
      slowMs: { type: 'number' as const, default: 500, min: 0 },
    },
    onReady(app: Application) {
      const enabled = options.enabled ?? app.config.get<boolean>('plugins.requestLog.enabled');
      const slowMs = options.slowMs ?? app.config.get<number>('plugins.requestLog.slowMs');
      const sink =
        options.onRequest ??
        ((entry: RequestLogEntry) => {
          const slow = entry.ms >= slowMs ? ' SLOW' : '';
          console.log(
            `[http] ${entry.method} ${entry.path} ${String(entry.status)} ${String(entry.ms)}ms ` +
              `rid=${entry.requestId}${slow}`,
          );
        });
      app.on('http:request', (entry: never) => {
        if (enabled) sink(entry as unknown as RequestLogEntry);
      });
    },
  };
}
