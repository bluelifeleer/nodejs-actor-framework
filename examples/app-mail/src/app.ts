import path from 'node:path';

import { defineApp, defineModule, metricsPlugin, type PluginSpec } from '@actor/app';
import { mailPlugin, type MailTransport } from '@actor/mail';
import { get, httpPlugin } from '@actor/web';

import config from '../config/default.ts';

export const http = httpPlugin({ port: 0, shutdownTimeoutMs: 5000 });

const mailDir = process.env.APP_MAIL_DIR ?? path.resolve(import.meta.dirname, '..', 'data', 'mail');

/**
 * 启动时发一封"欢迎信"：演示"邮件插件已经连上、能发信"。
 *
 * 顺序要注意：**模块 onStart 跑在插件 onReady 之前**，所以要发信得排到 mailPlugin 之后的插件里
 * （`requires: ['mail']` 让拓扑排序保证 mailPlugin 先就绪），而不是写在模块 onStart 里。
 */
const welcome: PluginSpec = {
  name: 'welcome',
  requires: ['mail'],
  async onReady(app) {
    const resource = app.get<{ acquire(): Promise<MailTransport> }>('mail');
    const transport = await resource.acquire();
    const result = await transport.send({
      from: { name: '示例应用', address: 'no-reply@example.com' },
      to: ['someone@example.com'],
      subject: '欢迎使用 @actor/mail 🙂',
      text: '这是一封由 fileTransport 写出来的邮件（不需要任何邮件服务）。',
      html: '<p>这是一封由 <code>fileTransport</code> 写出来的邮件。</p>',
      attachments: [{ filename: '示例.csv', content: 'a,b\r\n1,2\r\n', contentType: 'text/csv' }],
    });
    console.log(`[welcome] mail sent → ${result.id}`);
  },
};

export default defineApp({
  config,
  modules: [
    defineModule({
      name: 'health',
      routes: [
        // 路由要用 get/post/... 助手（产出的是路由元组；普通对象不是合法形状）
        get('/send', async () => ({
          ok: true,
          hint: '启动时的欢迎信在控制台与 data/mail 目录里',
        })),
      ],
    }),
  ],
  plugins: [
    // 邮件：写 .eml（零依赖）。换成 SMTP 只需要 driver: 'smtp' + url（并 npm i nodemailer）。
    mailPlugin({ driver: 'file', dir: mailDir }),
    welcome,
    http,
    metricsPlugin({ exporter: { enabled: false } }),
  ],
});
