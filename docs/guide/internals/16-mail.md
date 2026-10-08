# 邮件（@actor/mail）

`@actor/mail` 是独立包（**不进内核**）：内核是运行时原语（CJS、零依赖、不含 I/O 语义），
邮件是应用级 I/O 能力 —— 与数据库/Redis 同层。三件事：**消息 + MIME 渲染**、**transport 契约**、**应用插件**。

```bash
npm i nodemailer      # 只有用 SMTP 才需要；fileTransport 零依赖
```

## 装进应用

```ts
import { mailPlugin } from '@actor/mail';

export default defineApp({
  modules: [myModule],
  plugins: [
    // 开发/测试：写 .eml 文件（离线可真验）
    mailPlugin({ driver: 'file', dir: './data/mail' }),
    // 生产：SMTP（配置节 plugins.mail.url，或这里直接给 url）
    // mailPlugin({ driver: 'smtp', url: process.env.SMTP_URL! }),
  ],
});
```

控制器里 `ctx.get('mail')` 拿到 `MailTransport`：

```ts
const mail = ctx.get('mail') as MailTransport;
await mail.send({
  from: { name: '系统通知', address: 'no-reply@example.com' },
  to: [user.email],
  subject: '你的订单已发货',
  text: '纯文本正文',
  html: '<p>HTML 正文</p>',
  attachments: [{ filename: '报表.csv', content: csv, contentType: 'text/csv' }],
});
```

生命周期（连接/探活/事件/drain/幂等关闭）由 `@actor/resource` 的 `supervise()` 提供，
并且会进**受管资源注册表** → `GET /__debug/health` 自动包含邮件。

## MIME 渲染（离线可真验）

```js verify
import { renderMail, parseMailHeaders, fileTransport } from '@actor/mail';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rendered = renderMail({
  from: { name: '发件人', address: 'from@example.com' },
  to: ['to@example.com'],
  subject: '中文主题 🙂',
  text: '纯文本',
  html: '<p>HTML</p>',
  attachments: [{ filename: '报表.csv', content: 'a,b\r\n1,2\r\n', contentType: 'text/csv' }],
});

const headers = parseMailHeaders(rendered.raw);
console.log('Subject →', headers.subject);
if (!/^=\?UTF-8\?B\?/.test(headers.subject)) throw new Error('非 ASCII 主题必须走 RFC 2047 encoded-word');
if (!rendered.raw.includes('multipart/mixed')) throw new Error('有附件时外层必须是 multipart/mixed');
if (!rendered.raw.includes('multipart/alternative')) throw new Error('同时有 text 和 html 时要有 alternative');

// 头部注入防御：能塞 Bcc 的写法必须被拒
try {
  renderMail({ from: 'f@example.com', to: ['t@example.com'], subject: 'x\r\nBcc: evil@example.com', text: 'x' });
  throw new Error('头部注入竟然通过了');
} catch (err) {
  console.log('注入被拒 →', err.message.slice(0, 40));
}

// fileTransport：写出标准 .eml（不需要任何服务）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-guide-'));
const result = await fileTransport({ dir }).send({ from: 'f@example.com', to: ['t@example.com'], subject: '你好', text: '内容' });
console.log('写出 →', path.basename(result.id), '| accepted =', result.accepted.join(','));
if (!fs.existsSync(result.id)) throw new Error('应当写出 .eml 文件');
fs.rmSync(dir, { recursive: true, force: true });
```

## 模板：默认转义

```js verify
import { renderTemplate, createRenderer } from '@actor/mail';

const html = renderTemplate('<p>你好 {{name}}</p>', { name: '<script>alert(1)</script>' });
console.log(html);
if (html.includes('<script>')) throw new Error('HTML 必须默认转义（否则就是 XSS 直通车）');

// 缺键保留原文（一眼看出漏配），嵌套取值也支持
console.log(renderTemplate('{{user.name}} / {{missing}}', { user: { name: '张三' } }));

// 想用真模板引擎？注入自己的 renderer（框架不内建、也不假装内建）
const renderer = createRenderer();
console.log(renderer('{{a}}', { a: 1 }));
```

## 换成别的服务（Resend/SES/Mailgun…）

```ts
import { defineMailTransport } from '@actor/mail';

const resend = defineMailTransport({
  kind: 'resend',
  driverPackage: 'resend',
  async send(message) {
    const rendered = renderMail(message);       // 复用框架的 MIME 渲染
    const res = await fetch('https://api.resend.com/emails', { /* ... */ });
    return { id: res.id, accepted: rendered.envelope.to, rejected: [] };
  },
});

mailPlugin({ transport: resend });
```

自装传输先跑契约套件自证合规：`runMailTransportContract({ name: 'resend', make: () => resend })`。

## 真服务验证（可选）

```bash
node scripts/dev-databases.mjs up mailhog
eval "$(node scripts/dev-databases.mjs env)"     # 导出 ACTOR_TEST_SMTP_URL
npm test                                          # 真服务用例这时才真的跑（否则输出里能看到 skipped）
```

## 明确不做（v1）

- DKIM/DMARC 签名（交给 SMTP 提供方）；
- 退信/投诉 webhook 处理；
- 限流/退避与重试队列（要"至少一次"就接 `@actor/data` 的 outbox —— 框架不在这里假装有保证）；
- 批量个性化（自己循环 + transport 即可）。
