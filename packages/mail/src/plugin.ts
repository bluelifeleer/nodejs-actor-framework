import { createAppRequire, ResourceConfigError, supervise, type DriverResolver, type ManagedResource, type SupervisionEvent } from '@actor/resource';

import { fileTransport, type MailTransport } from './transport.ts';
import { smtpTransport } from './smtp.ts';

/**
 * **邮件插件**：把 `MailTransport` 接进应用（生命周期交给 `supervise()`，与数据库/Redis 同一套）。
 *
 * 配置节 `plugins.mail.*`：`url`（SMTP DSN）、`driver`（`file` | `smtp`）、`dir`（fileTransport 落盘目录）。
 * 客户端注册成 `mail` 服务 → 控制器里 `ctx.get('mail')`。
 */
export interface MailPluginOptions {
  /** 直接用现成的 transport（优先级最高，测试/自装都用它）。 */
  transport?: MailTransport;
  /** 驱动名：`file`（写 .eml，零依赖）/ `smtp`（懒加载 nodemailer）。 */
  driver?: 'file' | 'smtp';
  /** fileTransport 的落盘目录（默认 `./data/mail`）。 */
  dir?: string;
  /** SMTP DSN（也可由 `plugins.mail.url` 配置给）。 */
  url?: string;
  resolve?: DriverResolver;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
  onEvent?: (event: SupervisionEvent) => void;
}

export interface MailPluginApp {
  config: { get<T>(key: string): T };
  provide?(name: string, value: unknown): void;
  get?<T>(name: string): T;
}

export interface MailPluginSpec {
  name: string;
  config: Record<string, unknown>;
  setup?(app: MailPluginApp): void | Promise<void>;
  onReady(app: MailPluginApp): Promise<void>;
  onStopping(): Promise<void>;
}

/** 组装出一个受管资源（`supervise` 提供状态机/事件/drain/幂等关闭）。 */
function buildTransport(options: MailPluginOptions, url: string): MailTransport {
  if (options.transport !== undefined) return options.transport;
  const driver = options.driver ?? (url === '' ? 'file' : 'smtp');
  if (driver === 'file') return fileTransport({ dir: options.dir ?? './data/mail' });
  return smtpTransport({
    ...(url === '' ? {} : { url }),
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

export function mailPlugin(options: MailPluginOptions = {}): MailPluginSpec {
  let resource: ManagedResource<MailTransport> | null = null;

  return {
    name: 'mail',
    config: {
      driver: { type: 'string' as const, default: options.driver ?? 'file' },
      url: { type: 'string' as const, default: options.url ?? '' },
      dir: { type: 'string' as const, default: options.dir ?? './data/mail' },
    },
    async onReady(app) {
      const url = app.config.get<string>('plugins.mail.url');
      const resolvedOptions: MailPluginOptions = { ...options, dir: app.config.get<string>('plugins.mail.dir') };
      const resolve = options.resolve ?? createAppRequire();
      const transport = buildTransport({ ...resolvedOptions, resolve }, url);
      const adapter = {
        kind: transport.kind,
        driverPackage: transport.driverPackage ?? '(内置)',
        connectionKind: 'url' as const,
        async connect() {
          return {
            client: transport,
            healthCheck: async () => {
              await transport.verify?.();
            },
            close: async () => {
              await transport.close?.();
            },
            stats: () => ({ kind: transport.kind, driverPackage: transport.driverPackage ?? '(内置)' }),
          };
        },
      };
      resource = supervise(adapter, {
        connection: { kind: transport.kind, url },
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
      await resource.connect();
      // 启动期探活：配错 SMTP/驱动缺失必须现在失败，而不是等到第一封邮件或停机
      await resource.checkHealth().catch((err: unknown) => {
        throw new ResourceConfigError(
          `mail("${transport.kind}"): transport is not healthy: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      app.provide?.('mail', resource);
      app.provide?.('mail:resource', resource);
      let registry: Array<{ name: string; resource: unknown }> = [];
      try {
        registry = app.get?.<Array<{ name: string; resource: unknown }>>('@actor/resource:registry') ?? [];
      } catch {
        registry = [];
      }
      app.provide?.('@actor/resource:registry', [...registry, { name: 'mail', resource }]);
    },
    async onStopping() {
      await resource?.close();
    },
  };
}
