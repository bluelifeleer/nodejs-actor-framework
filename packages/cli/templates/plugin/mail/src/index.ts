import { assertSendable, defineMailTransport, type MailMessage, type MailSendResult } from '@actor/mail';

/**
 * __PLUGIN_NAME__：一个**邮件传输**实现（把信发给你的服务：Resend / SES / Mailgun / 自建 HTTP 网关…）。
 *
 * 契约只有一条：**能发就行**。`send` 里**不要**做重试与队列（那是投递语义层的事，
 * 框架不在这里假装有保证）。`test/contract.test.ts` 用的是 `@actor/mail` **已发布**的契约套件。
 */
export interface __PLUGIN_CAMEL__Options {
  /** API 端点（换成你的服务）。 */
  endpoint: string;
  /** 凭据（从配置/环境变量读，不要硬编码）。 */
  apiKey?: string;
  /** 请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 观测钩子（默认不写 stdout）。 */
  logger?: (event: string, meta?: Record<string, unknown>) => void;
}

export function __PLUGIN_CAMEL__Transport(options: __PLUGIN_CAMEL__Options) {
  return defineMailTransport({
    kind: '__PLUGIN_NAME__',
    driverPackage: '(内置)',

    async send(message: MailMessage): Promise<MailSendResult> {
      // **发送前先校验**：HTTP API 不渲染邮件，所以"没有收件人"与"主题里藏 CRLF（头部注入）"
      // 这两个洞要自己堵 —— 用框架导出的 assertSendable（规则单一来源，别自己抄）
      assertSendable(message);

      const body = JSON.stringify({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        body,
        ...(options.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
      });
      if (!response.ok) {
        // 失败要**响亮**：把状态码与响应片段带出去（框架不猜、不重试）
        const detail = await response.text().catch(() => '');
        throw new Error(`__PLUGIN_NAME__: send failed (${String(response.status)}) ${detail.slice(0, 200)}`);
      }
      const payload = (await response.json().catch(() => ({}))) as { id?: string };
      const accepted = message.to.map((address) => address.address);
      options.logger?.('__PLUGIN_CAMEL___sent', { id: payload.id ?? null, recipients: accepted.length });
      return {
        id: payload.id ?? `__PLUGIN_CAMEL__-${String(Date.now())}`,
        accepted,
        rejected: [],
        detail: { endpoint: options.endpoint },
      };
    },

    /** 探活：能连上就算可用（实现可以换成你的 /health 端点）。 */
    async verify(): Promise<void> {
      const response = await fetch(options.endpoint, { method: 'HEAD' });
      if (!response.ok && response.status !== 405) {
        throw new Error(`__PLUGIN_NAME__: endpoint not reachable (${String(response.status)})`);
      }
    },
  });
}

export default __PLUGIN_CAMEL__Transport;
