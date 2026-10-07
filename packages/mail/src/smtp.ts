import { DbConfigError, DbConnectionError, type DriverResolver } from '@actor/resource';

import { renderMail, type MailMessage } from './message.ts';
import { defineMailTransport, type MailTransport } from './transport.ts';

/**
 * **SMTP 传输**：懒加载 `nodemailer`（从**应用根**解析）+ 缺失时给安装提示。
 *
 * 为什么用 nodemailer 而不是自己写 SMTP：SMTP 的 AUTH/STARTTLS/编码/重试细节坑太多，
 * 自己写只会做出一个"看起来能用"的实现 —— 那是灾难。驱动缺失时**大声失败**，不静默降级。
 */
export interface SmtpOptions {
  /** `smtp://user:pass@host:587` 形式；给了它就不用下面那些零散字段。 */
  url?: string;
  host?: string;
  port?: number;
  /** true = 直接 TLS（465）；false = 明文或 STARTTLS。 */
  secure?: boolean;
  auth?: { user: string; pass: string };
  /** 由插件注入（从应用根解析驱动）。 */
  resolve?: DriverResolver;
  /** 连接超时（默认 10s）。 */
  connectionTimeoutMs?: number;
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

interface NodemailerTransport {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>;
  verify?(): Promise<unknown>;
  close?(): void;
}
interface NodemailerModule {
  createTransport(options: Record<string, unknown>): NodemailerTransport;
}

function optionsFrom(input: SmtpOptions): Record<string, unknown> {
  if (input.url !== undefined) {
    const parsed = new URL(input.url);
    return {
      host: parsed.hostname,
      port: parsed.port === '' ? 587 : Number(parsed.port),
      secure: parsed.protocol === 'smtps:' || parsed.port === '465',
      ...(parsed.username === '' ? {} : { auth: { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } }),
    };
  }
  if (input.host === undefined) throw new DbConfigError('smtpTransport: 需要 url 或 host');
  return {
    host: input.host,
    port: input.port ?? 587,
    secure: input.secure === true,
    ...(input.auth === undefined ? {} : { auth: input.auth }),
    connectionTimeout: input.connectionTimeoutMs ?? 10_000,
  };
}

export function smtpTransport(input: SmtpOptions): MailTransport {
  let transport: NodemailerTransport | null = null;
  const get = (): NodemailerTransport => {
    if (transport !== null) return transport;
    const resolve = input.resolve;
    if (resolve === undefined) {
      throw new DbConfigError('smtpTransport: 需要 resolve（由 mailPlugin 注入；独立使用时请传 createAppRequire() 的结果）');
    }
    const module = resolve('nodemailer') as NodemailerModule;
    transport = module.createTransport(optionsFrom(input));
    return transport;
  };

  return defineMailTransport({
    kind: 'smtp',
    driverPackage: 'nodemailer',
    async send(message: MailMessage) {
      const rendered = renderMail(message);
      try {
        const result = await get().sendMail({
          from: rendered.envelope.from,
          to: rendered.envelope.to,
          raw: rendered.raw,
        });
        return {
          id: result.messageId ?? rendered.messageId,
          accepted: (result.accepted ?? rendered.envelope.to).map(String),
          rejected: (result.rejected ?? []).map(String),
          detail: { messageId: rendered.messageId, subject: rendered.subject },
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error instanceof DbConfigError) throw error;
        input.logger?.('smtp_send_failed', { subject: rendered.subject, error: error.message });
        throw new DbConnectionError(`smtp 发送失败：${error.message}`, error);
      }
    },
    async verify() {
      await get().verify?.();
    },
    async close() {
      get().close?.();
    },
  });
}
