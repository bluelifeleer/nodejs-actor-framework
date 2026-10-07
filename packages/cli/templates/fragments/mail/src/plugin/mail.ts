import { mailPlugin } from '@actor/mail';

/**
 * 邮件能力（`--with mail`）：本地用 **fileTransport** 写 `.eml`（零依赖、离线可跑）。
 *
 * 换成真 SMTP 只要改成 `mailPlugin({ driver: 'smtp', url: process.env.SMTP_URL })` 并 `npm i nodemailer`；
 * 控制器里用 `ctx.get('mail')` 拿到 transport 发信。
 */
export default mailPlugin({ driver: 'file', dir: process.env['APP_MAIL_DIR'] ?? './data/mail' });
