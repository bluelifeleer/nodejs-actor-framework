/**
 * `@actor/mail`：邮件（消息模型 + MIME/.eml 渲染 + transport 契约 + 插件）。
 *
 * ```ts
 * import { mailPlugin } from '@actor/mail';
 * import { createApp } from '@actor/app';
 *
 * createApp(defineApp({ modules, plugins: [mailPlugin({ driver: 'file', dir: './data/mail' })] }));
 * // 控制器里： const mail = ctx.get('mail') as MailTransport; await mail.send({...});
 * ```
 *
 * 为什么不用内核承载：内核是**运行时原语**（CJS、零依赖、不含 I/O 语义），
 * 邮件是应用级 I/O 能力 —— 与数据库/Redis 同层，独立成包。
 */
export {
  assertSendable,
  parseMailHeaders,
  renderMail,
  type MailAddress,
  type MailAttachment,
  type MailMessage,
  type RenderedMail,
} from './message.ts';

export {
  createRenderer,
  escapeHtml,
  renderTemplate,
  type MailRenderer,
} from './render.ts';

export {
  defineMailTransport,
  defineMailTransport as mailTransport,
  fileTransport,
  runMailTransportContract,
  type MailSendResult,
  type MailTransport,
} from './transport.ts';

export { smtpTransport, type SmtpOptions } from './smtp.ts';

export { mailPlugin, type MailPluginOptions, type MailPluginSpec } from './plugin.ts';
